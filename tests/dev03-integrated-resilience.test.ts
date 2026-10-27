import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openPersistenceConnection, type PersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { ChangeRepository } from "../src/db/repositories/change-repository.js";
import { CommitmentRepository } from "../src/db/repositories/commitment-repository.js";
import { ConflictRepository } from "../src/db/repositories/conflict-repository.js";
import { EvidenceRepository } from "../src/db/repositories/evidence-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";
import { ProviderCallRepository } from "../src/db/repositories/provider-call-repository.js";
import { ReportContentRepository } from "../src/db/repositories/report-content-repository.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";

const AUDIT_ID = "aud_cp3d3";
const PRIVACY_REVISION_ID = "prv_cp3d3";
const REPORT_V1 = "rpt_cp3d3_v1";
const REPORT_V2 = "rpt_cp3d3_v2";
const REPORT_V3 = "rpt_cp3d3_v3";
const REVISION_SALT = Buffer.alloc(32, 0x63).toString("base64url");
const REPLAY_ITERATIONS = 20;
const REOPEN_CYCLE_COUNT = 5;

const RECORD_A = {
  record_revision_id: "rr_cp3d3_a",
  audit_id: AUDIT_ID,
  record_id: "rec_cp3d3_a",
  privacy_revision_id: PRIVACY_REVISION_ID,
  source_type: "PASTE" as const,
  source_name: "Synthetic Source A",
  author: "Synthetic Actor",
  timestamp: "2026-09-24T12:00:00.000Z",
  sanitized_content: "Alpha commitment delivered.",
  sequence: 0,
  metadata: {},
};

const RECORD_B = {
  record_revision_id: "rr_cp3d3_b",
  audit_id: AUDIT_ID,
  record_id: "rec_cp3d3_b",
  privacy_revision_id: PRIVACY_REVISION_ID,
  source_type: "PASTE" as const,
  source_name: "Synthetic Source B",
  author: null,
  timestamp: null,
  sanitized_content: "Beta requirement updated.",
  sequence: 1,
};

const PRIVACY_REVISION = {
  privacy_revision_id: PRIVACY_REVISION_ID,
  audit_id: AUDIT_ID,
  confirmation_state: "CONFIRMED" as const,
  algorithm: "privacy-revision-v1" as const,
  confirmed_at: "2026-09-24T12:00:30.000Z",
  record_count: 2,
  mapping_count: 1,
};

const MAPPING = {
  mapping_id: "map_cp3d3_person_1",
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  entity_type: "PERSON" as const,
  placeholder: "<PERSON_1>",
  original_value: "Synthetic Local Original",
  normalized_key: "synthetic-local-original",
  aliases: ["Synthetic Alias"],
  active: true,
};

const REPORT_V1_CREATED = {
  report_version_id: REPORT_V1,
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  parent_report_version_id: null,
  version_number: 1,
  status: "DRAFT" as const,
  changes_summary: null,
  created_at: "2026-09-24T12:01:00.000Z",
  started_at: null,
  completed_at: null,
};

const REPORT_V2_CREATED = {
  report_version_id: REPORT_V2,
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  parent_report_version_id: REPORT_V1,
  version_number: 2,
  status: "DRAFT" as const,
  changes_summary: "Synthetic V2",
  created_at: "2026-09-24T12:02:00.000Z",
  started_at: null,
  completed_at: null,
};

const REPORT_V3_CREATED = {
  report_version_id: REPORT_V3,
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  parent_report_version_id: REPORT_V2,
  version_number: 3,
  status: "DRAFT" as const,
  changes_summary: "Synthetic V3",
  created_at: "2026-09-24T12:03:00.000Z",
  started_at: null,
  completed_at: null,
};

const V1_STARTED_AT = "2026-09-24T12:01:10.000Z";
const V1_COMPLETED_AT = "2026-09-24T12:01:50.000Z";
const V2_STARTED_AT = "2026-09-24T12:02:10.000Z";
const V2_COMPLETED_AT = "2026-09-24T12:02:50.000Z";
const V3_STARTED_AT = "2026-09-24T12:03:10.000Z";
const V3_COMPLETED_AT = "2026-09-24T12:04:50.000Z";

const EVIDENCE_V1 = {
  evidence_id: "ev_cp3d3_v1",
  report_version_id: REPORT_V1,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_A.record_revision_id,
  record_id: RECORD_A.record_id,
  source_ref: {
    source_name: RECORD_A.source_name,
    sequence: RECORD_A.sequence,
    char_start: 0,
    char_end: 5,
  },
  excerpt: "Alpha",
  actor: "Synthetic Actor",
  timestamp: RECORD_A.timestamp,
  evidence_type: "STATEMENT" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const EVIDENCE_V2 = {
  evidence_id: "ev_cp3d3_v2",
  report_version_id: REPORT_V2,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_A.record_revision_id,
  record_id: RECORD_A.record_id,
  source_ref: {
    source_name: RECORD_A.source_name,
    sequence: RECORD_A.sequence,
    char_start: 6,
    char_end: 16,
  },
  excerpt: "commitment",
  actor: null,
  timestamp: null,
  evidence_type: "STATUS" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const EVIDENCE_V3_A = {
  evidence_id: "ev_cp3d3_v3_a",
  report_version_id: REPORT_V3,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_A.record_revision_id,
  record_id: RECORD_A.record_id,
  source_ref: {
    source_name: RECORD_A.source_name,
    sequence: RECORD_A.sequence,
    char_start: 17,
    char_end: 26,
  },
  excerpt: "delivered",
  actor: null,
  timestamp: null,
  evidence_type: "DELIVERY" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const EVIDENCE_V3_B = {
  evidence_id: "ev_cp3d3_v3_b",
  report_version_id: REPORT_V3,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_A.record_revision_id,
  record_id: RECORD_A.record_id,
  source_ref: {
    source_name: RECORD_A.source_name,
    sequence: RECORD_A.sequence,
    char_start: 0,
    char_end: 5,
  },
  excerpt: "Alpha",
  actor: null,
  timestamp: null,
  evidence_type: "STATEMENT" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const EVIDENCE_V3_C = {
  evidence_id: "ev_cp3d3_v3_c",
  report_version_id: REPORT_V3,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_B.record_revision_id,
  record_id: RECORD_B.record_id,
  source_ref: {
    source_name: RECORD_B.source_name,
    sequence: RECORD_B.sequence,
    char_start: 5,
    char_end: 16,
  },
  excerpt: "requirement",
  actor: null,
  timestamp: null,
  evidence_type: "OTHER" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const COMMITMENT_V1 = {
  commitment_id: "com_cp3d3_v1",
  report_version_id: REPORT_V1,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  actor: "Synthetic Actor",
  action_or_deliverable: "Deliver synthetic V1 artifact",
  evidence_ids: [EVIDENCE_V1.evidence_id],
  deadline: null,
  condition: null,
  recipient: null,
  lifecycle_status: "OPEN" as const,
  supersedes_commitment_id: null,
  status_evidence_ids: [],
};

const COMMITMENT_V2 = {
  commitment_id: "com_cp3d3_v2",
  report_version_id: REPORT_V2,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  actor: "Synthetic Actor",
  action_or_deliverable: "Deliver synthetic V2 artifact",
  evidence_ids: [EVIDENCE_V2.evidence_id],
  deadline: null,
  condition: null,
  recipient: null,
  lifecycle_status: "MODIFIED" as const,
  supersedes_commitment_id: COMMITMENT_V1.commitment_id,
  status_evidence_ids: [EVIDENCE_V2.evidence_id],
};

const COMMITMENT_V3 = {
  commitment_id: "com_cp3d3_v3",
  report_version_id: REPORT_V3,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  actor: "Synthetic Actor",
  action_or_deliverable: "Deliver synthetic V3 artifact",
  evidence_ids: [EVIDENCE_V3_B.evidence_id],
  deadline: "2026-10-03",
  condition: null,
  recipient: "Synthetic Recipient",
  lifecycle_status: "MODIFIED" as const,
  supersedes_commitment_id: COMMITMENT_V2.commitment_id,
  status_evidence_ids: [EVIDENCE_V3_A.evidence_id],
};

const CHANGE_V1 = {
  change_id: "chg_cp3d3_v1",
  report_version_id: REPORT_V1,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  change_type: "MODIFY" as const,
  subject: "Synthetic V1 requirement",
  before_summary: "Synthetic before",
  after_summary: "Synthetic after",
  evidence_ids: [EVIDENCE_V1.evidence_id],
  timestamp: null,
};

const CHANGE_V3 = {
  change_id: "chg_cp3d3_v3",
  report_version_id: REPORT_V3,
  classification: "CANDIDATE" as const,
  epistemic_status: "INFERENCE" as const,
  change_type: "CLARIFY" as const,
  subject: "Synthetic V3 clarification",
  before_summary: null,
  after_summary: "Synthetic candidate clarification",
  evidence_ids: [EVIDENCE_V3_C.evidence_id],
  timestamp: "2026-09-24T12:03:30.000Z",
};

const CONFLICT_V1 = {
  conflict_id: "cfl_cp3d3_v1",
  report_version_id: REPORT_V1,
  conflict_type: "POTENTIAL_CONFLICT" as const,
  claim_a: { text: "Synthetic V1 claim A", evidence_ids: [EVIDENCE_V1.evidence_id] },
  claim_b: { text: "Synthetic V1 claim B", evidence_ids: [EVIDENCE_V1.evidence_id] },
  comparable_context: {
    subject: "Synthetic V1 subject",
    time_context: null,
    version_context: "V1",
    condition_context: null,
  },
  conflict_reason: "Synthetic V1 potential conflict.",
  counter_evidence_ids: [],
  alternative_explanations: [
    { text: "Synthetic V1 alternative", epistemic_status: "INFERENCE" as const },
  ],
  missing_evidence: [],
  epistemic_status: "INFERENCE" as const,
  conflicted: true as const,
};

const CONFLICT_V3 = {
  conflict_id: "cfl_cp3d3_v3",
  report_version_id: REPORT_V3,
  conflict_type: "POTENTIAL_CONFLICT" as const,
  claim_a: { text: "Synthetic V3 claim A", evidence_ids: [EVIDENCE_V3_B.evidence_id] },
  claim_b: { text: "Synthetic V3 claim B", evidence_ids: [EVIDENCE_V3_C.evidence_id] },
  comparable_context: {
    subject: "Synthetic V3 subject",
    time_context: null,
    version_context: "V3",
    condition_context: null,
  },
  conflict_reason: "Synthetic V3 potential conflict.",
  counter_evidence_ids: [EVIDENCE_V3_A.evidence_id],
  alternative_explanations: [
    { text: "Synthetic V3 alternative", epistemic_status: "INFERENCE" as const },
  ],
  missing_evidence: ["Synthetic V3 missing item"],
  epistemic_status: "UNKNOWN" as const,
  conflicted: true as const,
};

const RETRY_EVIDENCE = {
  evidence_id: "ev_cp3d3_retry",
  report_version_id: REPORT_V3,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_B.record_revision_id,
  record_id: RECORD_B.record_id,
  source_ref: {
    source_name: RECORD_B.source_name,
    sequence: RECORD_B.sequence,
    char_start: 17,
    char_end: 24,
  },
  excerpt: "updated",
  actor: null,
  timestamp: null,
  evidence_type: "STATUS" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const RETRY_COMMITMENT = {
  commitment_id: "com_cp3d3_retry",
  report_version_id: REPORT_V3,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  actor: "Synthetic Actor",
  action_or_deliverable: "Deliver synthetic recovery artifact",
  evidence_ids: [RETRY_EVIDENCE.evidence_id],
  deadline: null,
  condition: null,
  recipient: null,
  lifecycle_status: "MODIFIED" as const,
  supersedes_commitment_id: COMMITMENT_V3.commitment_id,
  status_evidence_ids: [RETRY_EVIDENCE.evidence_id],
};

const RETRY_CHANGE = {
  change_id: "chg_cp3d3_retry",
  report_version_id: REPORT_V3,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  change_type: "MODIFY" as const,
  subject: "Synthetic recovery requirement",
  before_summary: "Synthetic recovery before",
  after_summary: "Synthetic recovery after",
  evidence_ids: [RETRY_EVIDENCE.evidence_id],
  timestamp: null,
};

const RETRY_CONFLICT_VALID = {
  conflict_id: "cfl_cp3d3_retry",
  report_version_id: REPORT_V3,
  conflict_type: "POTENTIAL_CONFLICT" as const,
  claim_a: { text: "Synthetic recovery claim A", evidence_ids: [RETRY_EVIDENCE.evidence_id] },
  claim_b: { text: "Synthetic recovery claim B", evidence_ids: [RETRY_EVIDENCE.evidence_id] },
  comparable_context: {
    subject: "Synthetic recovery subject",
    time_context: null,
    version_context: "V3 recovery",
    condition_context: null,
  },
  conflict_reason: "Synthetic recovery potential conflict.",
  counter_evidence_ids: [RETRY_EVIDENCE.evidence_id],
  alternative_explanations: [
    { text: "Synthetic recovery alternative", epistemic_status: "INFERENCE" as const },
  ],
  missing_evidence: [],
  epistemic_status: "INFERENCE" as const,
  conflicted: true as const,
};

const RETRY_CONFLICT_INVALID = {
  ...RETRY_CONFLICT_VALID,
  counter_evidence_ids: ["ev_cp3d3_missing"],
};

const PROVIDER_AUDIT = {
  provider_call_id: "pcall_cp3d3_1",
  audit_id: AUDIT_ID,
  report_version_id: null,
  stage: "SYNTHETIC_AUDIT_STAGE",
  provider_name: "Synthetic Provider",
  model_name: "Synthetic Model",
  started_at: "2026-09-24T12:30:01.000Z",
  completed_at: null,
  latency_ms: null,
  status: "NO_CALL_REQUIRED",
  input_record_count: null,
  input_size_chars: null,
  input_tokens: null,
  output_tokens: null,
  total_tokens: null,
  cost_amount_micros: null,
  cost_currency: null,
  retry_count: 0,
  schema_valid: null,
  error_category: null,
  output_counts: null,
};

const PROVIDER_V1 = {
  provider_call_id: "pcall_cp3d3_2",
  audit_id: AUDIT_ID,
  report_version_id: REPORT_V1,
  stage: "SYNTHETIC_V1_STAGE",
  provider_name: "Synthetic Provider",
  model_name: "Synthetic Model",
  started_at: "2026-09-24T12:30:02.000Z",
  completed_at: "2026-09-24T12:30:02.250Z",
  latency_ms: 250,
  status: "SUCCESS",
  input_record_count: 2,
  input_size_chars: 53,
  input_tokens: 20,
  output_tokens: 10,
  total_tokens: 30,
  cost_amount_micros: 25,
  cost_currency: "USD",
  retry_count: 0,
  schema_valid: true,
  error_category: null,
  output_counts: { evidence: 1, commitments: 1, changes: 1, conflicts: 1, unknown: 0 },
};

const PROVIDER_V3 = {
  provider_call_id: "pcall_cp3d3_3",
  audit_id: AUDIT_ID,
  report_version_id: REPORT_V3,
  stage: "SYNTHETIC_V3_STAGE",
  provider_name: "Synthetic Provider",
  model_name: "Synthetic Model",
  started_at: "2026-09-24T12:30:03.000Z",
  completed_at: "2026-09-24T12:30:03.500Z",
  latency_ms: 500,
  status: "SUCCESS",
  input_record_count: 2,
  input_size_chars: 53,
  input_tokens: 30,
  output_tokens: 15,
  total_tokens: 45,
  cost_amount_micros: 35,
  cost_currency: "USD",
  retry_count: 1,
  schema_valid: true,
  error_category: null,
  output_counts: { evidence: 3, commitments: 1, changes: 1, conflicts: 1, unknown: 0 },
};

const TABLES = [
  "audits",
  "privacy_revisions",
  "canonical_records",
  "privacy_mappings",
  "report_versions",
  "evidence",
  "commitments",
  "changes",
  "conflicts",
  "provider_calls",
] as const;

function createFormalFixtureSchema(connection: PersistenceConnection): void {
  connection.sqlite.exec(`
    CREATE TABLE audits (
      audit_id TEXT PRIMARY KEY NOT NULL,
      revision_salt TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE privacy_revisions (
      privacy_revision_id TEXT PRIMARY KEY NOT NULL,
      audit_id TEXT NOT NULL,
      algorithm TEXT NOT NULL,
      confirmed_at TEXT NOT NULL,
      record_count INTEGER NOT NULL CHECK(record_count > 0),
      mapping_count INTEGER NOT NULL CHECK(mapping_count >= 0),
      FOREIGN KEY (audit_id) REFERENCES audits(audit_id) ON DELETE RESTRICT,
      UNIQUE (audit_id, privacy_revision_id)
    );

    CREATE TABLE canonical_records (
      record_revision_id TEXT PRIMARY KEY NOT NULL,
      audit_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      privacy_revision_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_name TEXT NOT NULL,
      author TEXT,
      timestamp TEXT,
      sanitized_content TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence >= 0),
      metadata_json TEXT,
      FOREIGN KEY (audit_id, privacy_revision_id)
        REFERENCES privacy_revisions(audit_id, privacy_revision_id) ON DELETE RESTRICT,
      UNIQUE (audit_id, record_id, privacy_revision_id),
      UNIQUE (record_revision_id, privacy_revision_id, record_id, source_name, sequence)
    );

    CREATE TABLE privacy_mappings (
      mapping_id TEXT NOT NULL,
      audit_id TEXT NOT NULL,
      privacy_revision_id TEXT NOT NULL,
      entity_type TEXT NOT NULL CHECK(entity_type <> 'SECRET'),
      placeholder TEXT NOT NULL,
      original_value TEXT NOT NULL,
      normalized_key TEXT NOT NULL,
      aliases_json TEXT NOT NULL,
      active INTEGER NOT NULL CHECK(active IN (0, 1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (audit_id, privacy_revision_id, entity_type, placeholder),
      FOREIGN KEY (audit_id, privacy_revision_id)
        REFERENCES privacy_revisions(audit_id, privacy_revision_id) ON DELETE RESTRICT
    );

    CREATE TABLE report_versions (
      report_version_id TEXT PRIMARY KEY NOT NULL,
      audit_id TEXT NOT NULL,
      privacy_revision_id TEXT NOT NULL,
      parent_report_version_id TEXT,
      version_number INTEGER NOT NULL CHECK(version_number > 0),
      status TEXT NOT NULL CHECK(status IN ('DRAFT', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')),
      changes_summary TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      FOREIGN KEY (audit_id, privacy_revision_id)
        REFERENCES privacy_revisions(audit_id, privacy_revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (parent_report_version_id, audit_id)
        REFERENCES report_versions(report_version_id, audit_id) ON DELETE RESTRICT,
      UNIQUE (audit_id, version_number),
      UNIQUE (report_version_id, privacy_revision_id),
      UNIQUE (report_version_id, audit_id)
    );

    CREATE TABLE evidence (
      evidence_id TEXT PRIMARY KEY NOT NULL,
      report_version_id TEXT NOT NULL,
      privacy_revision_id TEXT NOT NULL,
      record_revision_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      source_name TEXT NOT NULL,
      source_sequence INTEGER NOT NULL CHECK(source_sequence >= 0),
      char_start INTEGER NOT NULL CHECK(char_start >= 0),
      char_end INTEGER NOT NULL,
      excerpt TEXT NOT NULL,
      actor TEXT,
      timestamp TEXT,
      evidence_type TEXT NOT NULL CHECK(evidence_type IN ('STATEMENT', 'STATUS', 'DECISION', 'DELIVERY', 'OTHER')),
      epistemic_status TEXT NOT NULL CHECK(epistemic_status = 'FACT'),
      fact_scope TEXT NOT NULL CHECK(fact_scope = 'SOURCE_FACT'),
      FOREIGN KEY (report_version_id, privacy_revision_id)
        REFERENCES report_versions(report_version_id, privacy_revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (record_revision_id, privacy_revision_id, record_id, source_name, source_sequence)
        REFERENCES canonical_records(record_revision_id, privacy_revision_id, record_id, source_name, sequence) ON DELETE RESTRICT,
      CHECK(char_end > char_start)
    );

    CREATE TABLE commitments (
      commitment_id TEXT PRIMARY KEY NOT NULL,
      report_version_id TEXT NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('CANDIDATE', 'CONFIRMED')),
      epistemic_status TEXT NOT NULL,
      actor TEXT,
      action_or_deliverable TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      deadline TEXT,
      condition TEXT,
      recipient TEXT,
      lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('OPEN', 'FULFILLED', 'MODIFIED', 'WITHDRAWN', 'SUPERSEDED', 'UNKNOWN')),
      supersedes_commitment_id TEXT,
      status_evidence_ids_json TEXT NOT NULL,
      FOREIGN KEY (report_version_id) REFERENCES report_versions(report_version_id) ON DELETE RESTRICT,
      FOREIGN KEY (supersedes_commitment_id) REFERENCES commitments(commitment_id) ON DELETE RESTRICT,
      CHECK((classification = 'CONFIRMED' AND epistemic_status = 'FACT') OR
            (classification = 'CANDIDATE' AND epistemic_status IN ('INFERENCE', 'UNKNOWN')))
    );

    CREATE TABLE changes (
      change_id TEXT PRIMARY KEY NOT NULL,
      report_version_id TEXT NOT NULL,
      classification TEXT NOT NULL CHECK(classification IN ('CANDIDATE', 'CONFIRMED')),
      epistemic_status TEXT NOT NULL,
      change_type TEXT NOT NULL CHECK(change_type IN ('NEW', 'MODIFY', 'REPLACE', 'WITHDRAW', 'CLARIFY')),
      subject TEXT NOT NULL,
      before_summary TEXT,
      after_summary TEXT NOT NULL,
      evidence_ids_json TEXT NOT NULL,
      timestamp TEXT,
      FOREIGN KEY (report_version_id) REFERENCES report_versions(report_version_id) ON DELETE RESTRICT,
      CHECK((classification = 'CONFIRMED' AND epistemic_status = 'FACT') OR
            (classification = 'CANDIDATE' AND epistemic_status IN ('INFERENCE', 'UNKNOWN')))
    );

    CREATE TABLE conflicts (
      conflict_id TEXT PRIMARY KEY NOT NULL,
      report_version_id TEXT NOT NULL,
      conflict_type TEXT NOT NULL CHECK(conflict_type = 'POTENTIAL_CONFLICT'),
      claim_a_text TEXT NOT NULL,
      claim_a_evidence_ids_json TEXT NOT NULL,
      claim_b_text TEXT NOT NULL,
      claim_b_evidence_ids_json TEXT NOT NULL,
      comparable_subject TEXT NOT NULL,
      comparable_time_context TEXT,
      comparable_version_context TEXT,
      comparable_condition_context TEXT,
      conflict_reason TEXT NOT NULL,
      counter_evidence_ids_json TEXT NOT NULL,
      alternative_explanations_json TEXT NOT NULL,
      missing_evidence_json TEXT NOT NULL,
      epistemic_status TEXT NOT NULL CHECK(epistemic_status IN ('INFERENCE', 'UNKNOWN')),
      conflicted INTEGER NOT NULL CHECK(conflicted = 1),
      FOREIGN KEY (report_version_id) REFERENCES report_versions(report_version_id) ON DELETE RESTRICT
    );

    CREATE TABLE provider_calls (
      provider_call_id TEXT PRIMARY KEY NOT NULL,
      audit_id TEXT NOT NULL,
      report_version_id TEXT,
      stage TEXT NOT NULL,
      provider_name TEXT NOT NULL,
      model_name TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      latency_ms INTEGER CHECK(latency_ms >= 0),
      status TEXT NOT NULL,
      input_record_count INTEGER CHECK(input_record_count >= 0),
      input_size_chars INTEGER CHECK(input_size_chars >= 0),
      input_tokens INTEGER CHECK(input_tokens >= 0),
      output_tokens INTEGER CHECK(output_tokens >= 0),
      total_tokens INTEGER CHECK(total_tokens >= 0),
      cost_amount_micros INTEGER CHECK(cost_amount_micros >= 0),
      cost_currency TEXT,
      retry_count INTEGER NOT NULL CHECK(retry_count >= 0),
      schema_valid INTEGER CHECK(schema_valid IN (0, 1)),
      error_category TEXT,
      output_counts_json TEXT,
      FOREIGN KEY (audit_id) REFERENCES audits(audit_id) ON DELETE RESTRICT,
      FOREIGN KEY (report_version_id, audit_id)
        REFERENCES report_versions(report_version_id, audit_id) ON DELETE RESTRICT
    );
  `);
}

function repositories(connection: PersistenceConnection) {
  return {
    audits: new AuditRepository(connection),
    privacy: new PrivacyRepository(connection, () => "2026-09-24T12:00:45.000Z"),
    reports: new ReportVersionRepository(connection),
    evidence: new EvidenceRepository(connection),
    commitments: new CommitmentRepository(connection),
    changes: new ChangeRepository(connection),
    conflicts: new ConflictRepository(connection),
    content: new ReportContentRepository(connection),
    providerCalls: new ProviderCallRepository(connection),
  };
}

function privacyAggregate() {
  return {
    revision: PRIVACY_REVISION,
    records: [RECORD_A, RECORD_B],
    mappings: [MAPPING],
  };
}

function v1Content() {
  return {
    report_version_id: REPORT_V1,
    evidence: [EVIDENCE_V1],
    commitments: [COMMITMENT_V1],
    changes: [CHANGE_V1],
    conflicts: [CONFLICT_V1],
    completeReport: true,
    completionTimestamp: V1_COMPLETED_AT,
  };
}

function v2Content() {
  return {
    report_version_id: REPORT_V2,
    evidence: [EVIDENCE_V2],
    commitments: [COMMITMENT_V2],
    changes: [],
    conflicts: [],
    completeReport: true,
    completionTimestamp: V2_COMPLETED_AT,
  };
}

function v3BaselineContent() {
  return {
    report_version_id: REPORT_V3,
    // Intentionally scrambled. Repository read order must be deterministic.
    evidence: [EVIDENCE_V3_C, EVIDENCE_V3_A, EVIDENCE_V3_B],
    commitments: [COMMITMENT_V3],
    changes: [CHANGE_V3],
    conflicts: [CONFLICT_V3],
    completeReport: false,
  };
}

function recoveryContent(validConflict: boolean, completeReport: boolean) {
  return {
    report_version_id: REPORT_V3,
    evidence: [RETRY_EVIDENCE],
    commitments: [RETRY_COMMITMENT],
    changes: [RETRY_CHANGE],
    conflicts: [validConflict ? RETRY_CONFLICT_VALID : RETRY_CONFLICT_INVALID],
    completeReport,
    ...(completeReport ? { completionTimestamp: V3_COMPLETED_AT } : {}),
  };
}

function transition(
  connection: PersistenceConnection,
  reports: ReportVersionRepository,
  reportVersionId: string,
  target: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
  at: string,
) {
  return connection.transaction(() => reports.transitionLifecycle(reportVersionId, target, at));
}

function writeIntegratedFixture(connection: PersistenceConnection): void {
  const repo = repositories(connection);

  repo.audits.createAudit({
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: "2026-09-24T12:00:00.000Z",
  });
  repo.privacy.saveConfirmedPrivacyAggregate(privacyAggregate());

  repo.reports.createReportVersion(REPORT_V1_CREATED);
  transition(connection, repo.reports, REPORT_V1, "RUNNING", V1_STARTED_AT);
  repo.content.persistReportContent(v1Content());

  repo.reports.createReportVersion(REPORT_V2_CREATED);
  transition(connection, repo.reports, REPORT_V2, "RUNNING", V2_STARTED_AT);
  repo.content.persistReportContent(v2Content());

  repo.reports.createReportVersion(REPORT_V3_CREATED);
  transition(connection, repo.reports, REPORT_V3, "RUNNING", V3_STARTED_AT);
  repo.content.persistReportContent(v3BaselineContent());

  // Intentionally scrambled ProviderCall insertion order: #3, #1, #2.
  repo.providerCalls.insertProviderCall(PROVIDER_V3);
  repo.providerCalls.insertProviderCall(PROVIDER_AUDIT);
  repo.providerCalls.insertProviderCall(PROVIDER_V1);
}

function replayImmutableBatch(connection: PersistenceConnection): void {
  const repo = repositories(connection);
  repo.audits.createAudit({
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: "2026-09-24T12:00:00.000Z",
  });
  repo.privacy.saveConfirmedPrivacyAggregate(privacyAggregate());
  repo.content.persistReportContent(v3BaselineContent());
  repo.providerCalls.insertProviderCall(PROVIDER_AUDIT);
  repo.providerCalls.insertProviderCall(PROVIDER_V3);
}

function readRepositorySnapshot(connection: PersistenceConnection) {
  const repo = repositories(connection);
  return {
    auditSafe: repo.audits.getAuditById(AUDIT_ID),
    auditLocal: repo.audits.getAuditLocalIdentity(AUDIT_ID),
    privacyLocal: repo.privacy.getConfirmedPrivacyAggregateLocal(PRIVACY_REVISION_ID),
    reports: repo.reports.getReportVersionsByAudit(AUDIT_ID),
    evidenceV1: repo.evidence.getEvidenceByReportVersion(REPORT_V1),
    evidenceV2: repo.evidence.getEvidenceByReportVersion(REPORT_V2),
    evidenceV3: repo.evidence.getEvidenceByReportVersion(REPORT_V3),
    commitmentsV1: repo.commitments.getCommitmentsByReportVersion(REPORT_V1),
    commitmentsV2: repo.commitments.getCommitmentsByReportVersion(REPORT_V2),
    commitmentsV3: repo.commitments.getCommitmentsByReportVersion(REPORT_V3),
    changesV1: repo.changes.getChangesByReportVersion(REPORT_V1),
    changesV2: repo.changes.getChangesByReportVersion(REPORT_V2),
    changesV3: repo.changes.getChangesByReportVersion(REPORT_V3),
    conflictsV1: repo.conflicts.getConflictsByReportVersion(REPORT_V1),
    conflictsV2: repo.conflicts.getConflictsByReportVersion(REPORT_V2),
    conflictsV3: repo.conflicts.getConflictsByReportVersion(REPORT_V3),
    providerAudit: repo.providerCalls.getProviderCallsByAudit(AUDIT_ID),
    providerV1: repo.providerCalls.getProviderCallsByReportVersion(REPORT_V1),
    providerV3: repo.providerCalls.getProviderCallsByReportVersion(REPORT_V3),
  };
}

function rowCounts(connection: PersistenceConnection): Record<(typeof TABLES)[number], number> {
  return Object.fromEntries(
    TABLES.map((table) => {
      const row = connection.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count: number;
      };
      return [table, row.count];
    }),
  ) as Record<(typeof TABLES)[number], number>;
}

function countById(connection: PersistenceConnection, table: string, idColumn: string, id: string): number {
  const row = connection.sqlite
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${idColumn} = ?`)
    .get(id) as { count: number };
  return row.count;
}

function expectPersistenceCode(code: string) {
  return (error: unknown): boolean => error instanceof PersistenceError && error.code === code;
}

function tableColumns(connection: PersistenceConnection, table: string): readonly string[] {
  return (connection.sqlite.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
}

function assertProviderCallPersistenceMetadataOnly(connection: PersistenceConnection): void {
  const forbidden = [
    "prompt",
    "raw",
    "request",
    "response",
    "authorization",
    "api_key",
    "secret",
    "mapping",
    "original_value",
    "revision_salt",
  ];
  const columns = tableColumns(connection, "provider_calls").map((value) => value.toLowerCase());
  for (const token of forbidden) {
    assert.equal(columns.some((column) => column.includes(token)), false, `provider_calls column leaked ${token}`);
  }

  const rows = connection.sqlite.prepare("SELECT * FROM provider_calls ORDER BY provider_call_id").all() as Record<string, unknown>[];
  for (const row of rows) {
    const keys = Object.keys(row).map((key) => key.toLowerCase());
    for (const token of forbidden) {
      assert.equal(keys.some((key) => key.includes(token)), false, `ProviderCall row key leaked ${token}`);
    }
  }
}

test("DEV03 CP-3D3: integrated persistence resilience", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dev03-cp3d3-"));
  const databasePath = join(directory, "integrated-resilience.sqlite");
  let initialConnection: PersistenceConnection | undefined;
  let finalConnection: PersistenceConnection | undefined;

  try {
    initialConnection = openPersistenceConnection(databasePath);
    createFormalFixtureSchema(initialConnection);
    writeIntegratedFixture(initialConnection);

    const initialState = readRepositorySnapshot(initialConnection);
    const baselineCounts = rowCounts(initialConnection);

    await t.test("1. 10-table integrated fixture is fully populated", () => {
      for (const table of TABLES) {
        assert.ok(baselineCounts[table] > 0, `${table} must contain integrated fixture rows`);
      }
      assert.equal(initialState.reports[0]?.status, "COMPLETED");
      assert.equal(initialState.reports[1]?.status, "COMPLETED");
      assert.equal(initialState.reports[2]?.status, "RUNNING");
    });

    for (let iteration = 0; iteration < REPLAY_ITERATIONS; iteration += 1) {
      replayImmutableBatch(initialConnection);
    }
    const replayState = readRepositorySnapshot(initialConnection);
    const replayCounts = rowCounts(initialConnection);

    await t.test("2. 20x immutable identical replay completes without errors", () => {
      assert.equal(REPLAY_ITERATIONS, 20);
    });

    await t.test("3. repeated replay causes zero row-count growth", () => {
      assert.deepEqual(replayCounts, baselineCounts);
    });

    await t.test("4. repeated replay preserves complete Repository semantic equality", () => {
      assert.deepEqual(replayState, initialState);
    });

    initialConnection.close();
    initialConnection = undefined;

    const reopenForeignKeys: number[] = [];
    const assertReopenCycle = (cycle: number): void => {
      const connection = openPersistenceConnection(databasePath);
      try {
        reopenForeignKeys.push(Number(connection.sqlite.pragma("foreign_keys", { simple: true })));
        assert.deepEqual(readRepositorySnapshot(connection), initialState);
        assert.deepEqual(rowCounts(connection), baselineCounts);
      } finally {
        connection.close();
      }
    };

    await t.test("5. reopen cycle #1 recreates repositories and preserves state", () => assertReopenCycle(1));
    await t.test("6. reopen cycle #2 recreates repositories and preserves state", () => assertReopenCycle(2));
    await t.test("7. reopen cycle #3 recreates repositories and preserves state", () => assertReopenCycle(3));
    await t.test("8. reopen cycle #4 recreates repositories and preserves state", () => assertReopenCycle(4));
    await t.test("9. reopen cycle #5 recreates repositories and preserves state", () => assertReopenCycle(5));

    await t.test("10. foreign_keys is enabled on every reopened persistence connection", () => {
      assert.equal(reopenForeignKeys.length, REOPEN_CYCLE_COUNT);
      assert.deepEqual(reopenForeignKeys, Array(REOPEN_CYCLE_COUNT).fill(1));
    });

    await t.test("11. scrambled Evidence insertion still reads in frozen deterministic order", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const evidence = repositories(connection).evidence.getEvidenceByReportVersion(REPORT_V3);
        assert.deepEqual(
          evidence.map((item) => item.evidence_id),
          [EVIDENCE_V3_B.evidence_id, EVIDENCE_V3_A.evidence_id, EVIDENCE_V3_C.evidence_id],
        );
      } finally {
        connection.close();
      }
    });

    await t.test("12. scrambled ProviderCall insertion still reads in started_at/id order", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const calls = repositories(connection).providerCalls.getProviderCallsByAudit(AUDIT_ID);
        assert.deepEqual(
          calls.map((item) => item.provider_call_id),
          [PROVIDER_AUDIT.provider_call_id, PROVIDER_V1.provider_call_id, PROVIDER_V3.provider_call_id],
        );
      } finally {
        connection.close();
      }
    });

    await t.test("13. V1 -> V2 -> V3 ReportVersion lineage survives repeated reopen", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const reports = repositories(connection).reports.getReportVersionsByAudit(AUDIT_ID);
        assert.equal(reports[0]?.parent_report_version_id, null);
        assert.equal(reports[1]?.parent_report_version_id, REPORT_V1);
        assert.equal(reports[2]?.parent_report_version_id, REPORT_V2);
      } finally {
        connection.close();
      }
    });

    await t.test("14. multi-generation Commitment supersession lineage remains stable", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const repo = repositories(connection);
        const v2 = repo.commitments.getCommitmentsByReportVersion(REPORT_V2);
        const v3 = repo.commitments.getCommitmentsByReportVersion(REPORT_V3);
        assert.equal(v2[0]?.supersedes_commitment_id, COMMITMENT_V1.commitment_id);
        assert.equal(v3[0]?.supersedes_commitment_id, COMMITMENT_V2.commitment_id);
      } finally {
        connection.close();
      }
    });

    await t.test("15. ReportContent intentional Conflict failure rolls back all new V3 rows", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const beforeCounts = rowCounts(connection);
        const repo = repositories(connection);
        assert.throws(
          () => repo.content.persistReportContent(recoveryContent(false, false)),
          expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
        );
        assert.deepEqual(rowCounts(connection), beforeCounts);
        assert.equal(repo.reports.getReportVersionById(REPORT_V3).status, "RUNNING");
        assert.equal(countById(connection, "evidence", "evidence_id", RETRY_EVIDENCE.evidence_id), 0);
        assert.equal(countById(connection, "commitments", "commitment_id", RETRY_COMMITMENT.commitment_id), 0);
        assert.equal(countById(connection, "changes", "change_id", RETRY_CHANGE.change_id), 0);
        assert.equal(countById(connection, "conflicts", "conflict_id", RETRY_CONFLICT_VALID.conflict_id), 0);
      } finally {
        connection.close();
      }
    });

    await t.test("16. close/reopen after rollback shows zero failed-write residue and V3 remains RUNNING", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const repo = repositories(connection);
        assert.equal(repo.reports.getReportVersionById(REPORT_V3).status, "RUNNING");
        assert.equal(countById(connection, "evidence", "evidence_id", RETRY_EVIDENCE.evidence_id), 0);
        assert.equal(countById(connection, "commitments", "commitment_id", RETRY_COMMITMENT.commitment_id), 0);
        assert.equal(countById(connection, "changes", "change_id", RETRY_CHANGE.change_id), 0);
        assert.equal(countById(connection, "conflicts", "conflict_id", RETRY_CONFLICT_VALID.conflict_id), 0);
      } finally {
        connection.close();
      }
    });

    let postRetryCounts: ReturnType<typeof rowCounts> | undefined;
    await t.test("17. corrected retry succeeds and atomically completes V3", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const repo = repositories(connection);
        const result = repo.content.persistReportContent(recoveryContent(true, true));
        assert.equal(result.report.status, "COMPLETED");
        assert.equal(countById(connection, "evidence", "evidence_id", RETRY_EVIDENCE.evidence_id), 1);
        assert.equal(countById(connection, "commitments", "commitment_id", RETRY_COMMITMENT.commitment_id), 1);
        assert.equal(countById(connection, "changes", "change_id", RETRY_CHANGE.change_id), 1);
        assert.equal(countById(connection, "conflicts", "conflict_id", RETRY_CONFLICT_VALID.conflict_id), 1);
        postRetryCounts = rowCounts(connection);
      } finally {
        connection.close();
      }
    });

    await t.test("18. close/reopen after successful retry preserves completed recovery snapshot", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const repo = repositories(connection);
        assert.equal(repo.reports.getReportVersionById(REPORT_V3).status, "COMPLETED");
        assert.equal(countById(connection, "evidence", "evidence_id", RETRY_EVIDENCE.evidence_id), 1);
        assert.equal(countById(connection, "commitments", "commitment_id", RETRY_COMMITMENT.commitment_id), 1);
        assert.equal(countById(connection, "changes", "change_id", RETRY_CHANGE.change_id), 1);
        assert.equal(countById(connection, "conflicts", "conflict_id", RETRY_CONFLICT_VALID.conflict_id), 1);
        assert.deepEqual(rowCounts(connection), postRetryCounts);
      } finally {
        connection.close();
      }
    });

    await t.test("27. Audit-level ProviderCall replay remains idempotent with no row growth", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const repo = repositories(connection);
        const before = rowCounts(connection).provider_calls;
        const result = repo.providerCalls.insertProviderCall(PROVIDER_AUDIT);
        assert.equal(result.outcome, "IDEMPOTENT_EXISTING");
        assert.equal(rowCounts(connection).provider_calls, before);
      } finally {
        connection.close();
      }
    });

    await t.test("28. Report-level ProviderCall replay remains idempotent with no row growth", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const repo = repositories(connection);
        const before = rowCounts(connection).provider_calls;
        const result = repo.providerCalls.insertProviderCall(PROVIDER_V3);
        assert.equal(result.outcome, "IDEMPOTENT_EXISTING");
        assert.equal(rowCounts(connection).provider_calls, before);
      } finally {
        connection.close();
      }
    });

    await t.test("29. terminal COMPLETED Report rejects semantic replay write", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const repo = repositories(connection);
        const before = rowCounts(connection);
        assert.throws(
          () => repo.content.persistReportContent(v3BaselineContent()),
          expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
        );
        assert.deepEqual(rowCounts(connection), before);
        assert.equal(repo.reports.getReportVersionById(REPORT_V3).status, "COMPLETED");
      } finally {
        connection.close();
      }
    });

    await t.test("30. terminal Report remains unchanged after another close/reopen", () => {
      const connection = openPersistenceConnection(databasePath);
      try {
        const report = repositories(connection).reports.getReportVersionById(REPORT_V3);
        assert.equal(report.status, "COMPLETED");
        assert.equal(report.started_at, V3_STARTED_AT);
        assert.equal(report.completed_at, V3_COMPLETED_AT);
      } finally {
        connection.close();
      }
    });

    finalConnection = openPersistenceConnection(databasePath);

    await t.test("31. Privacy confirmation keeps privacy_revisions.confirmed_at as single persisted SOT", () => {
      const privacyColumns = tableColumns(finalConnection!, "privacy_revisions");
      assert.ok(privacyColumns.includes("confirmed_at"));
      for (const forbidden of ["confirmed", "is_confirmed", "confirmation_state", "confirmed_flag"]) {
        assert.equal(privacyColumns.includes(forbidden), false);
      }
      assert.equal(
        repositories(finalConnection!).privacy.getConfirmedPrivacyRevision(PRIVACY_REVISION_ID).confirmed_at,
        PRIVACY_REVISION.confirmed_at,
      );
    });

    await t.test("32. exact input snapshot remains privacy_revision_id -> canonical_records single SOT", () => {
      const reportColumns = tableColumns(finalConnection!, "report_versions");
      for (const forbidden of ["input_record_revision_ids", "record_revision_ids", "snapshot_record_ids"]) {
        assert.equal(reportColumns.includes(forbidden), false);
      }
      const snapshot = repositories(finalConnection!).privacy.getCanonicalRecordsByPrivacyRevision(PRIVACY_REVISION_ID);
      assert.deepEqual(snapshot.map((record) => record.record_revision_id), [RECORD_A.record_revision_id, RECORD_B.record_revision_id]);
    });

    await t.test("33. ProviderCall sensitive-persistence scan remains metadata-only", () => {
      assertProviderCallPersistenceMetadataOnly(finalConnection!);
    });

    await t.test("34. PRAGMA integrity_check returns ok after replay/reopen/recovery", () => {
      assert.equal(finalConnection!.sqlite.pragma("integrity_check", { simple: true }), "ok");
    });

    await t.test("35. PRAGMA foreign_key_check reports zero violations", () => {
      const violations = finalConnection!.sqlite.pragma("foreign_key_check") as unknown[];
      assert.deepEqual(violations, []);
    });

    await t.test("36. final 10-table row-count audit contains only successful writes", () => {
      assert.ok(postRetryCounts);
      const beforeRepeatedReads = rowCounts(finalConnection!);
      for (let i = 0; i < 5; i += 1) {
        readRepositorySnapshot(finalConnection!);
      }
      const afterRepeatedReads = rowCounts(finalConnection!);
      assert.deepEqual(beforeRepeatedReads, postRetryCounts);
      assert.deepEqual(afterRepeatedReads, postRetryCounts);
    });
  } finally {
    if (initialConnection?.sqlite.open) initialConnection.close();
    if (finalConnection?.sqlite.open) finalConnection.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
