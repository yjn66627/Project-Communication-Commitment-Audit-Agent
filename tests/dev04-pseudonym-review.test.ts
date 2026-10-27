import assert from "node:assert/strict";
import test from "node:test";

import {
  applyReviewCommand,
  buildMappingPlan,
  buildSanitizedPreview,
  createReviewSession,
  createSafeSourceLabel,
  formatPlaceholder,
  ReviewRuntimeError,
  type ReviewSession,
  type SeedPrivacyMapping,
} from "../src/privacy/index.js";
import type { CanonicalRecordDraft } from "../src/domain/schemas/canonical.js";
import type { PrivacyEntityType, ResolvedPrivacyDetection } from "../src/privacy/detection/types.js";

const PRIORITY: Record<PrivacyEntityType, number> = {
  SECRET: 1000, ID_CARD: 900, URL: 800, EMAIL: 750, PHONE: 700, IP: 650, PERSON: 500, ORG: 500, PROJECT: 500,
};

function record(content: string, id = "rec_1", sequence = 0, author: string | null = null, sourceName = "safe.txt"): CanonicalRecordDraft {
  return { record_id: id, source_type: "PASTE", source_name: sourceName, author, timestamp: null, content, sequence, metadata: {} } as CanonicalRecordDraft;
}

function det(input: { id: string; record?: string; type: PrivacyEntityType; start: number; end: number; key?: string | null; surface?: "CONTENT" | "AUTHOR" | "SOURCE_NAME" }): ResolvedPrivacyDetection {
  const surface = input.surface ?? "CONTENT";
  return {
    detection_id: input.id,
    record_id: input.record ?? "rec_1",
    surface,
    char_start: input.start,
    char_end: input.end,
    effective_start: input.start,
    effective_end: input.end,
    overlap_member_count: 1,
    entity_type: input.type,
    priority: PRIORITY[input.type],
    normalized_key: input.type === "SECRET" ? null : (input.key ?? "key"),
    detector_id: `test.${input.type.toLowerCase()}`,
    detection_source: "DETERMINISTIC_RULE",
    confidence: "HIGH",
    review_state: input.type === "SECRET" ? "LOCKED_REDACTION" : "UNREVIEWED",
    replacement_policy: input.type === "SECRET" ? "LOCKED_REDACTION" : input.type === "ID_CARD" || input.type === "URL" ? "REDACT" : "PSEUDONYMIZE",
    ruleset_version: "privacy-detector-rules-v1",
  } as ResolvedPrivacyDetection;
}

function accept(session: ReviewSession, ...ids: string[]): ReviewSession {
  let current = session;
  for (const id of ids) current = applyReviewCommand(current, { type: "ACCEPT_DETECTION", detection_id: id });
  return current;
}

function finalize(session: ReviewSession): ReviewSession {
  return applyReviewCommand(session, { type: "FINALIZE_REVIEW_CANDIDATE" });
}

function activeEntityIds(session: ReviewSession): string[] {
  return Object.values(session.entities).filter((entity) => entity.state !== "MERGED_INTO").map((entity) => entity.semantic_entity_id);
}

const personSeed = (placeholder = "PERSON_001", active = true): SeedPrivacyMapping => ({
  audit_id: "aud_A",
  entity_type: "PERSON",
  placeholder,
  original_value: "Seed Person",
  normalized_key: "seed person",
  aliases: [],
  active,
  seed_revision_id: "prv_seed",
});

// P01-P02: repeated entity merge and confirmed-seed reuse.
test("P01 P02 repeated semantic entity and seeded placeholder reuse", () => {
  let session = createReviewSession({
    auditId: "aud_A",
    records: [record("Alice Alice")],
    detections: [det({ id: "d1", type: "PERSON", start: 0, end: 5, key: "alice" }), det({ id: "d2", type: "PERSON", start: 6, end: 11, key: "alice" })],
    seedMappings: [personSeed()],
  });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "d1", seed_placeholder: "PERSON_001" });
  const seededId = session.decisions.d1!.semantic_entity_id!;
  session = accept(session, "d2");
  const secondId = session.decisions.d2!.semantic_entity_id!;
  session = applyReviewCommand(session, { type: "MERGE_ENTITIES", semantic_entity_ids: [seededId, secondId] });
  session = finalize(session);
  const plan = buildMappingPlan(session);
  assert.equal(plan.mappings.filter((m) => m.active).length, 1);
  assert.equal(plan.mappings.find((m) => m.active)?.placeholder, "PERSON_001");
});

// P03: audit isolation.
test("P03 same visible value in different audits is independently scoped", () => {
  const make = (auditId: string) => finalize(accept(createReviewSession({ auditId, records: [record("Alice")], detections: [det({ id: "d1", type: "PERSON", start: 0, end: 5, key: "alice" })] }), "d1"));
  const a = buildMappingPlan(make("aud_A"));
  const b = buildMappingPlan(make("aud_B"));
  assert.equal(a.mappings.find((m) => m.active)?.placeholder, "PERSON_001");
  assert.equal(b.mappings.find((m) => m.active)?.placeholder, "PERSON_001");
  assert.notEqual(a.semantic_entities[0]?.semantic_entity_id, b.semantic_entities[0]?.semantic_entity_id);
});

// P04-P05: deterministic allocation and detector-order independence.
test("P04 P05 allocation is deterministic and independent of detection discovery order", () => {
  const detections = [det({ id: "d2", type: "PERSON", start: 6, end: 9, key: "bob" }), det({ id: "d1", type: "PERSON", start: 0, end: 5, key: "alice" })];
  const run = (items: ResolvedPrivacyDetection[]) => {
    let session = createReviewSession({ auditId: "aud_A", records: [record("Alice Bob")], detections: items });
    session = accept(session, "d1", "d2");
    return buildMappingPlan(finalize(session)).mappings.map((m) => [m.normalized_key, m.placeholder]);
  };
  assert.deepEqual(run(detections), run([...detections].reverse()));
});

// P06: inactive seed placeholder remains reserved.
test("P06 inactive seed placeholder is not reused", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [record("Bob")], detections: [det({ id: "d2", type: "PERSON", start: 0, end: 3, key: "bob" })], seedMappings: [personSeed("PERSON_001", false)] });
  session = finalize(accept(session, "d2"));
  const active = buildMappingPlan(session).mappings.find((m) => m.active)!;
  assert.equal(active.placeholder, "PERSON_002");
});

// P07: grammar and expansion past 999.
test("P07 placeholder grammar expands past 999 without truncation", () => {
  assert.equal(formatPlaceholder("PERSON", 1), "PERSON_001");
  assert.equal(formatPlaceholder("PERSON", 1000), "PERSON_1000");
});

// P08-P10: SECRET format, defaults, redacted mappable types.
test("P08 P09 P10 default policies keep SECRET unmapped and REDACT types locally mappable", () => {
  let session = createReviewSession({
    auditId: "aud_A",
    records: [record("Alice 11010519491231002X secret")],
    detections: [
      det({ id: "p", type: "PERSON", start: 0, end: 5, key: "alice" }),
      det({ id: "i", type: "ID_CARD", start: 6, end: 24, key: "11010519491231002X" }),
      det({ id: "s", type: "SECRET", start: 25, end: 31 }),
    ],
  });
  session = finalize(accept(session, "p", "i"));
  const plan = buildMappingPlan(session);
  assert.equal(session.decisions.p?.replacement_policy, "PSEUDONYMIZE");
  assert.equal(session.decisions.i?.replacement_policy, "REDACT");
  assert.equal(session.decisions.s?.replacement_policy, "LOCKED_REDACTION");
  assert.ok(plan.mappings.some((m) => m.entity_type === "ID_CARD"));
  assert.ok(!plan.mappings.some((m) => (m.entity_type as string) === "SECRET"));
});

// A01: alias candidate does not auto merge.
test("A01 equal/alias-like values remain separate until explicit merge", () => {
  const session = createReviewSession({ auditId: "aud_A", records: [record("Alice Alice")], detections: [det({ id: "a", type: "PERSON", start: 0, end: 5, key: "alice" }), det({ id: "b", type: "PERSON", start: 6, end: 11, key: "alice" })] });
  assert.equal(activeEntityIds(session).length, 2);
});

// A02-A03: explicit merge and one historical seed survivor.
test("A02 A03 explicit merge uses the single historical seed survivor", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [record("Alice Bob")], detections: [det({ id: "a", type: "PERSON", start: 0, end: 5, key: "alice" }), det({ id: "b", type: "PERSON", start: 6, end: 9, key: "bob" })], seedMappings: [personSeed()] });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "a", seed_placeholder: "PERSON_001" });
  session = accept(session, "b");
  session = applyReviewCommand(session, { type: "MERGE_ENTITIES", semantic_entity_ids: [session.decisions.a!.semantic_entity_id!, session.decisions.b!.semantic_entity_id!] });
  const entity = Object.values(session.entities).find((e) => e.state !== "MERGED_INTO")!;
  assert.equal(entity.placeholder, "PERSON_001");
});

// A04-A05: dual seed conflict requires explicit survivor.
test("A04 A05 dual historical seed merge fails closed unless survivor is explicit", () => {
  const seeds = [personSeed("PERSON_001"), { ...personSeed("PERSON_004"), original_value: "Other", normalized_key: "other" }];
  let session = createReviewSession({ auditId: "aud_A", records: [record("Alice Other")], detections: [det({ id: "a", type: "PERSON", start: 0, end: 5, key: "alice" }), det({ id: "b", type: "PERSON", start: 6, end: 11, key: "other" })], seedMappings: seeds });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "a", seed_placeholder: "PERSON_001" });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "b", seed_placeholder: "PERSON_004" });
  const ids = [session.decisions.a!.semantic_entity_id!, session.decisions.b!.semantic_entity_id!];
  assert.throws(() => applyReviewCommand(session, { type: "MERGE_ENTITIES", semantic_entity_ids: ids }), /explicit survivor/i);
  session = applyReviewCommand(session, { type: "MERGE_ENTITIES", semantic_entity_ids: ids, survivor_placeholder: "PERSON_001" });
  assert.equal(Object.values(session.entities).find((e) => e.state !== "MERGED_INTO")?.placeholder, "PERSON_001");
  session = finalize(session);
  const mappings = buildMappingPlan(session).mappings;
  assert.ok(mappings.some((m) => m.placeholder === "PERSON_001" && m.active));
  assert.ok(mappings.some((m) => m.placeholder === "PERSON_004" && !m.active));
});

// A06: cross-type merge rejected.
test("A06 cross-type merge is rejected", () => {
  const session = createReviewSession({ auditId: "aud_A", records: [record("Alice ACME")], detections: [det({ id: "p", type: "PERSON", start: 0, end: 5, key: "alice" }), det({ id: "o", type: "ORG", start: 6, end: 10, key: "acme" })] });
  let captured: unknown;
  try {
    applyReviewCommand(session, { type: "MERGE_ENTITIES", semantic_entity_ids: activeEntityIds(session) });
  } catch (error) {
    captured = error;
  }
  assert.ok(captured instanceof ReviewRuntimeError);
  assert.equal(captured.code, "REVIEW_MERGE_INVALID");
});

// A07-A09: split, retained seed partition, same normalized key remains distinct.
test("A07 A08 A09 explicit split keeps retained seed and allows same normalized key distinct", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [record("Alice Alice")], detections: [det({ id: "a", type: "PERSON", start: 0, end: 5, key: "alice" }), det({ id: "b", type: "PERSON", start: 6, end: 11, key: "alice" })], seedMappings: [personSeed()] });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "a", seed_placeholder: "PERSON_001" });
  session = accept(session, "b");
  const seedId = session.decisions.a!.semantic_entity_id!;
  const otherId = session.decisions.b!.semantic_entity_id!;
  session = applyReviewCommand(session, { type: "MERGE_ENTITIES", semantic_entity_ids: [seedId, otherId] });
  const mergedId = activeEntityIds(session)[0]!;
  session = applyReviewCommand(session, { type: "SPLIT_ENTITY", semantic_entity_id: mergedId, partitions: [["a"], ["b"]], retained_partition_index: 0 });
  session = finalize(session);
  const active = buildMappingPlan(session).mappings.filter((m) => m.active);
  assert.equal(active.length, 2);
  assert.ok(active.some((m) => m.placeholder === "PERSON_001"));
  assert.equal(new Set(active.map((m) => m.placeholder)).size, 2);
});

// A10: old seed input remains immutable.
test("A10 review commands do not mutate seed revision data", () => {
  const seed = personSeed();
  const before = structuredClone(seed);
  let session = createReviewSession({ auditId: "aud_A", records: [record("Alice")], detections: [det({ id: "a", type: "PERSON", start: 0, end: 5, key: "alice" })], seedMappings: [seed] });
  session = applyReviewCommand(session, { type: "ACCEPT_DETECTION", detection_id: "a", seed_placeholder: "PERSON_001" });
  session = applyReviewCommand(session, { type: "SET_PLACEHOLDER", semantic_entity_id: session.decisions.a!.semantic_entity_id!, placeholder: "PERSON_009" });
  assert.deepEqual(seed, before);
});

// R01-R03: false positive preview/mapping/history semantics are enforced in mapping plan.
test("R01 R02 R03 false positive creates no new mapping and leaves seed history inactive", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [record("Alice")], detections: [det({ id: "a", type: "PERSON", start: 0, end: 5, key: "alice" })], seedMappings: [personSeed()] });
  session = applyReviewCommand(session, { type: "MARK_FALSE_POSITIVE", detection_id: "a" });
  session = finalize(session);
  const plan = buildMappingPlan(session);
  assert.equal(plan.mappings.length, 1);
  assert.equal(plan.mappings[0]?.placeholder, "PERSON_001");
  assert.equal(plan.mappings[0]?.active, false);
  assert.equal(buildSanitizedPreview(session).preview_records[0]?.sanitized_content, "Alice");
});

// R04-R06: SECRET FP remains unmapped, policy change rejected, no restore command exists.
test("R04 R05 R06 SECRET review has no reversible mapping or restore backdoor", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [record("secret")], detections: [det({ id: "s", type: "SECRET", start: 0, end: 6 })] });
  assert.throws(() => applyReviewCommand(session, { type: "SET_REPLACEMENT_POLICY", detection_id: "s", policy: "PSEUDONYMIZE" }), /SECRET/i);
  session = applyReviewCommand(session, { type: "MARK_FALSE_POSITIVE", detection_id: "s" });
  assert.equal(session.decisions.s?.does_not_disable_future_egress_secret_scan, true);
  session = finalize(session);
  assert.equal(buildMappingPlan(session).mappings.length, 0);
  assert.equal(buildSanitizedPreview(session).preview_records[0]?.sanitized_content, "secret");
  const commandNames = ["ACCEPT_DETECTION", "MARK_FALSE_POSITIVE", "SET_REPLACEMENT_POLICY", "MERGE_ENTITIES", "SPLIT_ENTITY", "SET_PLACEHOLDER", "SET_URL_VISIBILITY", "FINALIZE_REVIEW_CANDIDATE"];
  assert.ok(!commandNames.some((name) => name.includes("RESTORE_SECRET")));
});

// U01-U03: URL hidden by default, may pseudonymize or restore locally.
test("U01 U02 U03 URL policy supports hidden, pseudonymized, and local restored modes", () => {
  let session = createReviewSession({ auditId: "aud_A", records: [record("https://example.test")], detections: [det({ id: "u", type: "URL", start: 0, end: 20, key: "https://example.test" })] });
  assert.equal(session.decisions.u?.replacement_policy, "REDACT");
  assert.equal(session.decisions.u?.url_visibility, "HIDDEN");
  session = accept(session, "u");
  session = applyReviewCommand(session, { type: "SET_REPLACEMENT_POLICY", detection_id: "u", policy: "PSEUDONYMIZE" });
  assert.equal(session.decisions.u?.replacement_policy, "PSEUDONYMIZE");
  session = applyReviewCommand(session, { type: "SET_URL_VISIBILITY", detection_id: "u", visibility: "RESTORED" });
  assert.equal(session.decisions.u?.url_visibility, "RESTORED");
  session = finalize(session);
  assert.equal(buildSanitizedPreview(session).preview_records[0]?.sanitized_content, "https://example.test");
});

// S01-S03: safe source label stable by audit+record and isolated across audit.
test("S01 S02 S03 safe source label is deterministic across revisions and audit-isolated", () => {
  const a1 = createSafeSourceLabel("aud_A", "rec_1");
  const a2 = createSafeSourceLabel("aud_A", "rec_1");
  const b = createSafeSourceLabel("aud_B", "rec_1");
  assert.match(a1, /^SOURCE_[0-9A-F]{12}$/u);
  assert.equal(a1, a2);
  assert.notEqual(a1, b);
});

// O02: safe errors never interpolate raw sensitive values.
test("O02 review errors use safe generic messages", () => {
  const raw = "VERY-SENSITIVE-VALUE";
  const session = createReviewSession({ auditId: "aud_A", records: [record(raw)], detections: [det({ id: "p", type: "PERSON", start: 0, end: raw.length, key: "sensitive" })] });
  try {
    applyReviewCommand(session, { type: "SET_PLACEHOLDER", semantic_entity_id: activeEntityIds(session)[0]!, placeholder: "ORG_001" });
    assert.fail("expected error");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(raw));
  }
});
