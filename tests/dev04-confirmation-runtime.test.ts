import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";

import { PersistenceError } from "../src/db/persistence-errors.js";
import {
  ConfirmationRuntimeError,
  PerAuditConfirmationLock,
  PrivacyConfirmationService,
  createCandidateFreshnessContext,
  finalizeReviewCandidate,
  type CandidateSemanticStateInput,
  type ConfirmationRepositoryPort,
  type FinalizedReviewCandidate,
} from "../src/privacy/revision/index.js";
import type { CanonicalRecordDraft, SanitizedCanonicalRecordRevision } from "../src/domain/schemas/canonical.js";
import type { ConfirmedPrivacyRevision, PrivacyMapping } from "../src/domain/schemas/privacy.js";
import type { SanitizedPreviewRecordCandidate } from "../src/privacy/preview/types.js";
import type { PseudonymMappingPlan } from "../src/privacy/pseudonymization/types.js";
import type { LocalConfirmedPrivacyAggregate, SafeConfirmedPrivacyAggregate } from "../src/db/repositories/privacy-repository.js";
import type { RepositoryWriteResult } from "../src/db/repositories/repository-utils.js";

const salt = new Uint8Array(32).fill(4);
function raw(audit = "aud_A", content = "Alpha"): CanonicalRecordDraft { void audit; return { record_id: "rec_1", source_type: "PASTE", source_name: "safe.txt", author: null, timestamp: null, content, sequence: 0, metadata: {} } as CanonicalRecordDraft; }
function preview(content = "Alpha"): SanitizedPreviewRecordCandidate { return { record_id: "rec_1", source_type: "PASTE", sanitized_source_name: "safe.txt", sanitized_author: null, timestamp: null, sanitized_content: content, sequence: 0 }; }
function plan(audit = "aud_A"): PseudonymMappingPlan { return { audit_id: audit, mappings: [], semantic_entities: [], reserved_placeholders: [] }; }
function state(audit = "aud_A", content = "Alpha"): CandidateSemanticStateInput { return { audit_id: audit, raw_records: [raw(audit, content)], resolved_detections: [], review_decisions: [], mapping_plan: plan(audit), sanitized_preview_records: [preview(content)] }; }
function candidate(audit = "aud_A", content = "Alpha"): { candidate: FinalizedReviewCandidate; context: ReturnType<typeof createCandidateFreshnessContext> } {
  const s = state(audit, content); return { candidate: finalizeReviewCandidate({ ...s, revision_mapping_snapshot: [], local_mapping_vault: [] }), context: createCandidateFreshnessContext(s) };
}

class FakeRepository implements ConfirmationRepositoryPort {
  readonly rows = new Map<string, LocalConfirmedPrivacyAggregate>();
  saveCalls = 0;
  failNext: PersistenceError | null = null;
  beforeSave: (() => Promise<void>) | null = null;
  async getConfirmedPrivacyAggregateLocal(id: string): Promise<LocalConfirmedPrivacyAggregate> {
    const row = this.rows.get(id);
    if (!row) throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Synthetic not found.");
    return row;
  }
  async saveConfirmedPrivacyAggregate(input: { revision: unknown; records: readonly unknown[]; mappings: readonly unknown[] }): Promise<RepositoryWriteResult<SafeConfirmedPrivacyAggregate>> {
    this.saveCalls += 1;
    if (this.beforeSave) await this.beforeSave();
    if (this.failNext) { const error = this.failNext; this.failNext = null; throw error; }
    const revision = input.revision as ConfirmedPrivacyRevision;
    const records = input.records as readonly SanitizedCanonicalRecordRevision[];
    const mappings = input.mappings as readonly PrivacyMapping[];
    const existing = this.rows.get(revision.privacy_revision_id);
    if (existing) return { outcome: "IDEMPOTENT_EXISTING", value: { revision: existing.revision, records: existing.records } };
    this.rows.set(revision.privacy_revision_id, { revision, records, mappings });
    return { outcome: "INSERTED", value: { revision, records } };
  }
}
function service(repo = new FakeRepository(), lock = new PerAuditConfirmationLock(), times = ["2026-09-25T10:00:00.000Z"]) {
  let index = 0;
  return { repo, lock, svc: new PrivacyConfirmationService(repo, lock, () => times[Math.min(index++, times.length - 1)]!) };
}

// C01 T03: REVIEW_COMPLETE/runtime candidate is not confirmed without Repository commit and cannot inject confirmed_at.
test("C01 T03 candidate existence alone is never confirmation", () => {
  const c = candidate();
  assert.equal(Object.prototype.hasOwnProperty.call(c.candidate, "confirmed_at"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(c.candidate, "confirmation_state"), false);
});

// C02 T01 T02: new confirmation uses only Repository and injected UTC clock.
test("C02 T01 T02 new confirmation persists once via repository with injected UTC timestamp", async () => {
  const { repo, svc } = service(); const c = candidate();
  const result = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
  assert.equal(repo.saveCalls, 1);
  assert.equal(result.confirmed_at, "2026-09-25T10:00:00.000Z");
  assert.match(result.confirmed_at, /^\d{4}-\d{2}-\d{2}T.*\.\d{3}Z$/u);
  assert.equal(result.idempotent, false);
});

// C03 C04 G11: reconfirm is idempotent and preserves persisted original confirmed_at without calling a replacement timestamp.
test("C03 C04 G11 idempotent reconfirm preserves original confirmed_at", async () => {
  const { repo, svc } = service(new FakeRepository(), new PerAuditConfirmationLock(), ["2026-09-25T10:00:00.000Z", "2027-01-01T00:00:00.000Z"]); const c = candidate();
  const first = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
  const second = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
  assert.equal(repo.saveCalls, 1);
  assert.equal(second.idempotent, true);
  assert.equal(second.confirmed_at, first.confirmed_at);
});

// C05 C06: same revision identity with different persisted semantic aggregate is immutability violation.
test("C05 C06 existing same ID with changed records or mappings is IMMUTABILITY_VIOLATION", async () => {
  {
    const { repo, svc } = service(); const c = candidate();
    const first = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
    const existing = repo.rows.get(first.privacy_revision_id)!;
    repo.rows.set(first.privacy_revision_id, { ...existing, records: [{ ...existing.records[0]!, sanitized_content: "tampered" }] });
    await assert.rejects(() => svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context }), (error: unknown) => error instanceof ConfirmationRuntimeError && error.code === "IMMUTABILITY_VIOLATION");
  }
  {
    const { repo, svc } = service(); const c = candidate();
    const first = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
    const existing = repo.rows.get(first.privacy_revision_id)!;
    const syntheticMapping = { mapping_id: "map_00000000000000000000000000000000", audit_id: "aud_A", privacy_revision_id: first.privacy_revision_id, entity_type: "PERSON", placeholder: "PERSON_001", original_value: "SYNTHETIC_LOCAL", normalized_key: "synthetic_local", aliases: [], active: true } as PrivacyMapping;
    repo.rows.set(first.privacy_revision_id, { ...existing, mappings: [syntheticMapping] });
    await assert.rejects(() => svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context }), (error: unknown) => error instanceof ConfirmationRuntimeError && error.code === "IMMUTABILITY_VIOLATION");
  }
});

// C08 C09 C10 C11 X03 X04: repository-stage failure propagates safely; no internal retry; fresh candidate may explicitly retry.
test("C08 C09 C10 C11 X03 X04 transaction-stage failures are not retried internally and fresh candidate can retry", async () => {
  for (const syntheticStage of ["revision", "record", "mapping"] as const) {
    const { repo, svc } = service(); const c = candidate();
    repo.failNext = new PersistenceError("TRANSACTION_FAILED", `Synthetic ${syntheticStage} stage failure.`);
    await assert.rejects(() => svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context }), (error: unknown) => error instanceof ConfirmationRuntimeError && error.code === "TRANSACTION_FAILED");
    assert.equal(repo.saveCalls, 1); assert.equal(repo.rows.size, 0);
    const retried = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
    assert.equal(retried.idempotent, false); assert.equal(repo.saveCalls, 2);
  }
});

// C12: later revision confirmation leaves old revision immutable and readable.
test("C12 later privacy revision does not mutate an older confirmed revision", async () => {
  const { repo, svc } = service(); const a = candidate("aud_A", "Alpha"); const b = candidate("aud_A", "Beta");
  const one = await svc.confirm({ candidate: a.candidate, revisionSalt: salt, currentContext: () => a.context });
  const old = JSON.stringify(repo.rows.get(one.privacy_revision_id));
  await svc.confirm({ candidate: b.candidate, revisionSalt: salt, currentContext: () => b.context });
  assert.equal(JSON.stringify(repo.rows.get(one.privacy_revision_id)), old); assert.equal(repo.rows.size, 2);
});

// T04: result is not emitted before repository operation resolves.
test("T04 confirmation success resolves only after Repository success", async () => {
  const repo = new FakeRepository(); let release!: () => void; repo.beforeSave = () => new Promise<void>((resolve) => { release = resolve; });
  const { svc } = service(repo); const c = candidate(); let done = false;
  const pending = svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context }).then((r) => { done = true; return r; });
  await new Promise((resolve) => setTimeout(resolve, 0)); assert.equal(done, false); release(); await pending; assert.equal(done, true);
});

// S04 T05 T06 G06: safe result exact allowlist excludes salt/raw/mappings/revision_salt.
test("T05 T06 G06 SafeConfirmationResult uses exact six-field allowlist", async () => {
  const { svc } = service(); const c = candidate(); const result = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
  assert.deepEqual(Object.keys(result).sort(), ["audit_id", "privacy_revision_id", "record_count", "mapping_count", "confirmed_at", "idempotent"].sort());
  assert.ok(!JSON.stringify(result).includes("revision_salt")); assert.ok(!JSON.stringify(result).includes("original_value"));
});

// S05 T07 G07: safe error never copies raw/salt/mapping/error payload material.
test("T07 G07 safe confirmation error does not leak sensitive original exception text", async () => {
  const secret = "SYNTHETIC_DO_NOT_LEAK"; const { repo, svc } = service(); const c = candidate();
  repo.failNext = new PersistenceError("TRANSACTION_FAILED", secret);
  try { await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context }); assert.fail(); }
  catch (error) { assert.ok(error instanceof ConfirmationRuntimeError); assert.ok(!error.message.includes(secret)); assert.deepEqual(Object.keys(error).filter((k) => ["original_value", "revision_salt", "mapping"].includes(k)), []); }
});

// T08 G12: confirmation_state is only a compatibility projection submitted to frozen Repository, never a second runtime SOT.
test("T08 G12 confirmation_state is not present in candidate or safe result", async () => {
  const { svc } = service(); const c = candidate(); const result = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
  assert.equal(Object.prototype.hasOwnProperty.call(c.candidate, "confirmation_state"), false); assert.equal(Object.prototype.hasOwnProperty.call(result, "confirmation_state"), false);
});

// Q01 Q02 Q03 Q04: same-Audit same-candidate requests serialize, recheck, perform one insert and second idempotent success.
test("Q01 Q02 Q03 Q04 same candidate concurrent confirmation is serialized with one insert", async () => {
  const repo = new FakeRepository(); const lock = new PerAuditConfirmationLock(); const { svc } = service(repo, lock); const c = candidate(); let checks = 0;
  const provider = () => { checks += 1; return c.context; };
  const [a, b] = await Promise.all([
    svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: provider }),
    svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: provider }),
  ]);
  assert.equal(repo.saveCalls, 1); assert.equal(checks, 2); assert.deepEqual(new Set([a.idempotent, b.idempotent]), new Set([false, true]));
});

// Q05: two different fresh candidates for same Audit may both become historical revisions.
test("Q05 concurrent different fresh candidates can both confirm", async () => {
  const { repo, svc } = service(); const a = candidate("aud_A", "Alpha"); const b = candidate("aud_A", "Beta");
  const [ra, rb] = await Promise.all([svc.confirm({ candidate: a.candidate, revisionSalt: salt, currentContext: () => a.context }), svc.confirm({ candidate: b.candidate, revisionSalt: salt, currentContext: () => b.context })]);
  assert.notEqual(ra.privacy_revision_id, rb.privacy_revision_id); assert.equal(repo.rows.size, 2);
});

// Q07: candidate changed while waiting is rejected after lock acquisition and before write.
test("Q07 waiting caller rechecks freshness and rejects changed state before write", async () => {
  const repo = new FakeRepository(); const lock = new PerAuditConfirmationLock(); const { svc } = service(repo, lock); const c = candidate();
  let release!: () => void; const blocker = new Promise<void>((resolve) => { release = resolve; });
  const held = lock.runExclusive("aud_A", () => blocker);
  let current = c.context; const pending = svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => current });
  current = { ...current, raw_input_fingerprint: `${current.raw_input_fingerprint}changed` }; release(); await held;
  await assert.rejects(pending, (error: unknown) => error instanceof ConfirmationRuntimeError && error.code === "CANDIDATE_STALE"); assert.equal(repo.saveCalls, 0);
});

// G09 + lock safety: success and throw paths release and remove idle audit key.
test("G09 lock releases and cleans registry on success and throw", async () => {
  const lock = new PerAuditConfirmationLock(); await lock.runExclusive("aud_A", async () => 1); assert.equal(lock.pendingAuditKeyCount, 0);
  await assert.rejects(() => lock.runExclusive("aud_A", async () => { throw new Error("synthetic"); })); assert.equal(lock.pendingAuditKeyCount, 0);
});

// G10: different Audits are not serialized by one global mutex.
test("G10 different audit keys proceed independently", async () => {
  const lock = new PerAuditConfirmationLock(); let releaseA!: () => void; let bEntered = false;
  const a = lock.runExclusive("aud_A", () => new Promise<void>((resolve) => { releaseA = resolve; }));
  const b = lock.runExclusive("aud_B", async () => { bEntered = true; });
  await b; assert.equal(bEntered, true); releaseA(); await a;
});

// X01: confirmed revision restores through Repository read path.
test("X01 confirmed revision can be restored from Repository", async () => {
  const { repo, svc } = service(); const c = candidate(); const result = await svc.confirm({ candidate: c.candidate, revisionSalt: salt, currentContext: () => c.context });
  const restored = await repo.getConfirmedPrivacyAggregateLocal(result.privacy_revision_id); assert.equal(restored.revision.confirmed_at, result.confirmed_at);
});

// X02 Q08: runtime constants state restart/cross-process boundaries without inventing persistence or lock claims.
test("X02 Q08 unconfirmed restart and cross-process lock guarantees remain explicitly absent", async () => {
  const revision = await import("../src/privacy/revision/index.js");
  assert.equal(revision.UNCONFIRMED_CANDIDATE_RESTART_RECOVERY, "NOT_GUARANTEED"); assert.equal(revision.CROSS_PROCESS_LOCK_GUARANTEE, false);
});

// X05: no internal automatic retry loop.
test("X05 automatic confirmation retry policy is NONE", async () => {
  const revision = await import("../src/privacy/revision/index.js"); assert.equal(revision.AUTOMATIC_CONFIRMATION_RETRY, "NONE");
});

// X06 X07 X08 C07 G08: static production boundary scan: no egress/provider/graph/direct SQL/Drizzle/SQLite mutation or frozen-layer edits.
test("X06 X07 X08 C07 G08 CP-3 production candidate stays inside frozen boundary", () => {
  const root = path.resolve(process.cwd(), "src/privacy/revision"); const text = fs.readdirSync(root).filter((n) => n.endsWith(".ts")).map((n) => fs.readFileSync(path.join(root, n), "utf8")).join("\n");
  for (const forbidden of ["better-sqlite3", "drizzle-orm", "fetch(", "DeepSeek", "OpenAI", "LangGraph", "INSERT INTO", "UPDATE ", "DELETE FROM", "db.prepare", "db.run", "EGRESS_ALLOWED"]) assert.ok(!text.includes(forbidden), forbidden);
  assert.ok(text.includes("saveConfirmedPrivacyAggregate")); assert.ok(text.includes("getConfirmedPrivacyAggregateLocal"));
});

// G01 G02 G03: frozen revision functions are imported; no V2/custom revision hash names exist.
test("G01 G02 G03 revision builder reuses frozen functions and contains no second revision hash/serializer", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/privacy/revision/revision-builder.ts"), "utf8");
  assert.ok(source.includes("computePrivacyRevisionId")); assert.ok(source.includes("computeRecordRevisionId"));
  assert.ok(!source.includes("computePrivacyRevisionIdV2")); assert.ok(!source.includes("newRevisionHash")); assert.ok(!source.includes("customRevisionSerializer")); assert.ok(!source.includes("createHash"));
});

// G13: no record_revision_ids second snapshot-list field exists in runtime DTOs.
test("G13 no record_revision_ids second snapshot SOT is introduced", () => {
  const source = fs.readFileSync(path.resolve(process.cwd(), "src/privacy/revision/types.ts"), "utf8"); assert.ok(!source.includes("record_revision_ids")); assert.ok(!source.includes("input_record_revision_ids"));
});
