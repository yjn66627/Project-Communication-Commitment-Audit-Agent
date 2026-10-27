import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import {
  applyReviewCommand,
  buildLocalReviewDTO,
  buildMappingPlan,
  buildRevisionMappingSnapshot,
  buildSafeReviewDiagnosticDTO,
  buildSanitizedPreview,
  createReviewSession,
  serializeRevisionMappingSnapshot,
  type ReviewSession,
} from "../src/privacy/index.js";
import type { CanonicalRecordDraft } from "../src/domain/schemas/canonical.js";
import type { PrivacyEntityType, ResolvedPrivacyDetection, SourceNamePolicyResult } from "../src/privacy/detection/types.js";

const PRIORITY: Record<PrivacyEntityType, number> = { SECRET: 1000, ID_CARD: 900, URL: 800, EMAIL: 750, PHONE: 700, IP: 650, PERSON: 500, ORG: 500, PROJECT: 500 };

function rec(content: string, options: Partial<CanonicalRecordDraft> = {}): CanonicalRecordDraft {
  return { record_id: "rec_1", source_type: "PASTE", source_name: "safe.txt", author: null, timestamp: null, content, sequence: 0, metadata: {}, ...options } as CanonicalRecordDraft;
}
function d(id: string, type: PrivacyEntityType, start: number, end: number, surface: "CONTENT" | "AUTHOR" | "SOURCE_NAME" = "CONTENT", key: string | null = "key"): ResolvedPrivacyDetection {
  return { detection_id: id, record_id: "rec_1", surface, char_start: start, char_end: end, effective_start: start, effective_end: end, overlap_member_count: 1, entity_type: type, priority: PRIORITY[type], normalized_key: type === "SECRET" ? null : key, detector_id: `test.${id}`, detection_source: "DETERMINISTIC_RULE", confidence: "HIGH", review_state: type === "SECRET" ? "LOCKED_REDACTION" : "UNREVIEWED", replacement_policy: type === "SECRET" ? "LOCKED_REDACTION" : type === "URL" || type === "ID_CARD" ? "REDACT" : "PSEUDONYMIZE", ruleset_version: "privacy-detector-rules-v1" } as ResolvedPrivacyDetection;
}
function acceptAll(session: ReviewSession): ReviewSession {
  let current = session;
  for (const [id, decision] of Object.entries(current.decisions)) if (decision.state === "PENDING_REVIEW") current = applyReviewCommand(current, { type: "ACCEPT_DETECTION", detection_id: id });
  return current;
}
function finish(session: ReviewSession): ReviewSession { return applyReviewCommand(acceptAll(session), { type: "FINALIZE_REVIEW_CANDIDATE" }); }

// U04 + G05: Path Guard overrides URL restoration.
test("U04 G05 SAFE_LABEL_REQUIRED overrides restored URL/path text", () => {
  const rawSource = "C:\\Users\\Alice\\https://example.test\\log.txt";
  const start = rawSource.indexOf("https://");
  let session = createReviewSession({
    auditId: "aud_A",
    records: [rec("body", { source_name: rawSource })],
    detections: [d("u", "URL", start, start + "https://example.test".length, "SOURCE_NAME", "https://example.test")],
    sourceNamePolicies: { rec_1: { policy: "SAFE_LABEL_REQUIRED", reason_codes: ["PATH_SEPARATOR"] } as SourceNamePolicyResult },
  });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "u" });
  session = applyReviewCommand(session, { type: "SET_URL_VISIBILITY", detection_id: "u", visibility: "RESTORED" });
  session = applyReviewCommand(session, { type: "FINALIZE_REVIEW_CANDIDATE" });
  const preview = buildSanitizedPreview(session).preview_records[0]!;
  assert.match(preview.sanitized_source_name, /^SOURCE_[0-9A-F]{12}$/u);
  assert.ok(!preview.sanitized_source_name.includes("Users"));
});

// X01: right-to-left replacement avoids offset drift.
test("X01 multiple non-overlap replacements are applied right-to-left", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [rec("Alice met Bob")], detections: [d("a", "PERSON", 0, 5, "CONTENT", "alice"), d("b", "PERSON", 10, 13, "CONTENT", "bob")] });
  session = finish(session);
  assert.equal(buildSanitizedPreview(session).preview_records[0]?.sanitized_content, "PERSON_001 met PERSON_002");
});

// X02: only resolved effective envelope is applied once.
test("X02 effective envelope is replaced exactly once", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [rec("Alice")], detections: [{ ...d("a", "PERSON", 1, 4, "CONTENT", "lic"), effective_start: 0, effective_end: 5, overlap_member_count: 2 }] });
  session = finish(session);
  assert.equal(buildSanitizedPreview(session).preview_records[0]?.sanitized_content, "PERSON_001");
});

// X03: UTF-16 raw envelope works around emoji.
test("X03 UTF-16 envelope replacement remains exact around emoji", () => {
  const raw = "😀Alice😀";
  let session = createReviewSession({ auditId: "aud_A", records: [rec(raw)], detections: [d("a", "PERSON", 2, 7, "CONTENT", "alice")] });
  session = finish(session);
  assert.equal(buildSanitizedPreview(session).preview_records[0]?.sanitized_content, "😀PERSON_001😀");
});

// X04-X05: author/source_name sanitized independently.
test("X04 X05 author and simple source_name are sanitized independently", () => {
  const source = "Alice.txt";
  let session = createReviewSession({ auditId: "aud_A", records: [rec("body", { author: "Alice", source_name: source })], detections: [d("a1", "PERSON", 0, 5, "AUTHOR", "alice"), d("a2", "PERSON", 0, 5, "SOURCE_NAME", "alice")], sourceNamePolicies: { rec_1: { policy: "SAFE_SIMPLE_LABEL", reason_codes: ["PRIVACY_SPAN"] } as SourceNamePolicyResult } });
  session = finish(session);
  const preview = buildSanitizedPreview(session).preview_records[0]!;
  assert.equal(preview.sanitized_author, "PERSON_001");
  assert.equal(preview.sanitized_source_name, "PERSON_002.txt");
  assert.equal(preview.sanitized_content, "body");
});

// M01-M04 + G01 + G09: snapshot deterministic, ordered, exact fields, runtime ID excluded, stable serialization.
test("M01 M02 M03 M04 G01 G09 mapping snapshot is exact and canonically deterministic", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [rec("Alice Bob")], detections: [d("b", "PERSON", 6, 9, "CONTENT", "bob"), d("a", "PERSON", 0, 5, "CONTENT", "alice")] });
  session = finish(session);
  const plan = buildMappingPlan(session);
  const snapshotA = buildRevisionMappingSnapshot(plan);
  const snapshotB = buildRevisionMappingSnapshot(plan);
  assert.deepEqual(snapshotA, snapshotB);
  assert.equal(serializeRevisionMappingSnapshot(snapshotA), serializeRevisionMappingSnapshot(snapshotB));
  for (const item of snapshotA) assert.deepEqual(Object.keys(item).sort(), ["active", "aliases", "entity_type", "normalized_original_value", "placeholder"].sort());
  assert.ok(!JSON.stringify(snapshotA).includes("semantic_entity_id"));
  assert.deepEqual(snapshotA.map((x) => x.placeholder), [...snapshotA].sort((a, b) => a.entity_type.localeCompare(b.entity_type) || a.placeholder.localeCompare(b.placeholder)).map((x) => x.placeholder));
});

// M05 + G02: SECRET excluded from snapshot.
test("M05 G02 SECRET never enters mapping snapshot", () => {
  const session = applyReviewCommand(createReviewSession({ auditId: "aud_A", records: [rec("secret")], detections: [d("s", "SECRET", 0, 6)] }), { type: "FINALIZE_REVIEW_CANDIDATE" });
  assert.deepEqual(buildRevisionMappingSnapshot(buildMappingPlan(session)), []);
});

// M06 + G03: inactive history stays in snapshot and remains reserved.
test("M06 G03 inactive historical mapping remains in snapshot and reserved", () => {
  const seed = { audit_id: "aud_A", entity_type: "PERSON" as const, placeholder: "PERSON_001", original_value: "Old", normalized_key: "old", aliases: [], active: false, seed_revision_id: "prv_old" };
  let session = createReviewSession({ auditId: "aud_A", records: [rec("New")], detections: [d("n", "PERSON", 0, 3, "CONTENT", "new")], seedMappings: [seed] });
  session = finish(session);
  const plan = buildMappingPlan(session);
  assert.ok(plan.mappings.some((m) => m.placeholder === "PERSON_001" && !m.active));
  assert.ok(plan.mappings.some((m) => m.placeholder === "PERSON_002" && m.active));
});

// M07: placeholder change keeps old placeholder inactive and new active.
test("M07 placeholder change reserves old mapping and activates new placeholder", () => {
  const seed = { audit_id: "aud_A", entity_type: "PERSON" as const, placeholder: "PERSON_001", original_value: "Alice", normalized_key: "alice", aliases: [], active: true, seed_revision_id: "prv_old" };
  let session = createReviewSession({ auditId: "aud_A", records: [rec("Alice")], detections: [d("a", "PERSON", 0, 5, "CONTENT", "alice")], seedMappings: [seed] });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "a", seed_placeholder: "PERSON_001" });
  session = applyReviewCommand(session, { type: "SET_PLACEHOLDER", semantic_entity_id: session.decisions.a!.semantic_entity_id!, placeholder: "PERSON_009" });
  session = applyReviewCommand(session, { type: "FINALIZE_REVIEW_CANDIDATE" });
  const mappings = buildMappingPlan(session).mappings;
  assert.ok(mappings.some((m) => m.placeholder === "PERSON_001" && !m.active));
  assert.ok(mappings.some((m) => m.placeholder === "PERSON_009" && m.active));
});

// M08: same normalized key can exist under distinct placeholders.
test("M08 same normalized key may remain distinct mappings", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [rec("Alex Alex")], detections: [d("a", "PERSON", 0, 4, "CONTENT", "alex"), d("b", "PERSON", 5, 9, "CONTENT", "alex")] });
  session = finish(session);
  const active = buildMappingPlan(session).mappings.filter((m) => m.active);
  assert.equal(active.length, 2);
  assert.equal(new Set(active.map((m) => m.normalized_key)).size, 1);
  assert.equal(new Set(active.map((m) => m.placeholder)).size, 2);
});

// V01-V04: preview contract separates surfaces, has no revision IDs/vault/raw metadata.
test("V01 V02 V03 V04 sanitized preview contract contains only safe pre-revision fields", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [rec("Alice", { author: "Alice", metadata: { raw: "do-not-copy" } as never })], detections: [d("c", "PERSON", 0, 5, "CONTENT", "alice"), d("a", "PERSON", 0, 5, "AUTHOR", "alice")] });
  session = finish(session);
  const preview = buildSanitizedPreview(session).preview_records[0]! as unknown as Record<string, unknown>;
  assert.ok("sanitized_content" in preview && "sanitized_author" in preview && "sanitized_source_name" in preview);
  for (const forbidden of ["privacy_revision_id", "record_revision_id", "original_value", "mapping_plan", "revision_salt", "metadata"]) assert.ok(!(forbidden in preview));
});

// V05-V06 + G06: LocalReviewDTO and SafeDiagnosticDTO are deliberately separated.
test("V05 V06 G06 local review may expose local raw while safe diagnostic does not", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [rec("Alice")], detections: [d("a", "PERSON", 0, 5, "CONTENT", "alice")] });
  const local = buildLocalReviewDTO(session);
  assert.equal(local.detections[0]?.raw_value, "Alice");
  session = finish(session);
  const plan = buildMappingPlan(session);
  const safe = buildSafeReviewDiagnosticDTO({ session, mappingPlan: plan, durationMs: 5 });
  const serialized = JSON.stringify(safe);
  assert.ok(!serialized.includes("Alice"));
  for (const forbidden of ["original_value", "normalized_key", "raw_value", "preview", "source_name", "aliases"]) assert.ok(!serialized.includes(forbidden));
});

// O01: diagnostics are aggregate-only.
test("O01 safe observability exposes only aggregate review metrics", () => {
  const session = finish(createReviewSession({ auditId: "aud_A", records: [rec("Alice")], detections: [d("a", "PERSON", 0, 5, "CONTENT", "alice")] }));
  const safe = buildSafeReviewDiagnosticDTO({ session, mappingPlan: buildMappingPlan(session), durationMs: 1, safeErrorCategory: null });
  assert.equal(safe.stage, "REVIEW_COMPLETE");
  assert.equal(safe.entity_type_counts.PERSON, 1);
  assert.equal(safe.placeholder_count_by_type.PERSON, 1);
});

// B01-B06 + G07-G08: static boundary stays local, no persistence/revision-id/egress/remote/frozen-layer imports.
test("B01 B02 B03 B04 B05 B06 G07 G08 static source boundary is CP2-only", () => {
  const root = path.resolve(process.cwd(), "src/privacy");
  const cp2Dirs = ["pseudonymization", "review", "preview"];
  const source = cp2Dirs.flatMap((dir) => fs.readdirSync(path.join(root, dir)).filter((name) => name.endsWith(".ts")).map((name) => fs.readFileSync(path.join(root, dir, name), "utf8"))).join("\n");
  const forbidden = ["src/db", "drizzle", "PrivacyRepository", "fetch(", "LangGraph", "DeepSeek", "OpenAI", "generatePrivacyRevisionId(", "generateRecordRevisionId(", "ALLOW", "Safe Provider Payload"];
  for (const token of forbidden) assert.ok(!source.includes(token), token);
});

// G04 is covered behaviorally here with the same dual historical merge fail-closed contract.
test("G04 dual historical seed merge without explicit survivor fails closed", async () => {
  const seeds = [
    { audit_id: "aud_A", entity_type: "PERSON" as const, placeholder: "PERSON_001", original_value: "A", normalized_key: "a", aliases: [], active: true, seed_revision_id: "r1" },
    { audit_id: "aud_A", entity_type: "PERSON" as const, placeholder: "PERSON_004", original_value: "B", normalized_key: "b", aliases: [], active: true, seed_revision_id: "r1" },
  ];
  let session = createReviewSession({ auditId: "aud_A", records: [rec("A B")], detections: [d("a", "PERSON", 0, 1, "CONTENT", "a"), d("b", "PERSON", 2, 3, "CONTENT", "b")], seedMappings: seeds });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "a", seed_placeholder: "PERSON_001" });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "b", seed_placeholder: "PERSON_004" });
  assert.throws(() => applyReviewCommand(session, { type: "MERGE_ENTITIES", semantic_entity_ids: [session.decisions.a!.semantic_entity_id!, session.decisions.b!.semantic_entity_id!] }), /explicit survivor/i);
});

// G10: raw value absent from safe diagnostic and safe error.
test("G10 raw values never appear in safe diagnostic or review error text", () => {
  const raw = "LOCAL-PII-ONLY";
  const session = createReviewSession({ auditId: "aud_A", records: [rec(raw)], detections: [d("a", "PERSON", 0, raw.length, "CONTENT", "normalized") ] });
  assert.ok(!JSON.stringify(buildSafeReviewDiagnosticDTO({ session })).includes(raw));
  try {
    applyReviewCommand(session, { type: "SET_REPLACEMENT_POLICY", detection_id: "missing", policy: "REDACT" });
    assert.fail("expected error");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(raw));
  }
});
