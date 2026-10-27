import assert from "node:assert/strict";
import test from "node:test";

import {
  auditRowToLocalIdentity,
  auditRowToSafeView,
  auditToRow,
  canonicalRecordRowToDomain,
  canonicalRecordToRow,
  changeRowToDomain,
  changeToRow,
  commitmentRowToDomain,
  commitmentToRow,
  conflictRowToDomain,
  conflictToRow,
  confirmedPrivacyRevisionToRow,
  evidenceRowToDomain,
  evidenceToRow,
  privacyMappingRowToDomain,
  privacyMappingToRow,
  privacyRevisionRowToDomain,
  providerCallRowToDomain,
  providerCallToRow,
  reportVersionRowToDomain,
  reportVersionToRow,
} from "../src/db/persistence/row-mappers.js";
import { PersistenceBoundaryError } from "../src/db/persistence/persistence-types.js";

const Z = "2026-09-24T00:00:00.000Z";
const OFFSET = "2026-09-24T08:00:00.000+08:00";
const SALT = Buffer.alloc(32, 7).toString("base64url");

const expectCode = (fn: () => unknown, code: string) => {
  assert.throws(fn, (error: unknown) => {
    return error instanceof PersistenceBoundaryError && error.code === code;
  });
};

const samples = {
  audit: { audit_id: "aud_1", revision_salt: SALT, created_at: Z },
  privacyRevision: {
    privacy_revision_id: "prv_1",
    audit_id: "aud_1",
    confirmation_state: "CONFIRMED",
    algorithm: "privacy-revision-v1",
    confirmed_at: OFFSET,
    record_count: 1,
    mapping_count: 1,
  },
  canonical: {
    record_revision_id: "rr_1",
    audit_id: "aud_1",
    record_id: "rec_1",
    privacy_revision_id: "prv_1",
    source_type: "PASTE",
    source_name: "synthetic-source",
    author: null,
    timestamp: "synthetic-time-label",
    sanitized_content: "Synthetic sanitized content",
    sequence: 0,
    metadata: {},
  },
  mapping: {
    mapping_id: "map_1",
    audit_id: "aud_1",
    privacy_revision_id: "prv_1",
    entity_type: "PERSON",
    placeholder: "[PERSON_1]",
    original_value: "Synthetic Local Value",
    normalized_key: "synthetic-local-value",
    aliases: ["Synthetic Alias A", "Synthetic Alias B"],
    active: true,
  },
  report: {
    report_version_id: "rpt_1",
    audit_id: "aud_1",
    privacy_revision_id: "prv_1",
    parent_report_version_id: null,
    version_number: 1,
    status: "RUNNING",
    changes_summary: null,
    created_at: OFFSET,
    started_at: OFFSET,
    completed_at: null,
  },
  evidence: {
    evidence_id: "ev_1",
    report_version_id: "rpt_1",
    privacy_revision_id: "prv_1",
    record_revision_id: "rr_1",
    record_id: "rec_1",
    source_ref: {
      source_name: "synthetic-source",
      sequence: 0,
      char_start: 0,
      char_end: 9,
    },
    excerpt: "Synthetic",
    actor: null,
    timestamp: "synthetic-time-label",
    evidence_type: "STATEMENT",
    epistemic_status: "FACT",
    fact_scope: "SOURCE_FACT",
  },
  commitment: {
    commitment_id: "com_1",
    report_version_id: "rpt_1",
    action_or_deliverable: "Synthetic deliverable",
    evidence_ids: ["ev_1"],
    deadline: "synthetic-deadline",
    condition: null,
    recipient: null,
    lifecycle_status: "OPEN",
    supersedes_commitment_id: null,
    status_evidence_ids: [],
    classification: "CONFIRMED",
    actor: "Synthetic Actor",
    epistemic_status: "FACT",
  },
  change: {
    change_id: "chg_1",
    report_version_id: "rpt_1",
    change_type: "MODIFY",
    subject: "Synthetic requirement",
    before_summary: "Before",
    after_summary: "After",
    evidence_ids: ["ev_1"],
    timestamp: "synthetic-time-label",
    classification: "CONFIRMED",
    epistemic_status: "FACT",
  },
  conflict: {
    conflict_id: "cfl_1",
    report_version_id: "rpt_1",
    conflict_type: "POTENTIAL_CONFLICT",
    claim_a: { text: "Synthetic claim A", evidence_ids: ["ev_1"] },
    claim_b: { text: "Synthetic claim B", evidence_ids: ["ev_2"] },
    comparable_context: {
      subject: "Synthetic subject",
      time_context: null,
      version_context: "v1-v2",
      condition_context: null,
    },
    conflict_reason: "Synthetic discrepancy",
    counter_evidence_ids: [],
    alternative_explanations: [
      { text: "Synthetic alternative", epistemic_status: "INFERENCE" },
    ],
    missing_evidence: ["Synthetic missing evidence"],
    epistemic_status: "UNKNOWN",
    conflicted: true,
  },
  providerCall: {
    provider_call_id: "pcall_1",
    audit_id: "aud_1",
    report_version_id: "rpt_1",
    stage: "SYNTHETIC_STAGE",
    provider_name: "SyntheticProvider",
    model_name: "SyntheticModel",
    started_at: OFFSET,
    completed_at: null,
    latency_ms: 12,
    status: "SUCCESS",
    input_record_count: 1,
    input_size_chars: 42,
    input_tokens: 10,
    output_tokens: 20,
    total_tokens: 30,
    cost_amount_micros: 100,
    cost_currency: "USD",
    retry_count: 0,
    schema_valid: true,
    error_category: null,
    output_counts: { evidence: 1, commitments: 1, changes: 1, conflicts: 1, unknown: 0 },
  },
} as const;

test("Audit persistence round-trip and safe view does not expose revision_salt", () => {
  const row = auditToRow(samples.audit);
  const full = auditRowToLocalIdentity(row as Parameters<typeof auditRowToLocalIdentity>[0]);
  assert.deepEqual(full, samples.audit);
  const safe = auditRowToSafeView(row as Parameters<typeof auditRowToSafeView>[0]);
  assert.deepEqual(safe, { audit_id: "aud_1", created_at: Z });
  assert.equal("revision_salt" in safe, false);
});

test("ConfirmedPrivacyRevision round-trip restores confirmation_state but never persists it", () => {
  const row = confirmedPrivacyRevisionToRow(samples.privacyRevision);
  assert.equal("confirmationState" in row, false);
  assert.equal("recordRevisionIds" in row, false);
  assert.equal("inputRecordRevisionIds" in row, false);
  const domain = privacyRevisionRowToDomain(row as Parameters<typeof privacyRevisionRowToDomain>[0]);
  assert.equal(domain.confirmation_state, "CONFIRMED");
  assert.equal(domain.confirmed_at, Z);
});

test("SanitizedCanonicalRecordRevision round-trip and SQL NULL metadata rule", () => {
  const row = canonicalRecordToRow(samples.canonical);
  assert.deepEqual(
    canonicalRecordRowToDomain(row as Parameters<typeof canonicalRecordRowToDomain>[0]),
    samples.canonical,
  );
  const withoutMetadata = { ...samples.canonical } as Record<string, unknown>;
  delete withoutMetadata.metadata;
  const nullRow = canonicalRecordToRow(withoutMetadata);
  assert.equal(nullRow.metadataJson, null);
  const restored = canonicalRecordRowToDomain(
    nullRow as Parameters<typeof canonicalRecordRowToDomain>[0],
  );
  assert.equal("metadata" in restored, false);
});

test("PrivacyMapping local-only round-trip preserves alias order and applies aliases default", () => {
  const row = privacyMappingToRow(samples.mapping, Z);
  const domain = privacyMappingRowToDomain(row as Parameters<typeof privacyMappingRowToDomain>[0]);
  assert.deepEqual(domain, samples.mapping);

  const { aliases: _aliases, ...mappingWithoutAliases } = samples.mapping;
  const defaultedRow = privacyMappingToRow(mappingWithoutAliases, Z);
  const defaultedDomain = privacyMappingRowToDomain(
    defaultedRow as Parameters<typeof privacyMappingRowToDomain>[0],
  );
  assert.deepEqual(defaultedDomain.aliases, []);
});

test("ReportVersion round-trip preserves semantic fields and normalizes strict datetimes to UTC", () => {
  const row = reportVersionToRow(samples.report);
  const domain = reportVersionRowToDomain(row as Parameters<typeof reportVersionRowToDomain>[0]);
  assert.equal(domain.created_at, Z);
  assert.equal(domain.started_at, Z);
  assert.equal(domain.status, "RUNNING");
});

test("Evidence round-trip and invalid persisted epistemic status is rejected", () => {
  const row = evidenceToRow(samples.evidence);
  assert.deepEqual(
    evidenceRowToDomain(row as Parameters<typeof evidenceRowToDomain>[0]),
    samples.evidence,
  );
  expectCode(
    () => evidenceRowToDomain({ ...row, epistemicStatus: "UNKNOWN" } as Parameters<typeof evidenceRowToDomain>[0]),
    "PERSISTENCE_INTEGRITY_ERROR",
  );
});

test("Commitment discriminated-union branch is preserved", () => {
  const confirmedRow = commitmentToRow(samples.commitment);
  const confirmed = commitmentRowToDomain(
    confirmedRow as Parameters<typeof commitmentRowToDomain>[0],
  );
  assert.equal(confirmed.classification, "CONFIRMED");

  const candidate = {
    ...samples.commitment,
    commitment_id: "com_2",
    classification: "CANDIDATE",
    actor: null,
    epistemic_status: "UNKNOWN",
  } as const;
  const candidateRow = commitmentToRow(candidate);
  const candidateRoundTrip = commitmentRowToDomain(
    candidateRow as Parameters<typeof commitmentRowToDomain>[0],
  );
  assert.equal(candidateRoundTrip.classification, "CANDIDATE");
});

test("RequirementDecisionChange union branch is preserved", () => {
  const row = changeToRow(samples.change);
  assert.deepEqual(changeRowToDomain(row as Parameters<typeof changeRowToDomain>[0]), samples.change);

  const candidate = {
    ...samples.change,
    change_id: "chg_2",
    classification: "CANDIDATE",
    epistemic_status: "INFERENCE",
  } as const;
  const candidateRow = changeToRow(candidate);
  assert.equal(
    changeRowToDomain(candidateRow as Parameters<typeof changeRowToDomain>[0]).classification,
    "CANDIDATE",
  );
});

test("PotentialConflict round-trip and FACT is rejected", () => {
  const row = conflictToRow(samples.conflict);
  assert.deepEqual(
    conflictRowToDomain(row as Parameters<typeof conflictRowToDomain>[0]),
    samples.conflict,
  );
  expectCode(
    () => conflictRowToDomain({ ...row, epistemicStatus: "FACT" } as Parameters<typeof conflictRowToDomain>[0]),
    "PERSISTENCE_INTEGRITY_ERROR",
  );
});

test("ProviderCall persistence round-trip, SQL NULL output_counts, and forbidden payload field rejection", () => {
  const row = providerCallToRow(samples.providerCall);
  const roundTrip = providerCallRowToDomain(row as Parameters<typeof providerCallRowToDomain>[0]);
  assert.equal(roundTrip.started_at, Z);
  assert.deepEqual(roundTrip.output_counts, samples.providerCall.output_counts);

  const nullCounts = { ...samples.providerCall, provider_call_id: "pcall_2", output_counts: null };
  const nullRow = providerCallToRow(nullCounts);
  assert.equal(nullRow.outputCountsJson, null);
  assert.equal(
    providerCallRowToDomain(nullRow as Parameters<typeof providerCallRowToDomain>[0]).output_counts,
    null,
  );

  expectCode(
    () => providerCallToRow({ ...samples.providerCall, prompt: "must-not-persist" }),
    "DOMAIN_VALIDATION_ERROR",
  );
  for (const forbidden of [
    "prompt",
    "requestBody",
    "responseBody",
    "rawContent",
    "fullSanitizedText",
    "privacyMapping",
    "apiKey",
    "authorization",
    "secret",
    "cookie",
  ]) {
    assert.equal(forbidden in row, false);
  }
});

test("mapper object coverage is 10/10", () => {
  const roundTrips = [
    () => auditRowToLocalIdentity(auditToRow(samples.audit) as Parameters<typeof auditRowToLocalIdentity>[0]),
    () => privacyRevisionRowToDomain(confirmedPrivacyRevisionToRow(samples.privacyRevision) as Parameters<typeof privacyRevisionRowToDomain>[0]),
    () => canonicalRecordRowToDomain(canonicalRecordToRow(samples.canonical) as Parameters<typeof canonicalRecordRowToDomain>[0]),
    () => privacyMappingRowToDomain(privacyMappingToRow(samples.mapping, Z) as Parameters<typeof privacyMappingRowToDomain>[0]),
    () => reportVersionRowToDomain(reportVersionToRow(samples.report) as Parameters<typeof reportVersionRowToDomain>[0]),
    () => evidenceRowToDomain(evidenceToRow(samples.evidence) as Parameters<typeof evidenceRowToDomain>[0]),
    () => commitmentRowToDomain(commitmentToRow(samples.commitment) as Parameters<typeof commitmentRowToDomain>[0]),
    () => changeRowToDomain(changeToRow(samples.change) as Parameters<typeof changeRowToDomain>[0]),
    () => conflictRowToDomain(conflictToRow(samples.conflict) as Parameters<typeof conflictRowToDomain>[0]),
    () => providerCallRowToDomain(providerCallToRow(samples.providerCall) as Parameters<typeof providerCallRowToDomain>[0]),
  ];
  assert.equal(roundTrips.length, 10);
  for (const roundTrip of roundTrips) assert.doesNotThrow(roundTrip);
});
