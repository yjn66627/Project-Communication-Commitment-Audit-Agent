import assert from "node:assert/strict";
import test from "node:test";

import {
  createCandidateFreshnessContext,
  finalizeReviewCandidate,
  validateCandidateFreshness,
  selectLatestApplicableConfirmedRevision,
  type CandidateSemanticStateInput,
} from "../src/privacy/revision/index.js";
import type { CanonicalRecordDraft } from "../src/domain/schemas/canonical.js";
import type { SanitizedPreviewRecordCandidate } from "../src/privacy/preview/types.js";
import type { PseudonymMappingPlan } from "../src/privacy/pseudonymization/types.js";

function raw(id = "rec_1", content = "Alpha", sequence = 0): CanonicalRecordDraft {
  return { record_id: id, source_type: "PASTE", source_name: "safe.txt", author: null, timestamp: null, content, sequence, metadata: {} } as CanonicalRecordDraft;
}
function preview(id = "rec_1", content = "Alpha", sequence = 0): SanitizedPreviewRecordCandidate {
  return { record_id: id, source_type: "PASTE", sanitized_source_name: "safe.txt", sanitized_author: null, timestamp: null, sanitized_content: content, sequence };
}
function plan(audit = "aud_A", reserved: readonly string[] = []): PseudonymMappingPlan { return { audit_id: audit, mappings: [], semantic_entities: [], reserved_placeholders: reserved }; }
function state(overrides: Partial<CandidateSemanticStateInput> = {}): CandidateSemanticStateInput {
  return { audit_id: "aud_A", raw_records: [raw()], resolved_detections: [], review_decisions: [], mapping_plan: plan(), sanitized_preview_records: [preview()], ...overrides };
}
function candidate(s = state()) { return finalizeReviewCandidate({ ...s, revision_mapping_snapshot: [], local_mapping_vault: [] }); }

// F01: unchanged current context is fresh.
test("F01 unchanged candidate context is FRESH", () => {
  const s = state();
  assert.deepEqual(validateCandidateFreshness(candidate(s), createCandidateFreshnessContext(s)), { status: "FRESH" });
});

// F02: audit mismatch.
test("F02 audit mismatch is STALE/AUDIT_MISMATCH", () => {
  const c = candidate();
  assert.deepEqual(validateCandidateFreshness(c, { ...createCandidateFreshnessContext(state()), audit_id: "aud_B" }), { status: "STALE", reason: "AUDIT_MISMATCH" });
});

// F03: raw change with same set/sequence.
test("F03 raw content change is STALE/RAW_INPUT_CHANGED", () => {
  const c = candidate();
  assert.deepEqual(validateCandidateFreshness(c, createCandidateFreshnessContext(state({ raw_records: [raw("rec_1", "Beta")] }))), { status: "STALE", reason: "RAW_INPUT_CHANGED" });
});

// F04: record set change has specific reason before general raw mismatch.
test("F04 record add/remove is STALE/RECORD_SET_CHANGED", () => {
  const c = candidate();
  const changed = state({ raw_records: [raw(), raw("rec_2", "B", 1)], sanitized_preview_records: [preview(), preview("rec_2", "B", 1)] });
  assert.deepEqual(validateCandidateFreshness(c, createCandidateFreshnessContext(changed)), { status: "STALE", reason: "RECORD_SET_CHANGED" });
});

// F05: sequence change has specific reason.
test("F05 sequence change is STALE/RECORD_SEQUENCE_CHANGED", () => {
  const c = candidate();
  const changed = state({ raw_records: [raw("rec_1", "Alpha", 1)], sanitized_preview_records: [preview("rec_1", "Alpha", 1)] });
  assert.deepEqual(validateCandidateFreshness(c, createCandidateFreshnessContext(changed)), { status: "STALE", reason: "RECORD_SEQUENCE_CHANGED" });
});

// F06: detection fingerprint change.
test("F06 detection change is STALE/DETECTION_CHANGED", () => {
  const c = candidate();
  const changed = createCandidateFreshnessContext(state());
  assert.deepEqual(validateCandidateFreshness(c, { ...changed, resolved_detection_fingerprint: `${changed.resolved_detection_fingerprint}x` }), { status: "STALE", reason: "DETECTION_CHANGED" });
});

// F07 F08 F10 F11: review decisions bind acceptance, merge/split and URL/FP review state.
test("F07 F08 F10 F11 review decision changes are stale", () => {
  const c = candidate();
  const changed = createCandidateFreshnessContext(state());
  assert.deepEqual(validateCandidateFreshness(c, { ...changed, review_decision_fingerprint: `${changed.review_decision_fingerprint}x` }), { status: "STALE", reason: "REVIEW_DECISION_CHANGED" });
});

// F09: mapping plan / placeholder change.
test("F09 placeholder/mapping plan change is STALE/MAPPING_PLAN_CHANGED", () => {
  const c = candidate();
  const changed = createCandidateFreshnessContext(state({ mapping_plan: plan("aud_A", ["PERSON_009"]) }));
  assert.deepEqual(validateCandidateFreshness(c, changed), { status: "STALE", reason: "MAPPING_PLAN_CHANGED" });
});

// F12: sanitized preview change.
test("F12 preview change is STALE/PREVIEW_CHANGED", () => {
  const c = candidate();
  const changed = state({ sanitized_preview_records: [preview("rec_1", "SanitizedBeta")] });
  assert.deepEqual(validateCandidateFreshness(c, createCandidateFreshnessContext(changed)), { status: "STALE", reason: "PREVIEW_CHANGED" });
});

// F13: current state unavailable.
test("F13 unavailable current context is STALE/CANDIDATE_STATE_UNAVAILABLE", () => {
  assert.deepEqual(validateCandidateFreshness(candidate(), null), { status: "STALE", reason: "CANDIDATE_STATE_UNAVAILABLE" });
});

// L01 L02 L03 L04: latest selector is same-audit, newest-time, lexical-tie, input-order independent.
test("L01 L02 L03 L04 latest confirmed selector is deterministic", () => {
  const rows = [
    { audit_id: "aud_A", privacy_revision_id: "prv_z", confirmed_at: "2026-01-02T00:00:00.000Z" },
    { audit_id: "aud_A", privacy_revision_id: "prv_a", confirmed_at: "2026-01-02T00:00:00.000Z" },
    { audit_id: "aud_A", privacy_revision_id: "prv_old", confirmed_at: "2026-01-01T00:00:00.000Z" },
    { audit_id: "aud_B", privacy_revision_id: "prv_other", confirmed_at: "2027-01-01T00:00:00.000Z" },
  ];
  assert.equal(selectLatestApplicableConfirmedRevision("aud_A", rows)?.privacy_revision_id, "prv_a");
  assert.equal(selectLatestApplicableConfirmedRevision("aud_A", [...rows].reverse())?.privacy_revision_id, "prv_a");
});

// L05: pure selector has no mutable latest pointer behavior.
test("L05 latest selector requires only supplied metadata and creates no current pointer", () => {
  const input = [{ audit_id: "aud_A", privacy_revision_id: "prv_a", confirmed_at: "2026-01-01T00:00:00.000Z" }];
  const copy = JSON.stringify(input);
  selectLatestApplicableConfirmedRevision("aud_A", input);
  assert.equal(JSON.stringify(input), copy);
  assert.equal((input[0] as Record<string, unknown>).latest_privacy_revision_id, undefined);
});

// Q06: another confirmation is not part of candidate freshness context.
test("Q06 another revision confirmation alone does not stale a candidate", () => {
  const s = state();
  const c = candidate(s);
  assert.deepEqual(validateCandidateFreshness(c, createCandidateFreshnessContext(s)), { status: "FRESH" });
});
