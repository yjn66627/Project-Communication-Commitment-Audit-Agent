import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { bootstrapApplicationStore, type ApplicationStore } from "../src/application/storage/application-store.js";
import { resolveApplicationDataDirectory } from "../src/application/storage/data-directory.js";
import { createPasteDraft, MAX_PASTE_BYTES } from "../src/application/input/paste-adapter.js";
import { REVIEW_MEMORY_LIMITS } from "../src/application/privacy/privacy-review-service.js";
import { CanonicalRecordDraftSchema } from "../src/domain/schemas/canonical.js";
import { ApplicationError } from "../src/application/errors.js";
import { selectLatestApplicableConfirmedRevision } from "../src/privacy/revision/latest-confirmed.js";

async function fixture(operation: (context: { store: ApplicationStore; database: string; reopen: () => Promise<ApplicationStore> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "dev06-c1-privacy-")); const config = { environment: { LOCALAPPDATA: root } }; const stores: ApplicationStore[] = [];
  const reopen = async () => { const store = await bootstrapApplicationStore(config); stores.push(store); return store; };
  try { await operation({ store: await reopen(), database: path.join(resolveApplicationDataDirectory(config.environment), "audit.sqlite"), reopen }); }
  finally { for (const store of stores) await store.close(); assert.equal(path.dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
}

function acceptAll(store: ApplicationStore, auditId: string): void {
  for (const decision of Object.values(store.reviews.getSessionLocal(auditId).decisions)) {
    if (decision.state === "PENDING_REVIEW") store.reviews.apply(auditId, { type: "ACCEPT_DETECTION", detection_id: decision.detection_id });
  }
}

test("C1-13 Paste accepts long contiguous Chinese/JSON text within the byte limit and rejects oversized or extra fields", () => {
  const a = createPasteDraft({ text: "Synthetic local draft" }); const b = createPasteDraft({ text: "Synthetic local draft" });
  assert.ok(CanonicalRecordDraftSchema.safeParse(a).success); assert.equal(a.source_type, "PASTE"); assert.notEqual(a.record_id, b.record_id);
  const longChinese = "这是一个连续中文段落，用于验证长篇文本不会因为连续字符长度而被错误拒绝。".repeat(80);
  const longJson = `{"kind":"audit-log","payload":"${"x".repeat(4096)}"}`;
  assert.ok(longChinese.length > 1024); assert.equal(/\s/u.test(longChinese), false);
  assert.ok(longJson.length > 1024); assert.equal(/\s/u.test(longJson), false); assert.equal(JSON.parse(longJson).kind, "audit-log");
  assert.ok(Buffer.byteLength(longChinese, "utf8") <= MAX_PASTE_BYTES);
  assert.ok(Buffer.byteLength(longJson, "utf8") <= MAX_PASTE_BYTES);
  assert.equal(createPasteDraft({ text: longChinese }).content, longChinese);
  assert.equal(createPasteDraft({ text: longJson }).content, longJson);
  assert.throws(() => createPasteDraft({ text: "x".repeat(MAX_PASTE_BYTES + 1) }));
  const overByteLimitChinese = "字".repeat(Math.floor(MAX_PASTE_BYTES / Buffer.byteLength("字", "utf8")) + 1);
  assert.ok(Buffer.byteLength(overByteLimitChinese, "utf8") > MAX_PASTE_BYTES);
  assert.throws(() => createPasteDraft({ text: overByteLimitChinese }));
  assert.ok(createPasteDraft({ text: "x ".repeat(MAX_PASTE_BYTES / 2) }));
  assert.throws(() => createPasteDraft({ text: "input", databasePath: "client-controlled" }));
});

test("C1-19 browser-like runtime is denied before any storage path is resolved", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  try {
    assert.throws(() => createPasteDraft({ text: "Synthetic input" }), (error: unknown) => error instanceof ApplicationError && error.code === "SERVER_ONLY");
    await assert.rejects(bootstrapApplicationStore(), (error: unknown) => error instanceof ApplicationError && error.code === "SERVER_ONLY");
  } finally { if (descriptor) Object.defineProperty(globalThis, "window", descriptor); else Reflect.deleteProperty(globalThis, "window"); }
});

test("C1-13 C1-14 raw draft persistence and provider/network egress are zero before confirmation", async () => fixture(async ({ store, database }) => {
  const audit = store.audits.create({ displayName: "Privacy fixture" });
  const raw = "Contact fixture.person@example.invalid for the synthetic delivery.";
  const originalFetch = globalThis.fetch; let networkCalls = 0;
  globalThis.fetch = (() => { networkCalls += 1; throw new Error("network forbidden in C1 fixture"); }) as typeof fetch;
  try {
    store.reviews.beginPaste(audit.auditId, { text: raw }); acceptAll(store, audit.auditId); store.reviews.finalize(audit.auditId);
    const db = new Database(database);
    try {
      for (const table of ["privacy_revisions", "canonical_records", "privacy_mappings", "provider_calls"]) assert.equal((db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n, 0);
    } finally { db.close(); }
    assert.equal(readFileSync(database).includes(Buffer.from(raw)), false); assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = originalFetch; }
}));

test("C1-15 Review session count and input/aggregate byte budgets fail closed", async () => fixture(async ({ store }) => {
  const audits = Array.from({ length: REVIEW_MEMORY_LIMITS.sessions + 1 }, (_, i) => store.audits.create({ displayName: `Bounded ${i}` }));
  for (const audit of audits.slice(0, -1)) store.reviews.beginPaste(audit.auditId, { text: "Synthetic bounded draft" });
  assert.throws(() => store.reviews.beginPaste(audits.at(-1)!.auditId, { text: "Synthetic draft" }), (e: unknown) => e instanceof ApplicationError && e.code === "REVIEW_MEMORY_LIMIT");
  assert.equal(store.reviews.memoryUsage.sessions, REVIEW_MEMORY_LIMITS.sessions);
  assert.ok(store.reviews.memoryUsage.bytes <= REVIEW_MEMORY_LIMITS.totalBytes);
  store.reviews.discard(audits[0]!.auditId); store.reviews.beginPaste(audits.at(-1)!.auditId, { text: "Synthetic draft" });
  await store.close(); assert.equal(store.reviews.memoryUsage.sessions, 0); assert.equal(store.reviews.memoryUsage.bytes, 0);
}));

test("C1-15 frozen merge/split commands and mapping/preview builder remain wired", async () => fixture(async ({ store }) => {
  const audit = store.audits.create({ displayName: "Merge split fixture" });
  store.reviews.beginPaste(audit.auditId, { text: "first@example.invalid and second@example.invalid" }); acceptAll(store, audit.auditId);
  const before = store.reviews.getSessionLocal(audit.auditId); const entities = Object.values(before.entities);
  assert.equal(entities.length, 2);
  store.reviews.apply(audit.auditId, { type: "MERGE_ENTITIES", semantic_entity_ids: entities.map((e) => e.semantic_entity_id) });
  const merged = Object.values(store.reviews.getSessionLocal(audit.auditId).entities).find((e) => e.state !== "MERGED_INTO")!;
  const originalSurvivor = entities.find((e) => e.semantic_entity_id === merged.semantic_entity_id)!;
  const retainedIndex = merged.member_detection_ids.findIndex((id) => originalSurvivor.member_detection_ids.includes(id));
  store.reviews.apply(audit.auditId, { type: "SPLIT_ENTITY", semantic_entity_id: merged.semantic_entity_id, partitions: merged.member_detection_ids.map((id) => [id]), retained_partition_index: retainedIndex });
  const preview = store.reviews.finalize(audit.auditId); assert.ok(preview.sanitizedRecords[0]?.sanitized_content.includes("EMAIL_"));
  const result = await store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: preview.reviewCandidateId }); assert.equal(result.mapping_count, 2);
}));

test("C1-15 amplified detection and combined finalized-review byte budgets are enforced", async () => fixture(async ({ store }) => {
  const noisy = store.audits.create({ displayName: "Detection bound fixture" });
  assert.throws(() => store.reviews.beginPaste(noisy.auditId, { text: "synthetic@example.invalid ".repeat(REVIEW_MEMORY_LIMITS.detections + 1) }), (error: unknown) => error instanceof ApplicationError && error.code === "REVIEW_MEMORY_LIMIT");
  assert.equal(store.reviews.memoryUsage.sessions, 0);
  let reachedByteBound = false;
  for (let i = 0; i < REVIEW_MEMORY_LIMITS.sessions; i += 1) {
    const audit = store.audits.create({ displayName: `Large bounded fixture ${i}` });
    try { store.reviews.beginPaste(audit.auditId, { text: "x ".repeat(MAX_PASTE_BYTES / 2) }); store.reviews.finalize(audit.auditId); }
    catch (error: unknown) { assert.ok(error instanceof ApplicationError && error.code === "REVIEW_MEMORY_LIMIT"); reachedByteBound = true; break; }
  }
  assert.equal(reachedByteBound, true); assert.ok(store.reviews.memoryUsage.bytes <= REVIEW_MEMORY_LIMITS.totalBytes);
}));

test("C1-15 review false-positive/policy/placeholder commands and persisted seed reuse stay local", async () => fixture(async ({ store }) => {
  const audit = store.audits.create({ displayName: "Review commands fixture" });
  store.reviews.beginPaste(audit.auditId, { text: "synthetic@example.invalid" });
  let session = store.reviews.getSessionLocal(audit.auditId); const detectionId = Object.keys(session.decisions)[0]!; const entityId = Object.keys(session.entities)[0]!;
  store.reviews.apply(audit.auditId, { type: "MARK_FALSE_POSITIVE", detection_id: detectionId });
  store.reviews.apply(audit.auditId, { type: "ACCEPT_DETECTION", detection_id: detectionId });
  store.reviews.apply(audit.auditId, { type: "SET_REPLACEMENT_POLICY", detection_id: detectionId, policy: "PSEUDONYMIZE" });
  store.reviews.apply(audit.auditId, { type: "SET_PLACEHOLDER", semantic_entity_id: entityId, placeholder: "EMAIL_010" });
  let preview = store.reviews.finalize(audit.auditId);
  await store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: preview.reviewCandidateId });
  store.reviews.beginPaste(audit.auditId, { text: "synthetic@example.invalid in later revision" }); session = store.reviews.getSessionLocal(audit.auditId);
  assert.equal(session.seed_mappings[0]?.placeholder, "EMAIL_010");
  store.reviews.apply(audit.auditId, { type: "ACCEPT_DETECTION", detection_id: Object.keys(session.decisions)[0]!, seed_placeholder: "EMAIL_010" });
  preview = store.reviews.finalize(audit.auditId); assert.ok(preview.sanitizedRecords[0]?.sanitized_content.includes("EMAIL_010"));
  await store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: preview.reviewCandidateId });
  assert.equal(store.privacy.getLatestLocal(audit.auditId)?.mappings[0]?.original_value, "synthetic@example.invalid");
}));

test("C1-16 an in-flight confirmation pins review edits until commit", async () => fixture(async ({ store }) => {
  const audit = store.audits.create({ displayName: "Pinned review fixture" }); store.reviews.beginPaste(audit.auditId, { text: "Synthetic input" }); const preview = store.reviews.finalize(audit.auditId);
  const pending = store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: preview.reviewCandidateId });
  assert.throws(() => store.reviews.beginPaste(audit.auditId, { text: "changed input" }), (error: unknown) => error instanceof ApplicationError && error.code === "REVIEW_CONFIRMING");
  const result = await pending; assert.equal(store.privacy.getLatestSafe(audit.auditId)?.revision.privacy_revision_id, result.privacy_revision_id);
}));

test("C1-15 inherited split identity collision is denied without changing review or Frozen implementation", async () => fixture(async ({ store }) => {
  const audit = store.audits.create({ displayName: "Split boundary fixture" });
  store.reviews.beginPaste(audit.auditId, { text: "first@example.invalid and second@example.invalid" }); acceptAll(store, audit.auditId);
  const entities = Object.values(store.reviews.getSessionLocal(audit.auditId).entities);
  store.reviews.apply(audit.auditId, { type: "MERGE_ENTITIES", semantic_entity_ids: entities.map((e) => e.semantic_entity_id) });
  const before = store.reviews.getSessionLocal(audit.auditId);
  const merged = Object.values(before.entities).find((e) => e.state !== "MERGED_INTO")!;
  const original = entities.find((e) => e.semantic_entity_id === merged.semantic_entity_id)!;
  const conflictingRetained = merged.member_detection_ids.findIndex((id) => !original.member_detection_ids.includes(id));
  assert.throws(() => store.reviews.apply(audit.auditId, { type: "SPLIT_ENTITY", semantic_entity_id: merged.semantic_entity_id, partitions: merged.member_detection_ids.map((id) => [id]), retained_partition_index: conflictingRetained }), (error: unknown) => error instanceof ApplicationError && error.code === "REVIEW_INTEGRITY_ERROR");
  assert.equal(store.reviews.getSessionLocal(audit.auditId), before);
}));

test("C1-16 C1-17 C1-18 confirmation persists only frozen allowed aggregate and survives reopen", async () => fixture(async ({ store, database, reopen }) => {
  const audit = store.audits.create({ displayName: "Confirmed fixture" }); const raw = "Contact fixture.person@example.invalid for the synthetic delivery.";
  store.reviews.beginPaste(audit.auditId, { text: raw }); acceptAll(store, audit.auditId); const preview = store.reviews.finalize(audit.auditId);
  assert.equal(store.privacy.getLatestSafe(audit.auditId), undefined);
  const result = await store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: preview.reviewCandidateId });
  assert.deepEqual(Object.keys(result).sort(), ["audit_id", "privacy_revision_id", "record_count", "mapping_count", "confirmed_at", "idempotent"].sort());
  const safe = store.privacy.getLatestSafe(audit.auditId)!; const local = store.privacy.getLatestLocal(audit.auditId)!;
  assert.equal(safe.revision.privacy_revision_id, result.privacy_revision_id); assert.equal(local.mappings.length, 1);
  assert.equal(safe.records[0]?.sanitized_content.includes("fixture.person@example.invalid"), false);
  assert.equal(Object.hasOwn(safe, "mappings"), false); assert.equal(JSON.stringify(safe).includes("original_value"), false);
  assert.equal(local.mappings[0]?.original_value, "fixture.person@example.invalid");
  assert.equal(store.reviews.memoryUsage.sessions, 0); assert.equal(readFileSync(database).includes(Buffer.from(raw)), false);
  const db = new Database(database);
  try {
    assert.equal((db.prepare("SELECT count(*) AS n FROM provider_calls").get() as { n: number }).n, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM canonical_records").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM privacy_revisions").get() as { n: number }).n, 1);
  } finally { db.close(); }
  await store.close(); const next = await reopen(); assert.deepEqual(next.privacy.getLatestSafe(audit.auditId), safe); assert.deepEqual(next.privacy.getLatestLocal(audit.auditId), local);
}));

test("C1-18 latest confirmed read delegates timestamp/id tie-break and separates safe/local", async () => fixture(async ({ store, database }) => {
  const audit = store.audits.create({ displayName: "Latest fixture" }); const results = [];
  for (const text of ["Synthetic first revision", "Synthetic second revision"]) {
    store.reviews.beginPaste(audit.auditId, { text }); const candidate = store.reviews.finalize(audit.auditId);
    results.push(await store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: candidate.reviewCandidateId }));
  }
  const db = new Database(database);
  try { db.prepare("UPDATE privacy_revisions SET confirmed_at=? WHERE privacy_revision_id=?").run("2026-09-20T00:00:00.000Z", results[0]!.privacy_revision_id); }
  finally { db.close(); }
  assert.equal(store.privacy.getLatestSafe(audit.auditId)?.revision.privacy_revision_id, results[1]!.privacy_revision_id);
  const latest = selectLatestApplicableConfirmedRevision(audit.auditId, results.map((r) => ({ ...r, confirmed_at: "2026-09-20T00:00:00.000Z" })));
  const tie = new Database(database); try { tie.prepare("UPDATE privacy_revisions SET confirmed_at=?").run("2026-09-20T00:00:00.000Z"); } finally { tie.close(); }
  assert.equal(store.privacy.getLatestLocal(audit.auditId)?.revision.privacy_revision_id, latest?.privacy_revision_id);
}));

test("C1-16 stale/edited candidate and unresolved review cannot confirm", async () => fixture(async ({ store, database }) => {
  const audit = store.audits.create({ displayName: "Freshness fixture" }); store.reviews.beginPaste(audit.auditId, { text: "Synthetic original" });
  const old = store.reviews.finalize(audit.auditId); store.reviews.beginPaste(audit.auditId, { text: "Synthetic changed" });
  await assert.rejects(store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: old.reviewCandidateId }));
  store.reviews.beginPaste(audit.auditId, { text: "pending@example.invalid" }); assert.throws(() => store.reviews.finalize(audit.auditId));
  const db = new Database(database); try { assert.equal((db.prepare("SELECT count(*) AS n FROM privacy_revisions").get() as { n: number }).n, 0); } finally { db.close(); }
}));

test("C1-11 C1-12 confirmation re-reads strict local salt; corrupt/empty salt never repaired", async () => fixture(async ({ store, database }) => {
  const audit = store.audits.create({ displayName: "Confirmation salt fixture" }); store.reviews.beginPaste(audit.auditId, { text: "Synthetic draft" }); const candidate = store.reviews.finalize(audit.auditId);
  const db = new Database(database);
  try {
    for (const salt of ["", "broken-salt"]) {
      db.prepare("UPDATE audits SET revision_salt=? WHERE audit_id=?").run(salt, audit.auditId);
      await assert.rejects(store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: candidate.reviewCandidateId }));
      assert.equal((db.prepare("SELECT revision_salt FROM audits").get() as { revision_salt: string }).revision_salt, salt);
      assert.equal((db.prepare("SELECT count(*) AS n FROM privacy_revisions").get() as { n: number }).n, 0);
    }
  } finally { db.close(); }
}));

test("C1-15 safe close invalidates pending confirmation and clears all unconfirmed raw state", async () => fixture(async ({ store, database, reopen }) => {
  const audit = store.audits.create({ displayName: "Close fixture" }); store.reviews.beginPaste(audit.auditId, { text: "Synthetic unconfirmed draft" }); const candidate = store.reviews.finalize(audit.auditId);
  const pending = store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: candidate.reviewCandidateId }); const closing = store.close();
  await assert.rejects(pending); await closing; assert.equal(store.reviews.memoryUsage.sessions, 0);
  assert.throws(() => store.audits.list()); const next = await reopen(); assert.equal(next.privacy.getLatestSafe(audit.auditId), undefined);
  const db = new Database(database); try { assert.equal((db.prepare("SELECT count(*) AS n FROM privacy_revisions").get() as { n: number }).n, 0); } finally { db.close(); }
}));

test("C1-14 static application closure has no provider imports, outbound APIs or raw persistence adapter", () => {
  const root = path.resolve("src/application");
  const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(directory, e.name)) : [path.join(directory, e.name)]);
  const source = walk(root).filter((file) => file.endsWith(".ts")).map((file) => readFileSync(file, "utf8")).join("\n");
  for (const forbidden of ["fetch(", "axios", "node:http", "node:https", "/providers/", "console.log(", "console.error("]) assert.equal(source.includes(forbidden), false, forbidden);
  const paste = readFileSync(path.join(root, "input/paste-adapter.ts"), "utf8");
  for (const forbidden of ["drizzle", "sqlite", "Repository"]) assert.equal(paste.includes(forbidden), false, forbidden);
});
