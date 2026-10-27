import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConfirmedPrivacyAggregateDraft,
  computeCompatibilityMappingId,
  createCandidateFreshnessContext,
  finalizeReviewCandidate,
  type CandidateSemanticStateInput,
} from "../src/privacy/revision/index.js";
import { computePrivacyRevisionId, computeRecordRevisionId, stableCanonicalSerialize } from "../src/shared/ids/index.js";
import type { CanonicalRecordDraft } from "../src/domain/schemas/canonical.js";
import type { SanitizedPreviewRecordCandidate } from "../src/privacy/preview/types.js";
import type { LocalPrivacyMappingDraft, PseudonymMappingPlan } from "../src/privacy/pseudonymization/types.js";
import type { RevisionMappingSnapshot } from "../src/shared/ids/types.js";

const saltA = new Uint8Array(32).fill(7);
const saltB = new Uint8Array(32).fill(9);

function raw(overrides: Partial<CanonicalRecordDraft> = {}): CanonicalRecordDraft {
  return { record_id: "rec_1", source_type: "PASTE", source_name: "safe.txt", author: null, timestamp: null, content: "Alpha", sequence: 0, metadata: {}, ...overrides } as CanonicalRecordDraft;
}
function preview(overrides: Partial<SanitizedPreviewRecordCandidate> = {}): SanitizedPreviewRecordCandidate {
  return { record_id: "rec_1", source_type: "PASTE", sanitized_source_name: "safe.txt", sanitized_author: null, timestamp: null, sanitized_content: "Alpha", sequence: 0, ...overrides };
}
function emptyPlan(auditId = "aud_A"): PseudonymMappingPlan {
  return { audit_id: auditId, mappings: [], semantic_entities: [], reserved_placeholders: [] };
}
function mappingPlan(mapping: LocalPrivacyMappingDraft): PseudonymMappingPlan {
  return { audit_id: mapping.provenance === "CURRENT" ? "aud_A" : "aud_A", mappings: [mapping], semantic_entities: [], reserved_placeholders: [mapping.placeholder] };
}
function localMapping(overrides: Partial<LocalPrivacyMappingDraft> = {}): LocalPrivacyMappingDraft {
  return {
    local_high_sensitivity: true,
    semantic_entity_id: "sem_1",
    entity_type: "PERSON",
    placeholder: "PERSON_001",
    original_value: "LOCAL_SYNTHETIC_PERSON",
    normalized_key: "local_synthetic_person",
    aliases: [],
    active: true,
    provenance: "CURRENT",
    seed_revision_id: null,
    ...overrides,
  } as LocalPrivacyMappingDraft;
}
function snapshot(overrides: Partial<RevisionMappingSnapshot> = {}): RevisionMappingSnapshot {
  return { entity_type: "PERSON", placeholder: "PERSON_001", normalized_original_value: "local_synthetic_person", aliases: [], active: true, ...overrides } as RevisionMappingSnapshot;
}
function state(overrides: Partial<CandidateSemanticStateInput> = {}): CandidateSemanticStateInput {
  return { audit_id: "aud_A", raw_records: [raw()], resolved_detections: [], review_decisions: [], mapping_plan: emptyPlan(), sanitized_preview_records: [preview()], ...overrides };
}
function candidate(options: { state?: CandidateSemanticStateInput; mappings?: readonly RevisionMappingSnapshot[]; vault?: readonly LocalPrivacyMappingDraft[] } = {}) {
  const s = options.state ?? state();
  return finalizeReviewCandidate({ ...s, revision_mapping_snapshot: options.mappings ?? [], local_mapping_vault: options.vault ?? [] });
}

// R01 R04 R06 R08 G01 G02 G03: frozen DEV-02 identity functions are reused directly.
test("R01 R04 R06 R08 G01 G02 G03 revision identity is deterministic and existing ID functions stay authoritative", () => {
  const c1 = candidate({ state: state({ sanitized_preview_records: [preview({ record_id: "rec_2", sequence: 1 }), preview()] }) });
  const c2 = candidate({ state: state({ sanitized_preview_records: [preview(), preview({ record_id: "rec_2", sequence: 1 })] }) });
  const a = buildConfirmedPrivacyAggregateDraft({ candidate: c1, revisionSalt: saltA });
  const b = buildConfirmedPrivacyAggregateDraft({ candidate: c2, revisionSalt: saltA });
  assert.equal(a.privacy_revision_id, b.privacy_revision_id);
  assert.deepEqual(a.records.map((r) => r.record_revision_id), b.records.map((r) => r.record_revision_id));
  const direct = computePrivacyRevisionId({ revision_salt: saltA, records: c1.sanitized_preview_records.map((p) => ({ record_id: p.record_id as `rec_${string}`, source_type: p.source_type as "PASTE", source_name: p.sanitized_source_name, author: p.sanitized_author, timestamp: p.timestamp, sanitized_content: p.sanitized_content, sequence: p.sequence })), mappings: [] });
  assert.equal(a.privacy_revision_id, direct);
  const recordDirect = computeRecordRevisionId({ privacy_revision_id: a.privacy_revision_id, record: { record_id: "rec_1", source_type: "PASTE", source_name: "safe.txt", author: null, timestamp: null, sanitized_content: "Alpha", sequence: 0 } });
  assert.equal(a.records[0]?.record_revision_id, recordDirect);
});

// R02 R05 R07: record tuple/sequence changes affect frozen identities.
test("R02 R05 R07 record semantic changes produce new revision and record revision identities", () => {
  const base = buildConfirmedPrivacyAggregateDraft({ candidate: candidate(), revisionSalt: saltA });
  const contentChanged = buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ state: state({ sanitized_preview_records: [preview({ sanitized_content: "Beta" })] }) }), revisionSalt: saltA });
  const sequenceChanged = buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ state: state({ sanitized_preview_records: [preview({ sequence: 1 })] }) }), revisionSalt: saltA });
  assert.notEqual(base.privacy_revision_id, contentChanged.privacy_revision_id);
  assert.notEqual(base.privacy_revision_id, sequenceChanged.privacy_revision_id);
  assert.notEqual(base.records[0]?.record_revision_id, contentChanged.records[0]?.record_revision_id);
});

// R03 B10: mapping snapshot changes revision identity and equivalent canonical mapping serialization is stable.
test("R03 B10 mapping snapshot participates exactly in revision identity", () => {
  const m = localMapping();
  const c1 = candidate({ state: state({ mapping_plan: mappingPlan(m) }), mappings: [snapshot()], vault: [m] });
  const c2 = candidate({ state: state({ mapping_plan: mappingPlan({ ...m, active: false }) }), mappings: [snapshot({ active: false })], vault: [{ ...m, active: false }] });
  const a = buildConfirmedPrivacyAggregateDraft({ candidate: c1, revisionSalt: saltA });
  const b = buildConfirmedPrivacyAggregateDraft({ candidate: c2, revisionSalt: saltA });
  assert.notEqual(a.privacy_revision_id, b.privacy_revision_id);
  assert.equal(stableCanonicalSerialize(c1.revision_mapping_snapshot), stableCanonicalSerialize([...c1.revision_mapping_snapshot]));
});

// R09 G01: snapshot is exact five-field Authority and runtime IDs never enter it.
test("R09 G01 RevisionMappingSnapshot exact field set excludes semantic and candidate identities", () => {
  const item = snapshot();
  assert.deepEqual(Object.keys(item).sort(), ["active", "aliases", "entity_type", "normalized_original_value", "placeholder"].sort());
  assert.ok(!JSON.stringify(item).includes("semantic_entity_id"));
  assert.ok(!JSON.stringify(item).includes("review_candidate_id"));
});

// R10 B07 G14: SECRET is rejected from all reversible mapping material before write.
test("R10 B07 G14 SECRET cannot enter snapshot or local reversible mapping draft", () => {
  const secretSnapshot = { entity_type: "SECRET", placeholder: "SECRET_001", normalized_original_value: "x", aliases: [], active: true } as unknown as RevisionMappingSnapshot;
  const secretVault = { ...localMapping(), entity_type: "SECRET", placeholder: "SECRET_001" } as unknown as LocalPrivacyMappingDraft;
  assert.throws(() => buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ mappings: [secretSnapshot], vault: [secretVault] }), revisionSalt: saltA }), /SECRET cannot enter/u);
});

// S01 S02: same Audit salt is caller-owned and stable across candidates/revisions.
test("S01 S02 same audit salt produces stable identity while a new content state remains a distinct revision", () => {
  const first = buildConfirmedPrivacyAggregateDraft({ candidate: candidate(), revisionSalt: saltA });
  const rerun = buildConfirmedPrivacyAggregateDraft({ candidate: candidate(), revisionSalt: saltA });
  const later = buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ state: state({ sanitized_preview_records: [preview({ sanitized_content: "Later" })] }) }), revisionSalt: saltA });
  assert.equal(first.privacy_revision_id, rerun.privacy_revision_id);
  assert.notEqual(first.privacy_revision_id, later.privacy_revision_id);
  assert.notEqual(first.privacy_revision_id, buildConfirmedPrivacyAggregateDraft({ candidate: candidate(), revisionSalt: saltB }).privacy_revision_id);
});

// S03: wrong salt length fails before persistence can be involved.
test("S03 invalid revision salt length is rejected by pure builder", () => {
  assert.throws(() => buildConfirmedPrivacyAggregateDraft({ candidate: candidate(), revisionSalt: new Uint8Array(31) }), /32 bytes/u);
});

// S06 S07 S08 G05 G15: candidate runtime ID is deterministic, one-way, and distinct from persistent revision ID.
test("S06 S07 S08 G05 G15 review_candidate_id is deterministic, non-plaintext runtime identity only", () => {
  const syntheticSecretLike = "SYNTHETIC_LOCAL_ONLY_MATERIAL";
  const s = state({ raw_records: [raw({ content: syntheticSecretLike })] });
  const a = candidate({ state: s });
  const b = candidate({ state: s });
  assert.equal(a.review_candidate_id, b.review_candidate_id);
  assert.ok(a.review_candidate_id.startsWith("rcand_"));
  assert.ok(!a.review_candidate_id.includes(syntheticSecretLike));
  const draft = buildConfirmedPrivacyAggregateDraft({ candidate: a, revisionSalt: saltA });
  assert.notEqual(a.review_candidate_id, draft.privacy_revision_id);
  assert.ok(!JSON.stringify(draft).includes("review_candidate_id"));
});

// B01 B09: preview maps exactly to RevisionRecordSnapshot and builder is pure/deterministic.
test("B01 B09 preview conversion and aggregate draft are exact and deterministic", () => {
  const a = buildConfirmedPrivacyAggregateDraft({ candidate: candidate(), revisionSalt: saltA });
  const b = buildConfirmedPrivacyAggregateDraft({ candidate: candidate(), revisionSalt: saltA });
  assert.deepEqual(a, b);
  assert.equal(a.records[0]?.source_name, "safe.txt");
  assert.equal(a.records[0]?.sanitized_content, "Alpha");
  assert.equal(Object.prototype.hasOwnProperty.call(a, "confirmed_at"), false);
});

// B02: invalid preview source/schema fails before write.
test("B02 invalid sanitized preview shape fails in pure builder", () => {
  const bad = candidate({ state: state({ sanitized_preview_records: [preview({ source_type: "UNSUPPORTED" })] }) });
  assert.throws(() => buildConfirmedPrivacyAggregateDraft({ candidate: bad, revisionSalt: saltA }), /frozen revision snapshot/u);
});

// B03 B04 B05 B06: mapping snapshot/vault consistency is a strict pre-write gate.
test("B03 B04 B05 B06 mapping snapshot and local vault mismatch variants fail closed", () => {
  const m = localMapping();
  const baseState = state({ mapping_plan: mappingPlan(m) });
  assert.throws(() => buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ state: baseState, mappings: [], vault: [m] }), revisionSalt: saltA }));
  assert.throws(() => buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ state: baseState, mappings: [snapshot({ placeholder: "PERSON_002" })], vault: [m] }), revisionSalt: saltA }));
  assert.throws(() => buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ state: baseState, mappings: [snapshot({ normalized_original_value: "different" })], vault: [m] }), revisionSalt: saltA }));
  assert.throws(() => buildConfirmedPrivacyAggregateDraft({ candidate: candidate({ state: baseState, mappings: [snapshot({ aliases: ["alias"] })], vault: [m] }), revisionSalt: saltA }));
});

// B08 G04: compatibility mapping_id is deterministic and excludes raw/mapping-value inputs.
test("B08 G04 compatibility mapping_id is deterministic adapter-only identity", () => {
  const a = computeCompatibilityMappingId({ privacyRevisionId: "prv_test", entityType: "PERSON", placeholder: "PERSON_001" });
  const b = computeCompatibilityMappingId({ privacyRevisionId: "prv_test", entityType: "PERSON", placeholder: "PERSON_001" });
  assert.equal(a, b);
  assert.match(a, /^map_[0-9a-f]{32}$/u);
  assert.ok(!a.includes("LOCAL_SYNTHETIC_PERSON"));
});

// L06: seed provenance is outside revision identity when exact records/mappings are unchanged.
test("L06 seed provenance does not alter privacy revision identity", () => {
  const current = localMapping({ provenance: "CURRENT", seed_revision_id: null });
  const seeded = localMapping({ provenance: "SEED", seed_revision_id: "prv_history" });
  const a = candidate({ state: state({ mapping_plan: mappingPlan(current) }), mappings: [snapshot()], vault: [current] });
  const b = candidate({ state: state({ mapping_plan: mappingPlan(seeded) }), mappings: [snapshot()], vault: [seeded] });
  assert.equal(buildConfirmedPrivacyAggregateDraft({ candidate: a, revisionSalt: saltA }).privacy_revision_id, buildConfirmedPrivacyAggregateDraft({ candidate: b, revisionSalt: saltA }).privacy_revision_id);
});

// G11? stable context helper is deterministic for same semantic state.
test("candidate freshness context is stable for the same local semantic state", () => {
  assert.deepEqual(createCandidateFreshnessContext(state()), createCandidateFreshnessContext(state()));
});
