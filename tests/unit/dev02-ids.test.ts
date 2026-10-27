import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeEvidenceId,
  computePrivacyRevisionId,
  computeRecordRevisionId,
  createAuditId,
  createChangeId,
  createCommitmentId,
  createConflictId,
  createProviderCallId,
  createReportVersionId,
} from "../../src/shared/ids/index.js";
import type {
  EvidenceIdentityInput,
  PrivacyRevisionId,
  RevisionMappingSnapshot,
  RevisionRecordSnapshot,
} from "../../src/shared/ids/types.js";

const salt = new Uint8Array(Array.from({ length: 32 }, (_, index) => index));

const records: readonly RevisionRecordSnapshot[] = [
  {
    record_id: "rec_a",
    source_type: "PASTE",
    source_name: "meeting",
    author: "[PERSON_1]",
    timestamp: null,
    sanitized_content: "alpha beta",
    sequence: 0,
  },
  {
    record_id: "rec_b",
    source_type: "PASTE",
    source_name: "meeting",
    author: "[PERSON_2]",
    timestamp: null,
    sanitized_content: "gamma",
    sequence: 1,
  },
];

const mappings: readonly RevisionMappingSnapshot[] = [
  {
    entity_type: "PERSON",
    placeholder: "[PERSON_1]",
    normalized_original_value: "normalized-a",
    aliases: ["Alias B", "Alias A"],
    active: true,
  },
];

test("random lifecycle IDs have frozen prefixes", () => {
  assert.match(createAuditId(), /^aud_/);
  assert.match(createReportVersionId(), /^rpt_/);
  assert.match(createCommitmentId(), /^com_/);
  assert.match(createChangeId(), /^chg_/);
  assert.match(createConflictId(), /^cfl_/);
  assert.match(createProviderCallId(), /^pcall_/);
});

test("privacy revision is deterministic and input array order is normalized by semantic sequence", () => {
  const first = computePrivacyRevisionId({ revision_salt: salt, records, mappings });
  const second = computePrivacyRevisionId({
    revision_salt: salt,
    records: [...records].reverse(),
    mappings,
  });
  assert.equal(first, second);
});

test("mapping change changes privacy revision", () => {
  const first = computePrivacyRevisionId({ revision_salt: salt, records, mappings });
  const changed = computePrivacyRevisionId({
    revision_salt: salt,
    records,
    mappings: [{ ...mappings[0]!, active: false }],
  });
  assert.notEqual(first, changed);
});

test("record content or semantic sequence change changes privacy revision", () => {
  const first = computePrivacyRevisionId({ revision_salt: salt, records, mappings });
  const changedContent = computePrivacyRevisionId({
    revision_salt: salt,
    records: [{ ...records[0]!, sanitized_content: "changed" }, records[1]!],
    mappings,
  });
  const changedSequence = computePrivacyRevisionId({
    revision_salt: salt,
    records: [{ ...records[0]!, sequence: 2 }, records[1]!],
    mappings,
  });
  assert.notEqual(first, changedContent);
  assert.notEqual(first, changedSequence);
});

test("record revision is deterministic and privacy revision scoped", () => {
  const privacyA = computePrivacyRevisionId({ revision_salt: salt, records, mappings });
  const rr1 = computeRecordRevisionId({ privacy_revision_id: privacyA, record: records[0]! });
  const rr2 = computeRecordRevisionId({ privacy_revision_id: privacyA, record: records[0]! });
  assert.equal(rr1, rr2);

  const privacyB = (`prv_${"b".repeat(43)}`) as PrivacyRevisionId;
  const rr3 = computeRecordRevisionId({ privacy_revision_id: privacyB, record: records[0]! });
  assert.notEqual(rr1, rr3);
});

test("evidence ID is deterministic and changes with span or type", () => {
  const base: EvidenceIdentityInput = {
    report_version_id: "rpt_test",
    record_revision_id: "rr_test",
    char_start: 0,
    char_end: 5,
    evidence_type: "STATEMENT",
  };
  const first = computeEvidenceId(base);
  assert.equal(first, computeEvidenceId(base));
  assert.notEqual(first, computeEvidenceId({ ...base, char_end: 4 }));
  assert.notEqual(first, computeEvidenceId({ ...base, evidence_type: "STATUS" }));
});
