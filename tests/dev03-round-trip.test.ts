import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openPersistenceConnection, type PersistenceConnection } from "../src/db/connection.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { ChangeRepository } from "../src/db/repositories/change-repository.js";
import { CommitmentRepository } from "../src/db/repositories/commitment-repository.js";
import { ConflictRepository } from "../src/db/repositories/conflict-repository.js";
import { EvidenceRepository } from "../src/db/repositories/evidence-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";
import { ProviderCallRepository } from "../src/db/repositories/provider-call-repository.js";
import { ReportContentRepository } from "../src/db/repositories/report-content-repository.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";

const AUDIT_ID = "aud_cp3d1";
const PRIVACY_REVISION_ID = "prv_cp3d1";
const REPORT_V1 = "rpt_cp3d1_v1";
const REPORT_V2 = "rpt_cp3d1_v2";
const REVISION_SALT = Buffer.alloc(32, 0x5a).toString("base64url");

const RECORD_A = {
  record_revision_id: "rr_cp3d1_a",
  audit_id: AUDIT_ID,
  record_id: "rec_cp3d1_a",
  privacy_revision_id: PRIVACY_REVISION_ID,
  source_type: "PASTE" as const,
  source_name: "Synthetic Source A",
  author: "Synthetic Author",
  timestamp: "2026-09-24T10:00:00.000Z",
  sanitized_content: "Alpha commitment delivered.",
  sequence: 0,
  metadata: {},
};

const RECORD_B = {
  record_revision_id: "rr_cp3d1_b",
  audit_id: AUDIT_ID,
  record_id: "rec_cp3d1_b",
  privacy_revision_id: PRIVACY_REVISION_ID,
  source_type: "PASTE" as const,
  source_name: "Synthetic Source B",
  author: null,
  timestamp: null,
  sanitized_content: "Beta requirement updated.",
  sequence: 1,
};

const MAPPING = {
  mapping_id: "map_cp3d1_person_1",
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  entity_type: "PERSON" as const,
  placeholder: "<PERSON_1>",
  original_value: "Synthetic Original",
  normalized_key: "synthetic-original",
  aliases: ["Synthetic Alias"],
  active: true,
};

const PRIVACY_REVISION = {
  privacy_revision_id: PRIVACY_REVISION_ID,
  audit_id: AUDIT_ID,
  confirmation_state: "CONFIRMED" as const,
  algorithm: "privacy-revision-v1" as const,
  confirmed_at: "2026-09-24T10:01:00.000Z",
  record_count: 2,
  mapping_count: 1,
};

const REPORT_V1_CREATED = {
  report_version_id: REPORT_V1,
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  parent_report_version_id: null,
  version_number: 1,
  status: "DRAFT" as const,
  changes_summary: null,
  created_at: "2026-09-24T10:02:00.000Z",
  started_at: null,
  completed_at: null,
};

const REPORT_V1_RUNNING_AT = "2026-09-24T10:02:10.000Z";
const REPORT_V1_COMPLETED_AT = "2026-09-24T10:03:00.000Z";

const REPORT_V2_CREATED = {
  report_version_id: REPORT_V2,
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  parent_report_version_id: REPORT_V1,
  version_number: 2,
  status: "DRAFT" as const,
  changes_summary: "Synthetic V2 lineage",
  created_at: "2026-09-24T10:04:00.000Z",
  started_at: null,
  completed_at: null,
};

const REPORT_V2_RUNNING_AT = "2026-09-24T10:04:10.000Z";

const EVIDENCE_V1_A = {
  evidence_id: "ev_cp3d1_v1_a",
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
  timestamp: "2026-09-24T10:00:00.000Z",
  evidence_type: "STATEMENT" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const EVIDENCE_V1_B = {
  evidence_id: "ev_cp3d1_v1_b",
  report_version_id: REPORT_V1,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_B.record_revision_id,
  record_id: RECORD_B.record_id,
  source_ref: {
    source_name: RECORD_B.source_name,
    sequence: RECORD_B.sequence,
    char_start: 0,
    char_end: 4,
  },
  excerpt: "Beta",
  actor: null,
  timestamp: null,
  evidence_type: "STATUS" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const EVIDENCE_V2 = {
  evidence_id: "ev_cp3d1_v2_a",
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
  evidence_type: "OTHER" as const,
  epistemic_status: "FACT" as const,
  fact_scope: "SOURCE_FACT" as const,
};

const COMMITMENT_V1_CONFIRMED = {
  commitment_id: "com_cp3d1_v1_confirmed",
  report_version_id: REPORT_V1,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  actor: "Synthetic Actor",
  action_or_deliverable: "Deliver synthetic artifact",
  evidence_ids: [EVIDENCE_V1_A.evidence_id],
  deadline: null,
  condition: null,
  recipient: null,
  lifecycle_status: "OPEN" as const,
  supersedes_commitment_id: null,
  status_evidence_ids: [],
};

const COMMITMENT_V1_CANDIDATE = {
  commitment_id: "com_cp3d1_v1_candidate",
  report_version_id: REPORT_V1,
  classification: "CANDIDATE" as const,
  epistemic_status: "UNKNOWN" as const,
  actor: null,
  action_or_deliverable: "Possible synthetic follow-up",
  evidence_ids: [EVIDENCE_V1_B.evidence_id],
  deadline: null,
  condition: "Synthetic condition",
  recipient: null,
  lifecycle_status: "UNKNOWN" as const,
  supersedes_commitment_id: null,
  status_evidence_ids: [],
};

const COMMITMENT_V2 = {
  commitment_id: "com_cp3d1_v2_confirmed",
  report_version_id: REPORT_V2,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  actor: "Synthetic Actor",
  action_or_deliverable: "Deliver revised synthetic artifact",
  evidence_ids: [EVIDENCE_V2.evidence_id],
  deadline: "2026-10-01",
  condition: null,
  recipient: "Synthetic Recipient",
  lifecycle_status: "MODIFIED" as const,
  supersedes_commitment_id: COMMITMENT_V1_CONFIRMED.commitment_id,
  status_evidence_ids: [EVIDENCE_V2.evidence_id],
};

const CHANGE_V1_CONFIRMED = {
  change_id: "chg_cp3d1_v1_confirmed",
  report_version_id: REPORT_V1,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  change_type: "MODIFY" as const,
  subject: "Synthetic requirement",
  before_summary: "Synthetic before",
  after_summary: "Synthetic after",
  evidence_ids: [EVIDENCE_V1_B.evidence_id],
  timestamp: null,
};

const CHANGE_V1_CANDIDATE = {
  change_id: "chg_cp3d1_v1_candidate",
  report_version_id: REPORT_V1,
  classification: "CANDIDATE" as const,
  epistemic_status: "INFERENCE" as const,
  change_type: "CLARIFY" as const,
  subject: "Synthetic candidate clarification",
  before_summary: null,
  after_summary: "Synthetic candidate after",
  evidence_ids: [EVIDENCE_V1_A.evidence_id],
  timestamp: "2026-09-24T10:00:30.000Z",
};

const CONFLICT_V1 = {
  conflict_id: "cfl_cp3d1_v1",
  report_version_id: REPORT_V1,
  conflict_type: "POTENTIAL_CONFLICT" as const,
  claim_a: {
    text: "Synthetic claim A",
    evidence_ids: [EVIDENCE_V1_A.evidence_id],
  },
  claim_b: {
    text: "Synthetic claim B",
    evidence_ids: [EVIDENCE_V1_B.evidence_id],
  },
  comparable_context: {
    subject: "Synthetic subject",
    time_context: null,
    version_context: "Synthetic V1 context",
    condition_context: null,
  },
  conflict_reason: "Synthetic statements differ.",
  counter_evidence_ids: [EVIDENCE_V1_B.evidence_id],
  alternative_explanations: [
    {
      text: "Synthetic alternative explanation",
      epistemic_status: "INFERENCE" as const,
    },
  ],
  missing_evidence: ["Synthetic missing item"],
  epistemic_status: "INFERENCE" as const,
  conflicted: true as const,
};

const PROVIDER_REPORT = {
  provider_call_id: "pcall_cp3d1_report",
  audit_id: AUDIT_ID,
  report_version_id: REPORT_V1,
  stage: "SYNTHETIC_ANALYSIS",
  provider_name: "Synthetic Provider",
  model_name: "Synthetic Model",
  started_at: "2026-09-24T10:05:00.000Z",
  completed_at: "2026-09-24T10:05:01.000Z",
  latency_ms: 1000,
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
  output_counts: {
    evidence: 2,
    commitments: 2,
    changes: 2,
    conflicts: 1,
    unknown: 0,
  },
};

const PROVIDER_AUDIT = {
  provider_call_id: "pcall_cp3d1_audit",
  audit_id: AUDIT_ID,
  report_version_id: null,
  stage: "SYNTHETIC_AUDIT_SETUP",
  provider_name: "Synthetic Provider",
  model_name: "Synthetic Model",
  started_at: "2026-09-24T10:06:00.000Z",
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
    privacy: new PrivacyRepository(connection, () => "2026-09-24T10:01:30.000Z"),
    reports: new ReportVersionRepository(connection),
    evidence: new EvidenceRepository(connection),
    commitments: new CommitmentRepository(connection),
    changes: new ChangeRepository(connection),
    conflicts: new ConflictRepository(connection),
    content: new ReportContentRepository(connection),
    providerCalls: new ProviderCallRepository(connection),
  };
}

function writeTenTableFixture(connection: PersistenceConnection): void {
  const repo = repositories(connection);

  repo.audits.createAudit({
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: "2026-09-24T10:00:00.000Z",
  });

  repo.privacy.saveConfirmedPrivacyAggregate({
    revision: PRIVACY_REVISION,
    records: [RECORD_A, RECORD_B],
    mappings: [MAPPING],
  });

  repo.reports.createReportVersion(REPORT_V1_CREATED);
  connection.transaction(() =>
    repo.reports.transitionLifecycle(REPORT_V1, "RUNNING", REPORT_V1_RUNNING_AT),
  );

  repo.content.persistReportContent({
    report_version_id: REPORT_V1,
    evidence: [EVIDENCE_V1_A, EVIDENCE_V1_B],
    commitments: [COMMITMENT_V1_CONFIRMED, COMMITMENT_V1_CANDIDATE],
    changes: [CHANGE_V1_CONFIRMED, CHANGE_V1_CANDIDATE],
    conflicts: [CONFLICT_V1],
    completeReport: true,
    completionTimestamp: REPORT_V1_COMPLETED_AT,
  });

  repo.providerCalls.insertProviderCall(PROVIDER_REPORT);
  repo.providerCalls.insertProviderCall(PROVIDER_AUDIT);

  repo.reports.createReportVersion(REPORT_V2_CREATED);
  connection.transaction(() =>
    repo.reports.transitionLifecycle(REPORT_V2, "RUNNING", REPORT_V2_RUNNING_AT),
  );

  repo.content.persistReportContent({
    report_version_id: REPORT_V2,
    evidence: [EVIDENCE_V2],
    commitments: [COMMITMENT_V2],
    changes: [],
    conflicts: [],
    completeReport: false,
  });
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
    commitmentsV1: repo.commitments.getCommitmentsByReportVersion(REPORT_V1),
    commitmentsV2: repo.commitments.getCommitmentsByReportVersion(REPORT_V2),
    changesV1: repo.changes.getChangesByReportVersion(REPORT_V1),
    changesV2: repo.changes.getChangesByReportVersion(REPORT_V2),
    conflictsV1: repo.conflicts.getConflictsByReportVersion(REPORT_V1),
    conflictsV2: repo.conflicts.getConflictsByReportVersion(REPORT_V2),
    providerAudit: repo.providerCalls.getProviderCallsByAudit(AUDIT_ID),
    providerV1: repo.providerCalls.getProviderCallsByReportVersion(REPORT_V1),
    providerV2: repo.providerCalls.getProviderCallsByReportVersion(REPORT_V2),
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

function expectedSnapshot() {
  return {
    auditSafe: {
      audit_id: AUDIT_ID,
      created_at: "2026-09-24T10:00:00.000Z",
    },
    auditLocal: {
      audit_id: AUDIT_ID,
      revision_salt: REVISION_SALT,
      created_at: "2026-09-24T10:00:00.000Z",
    },
    privacyLocal: {
      revision: PRIVACY_REVISION,
      records: [RECORD_A, RECORD_B],
      mappings: [MAPPING],
    },
    reports: [
      {
        ...REPORT_V1_CREATED,
        status: "COMPLETED" as const,
        started_at: REPORT_V1_RUNNING_AT,
        completed_at: REPORT_V1_COMPLETED_AT,
      },
      {
        ...REPORT_V2_CREATED,
        status: "RUNNING" as const,
        started_at: REPORT_V2_RUNNING_AT,
        completed_at: null,
      },
    ],
    evidenceV1: [EVIDENCE_V1_A, EVIDENCE_V1_B],
    evidenceV2: [EVIDENCE_V2],
    commitmentsV1: [COMMITMENT_V1_CANDIDATE, COMMITMENT_V1_CONFIRMED],
    commitmentsV2: [COMMITMENT_V2],
    changesV1: [CHANGE_V1_CONFIRMED, CHANGE_V1_CANDIDATE],
    changesV2: [],
    conflictsV1: [CONFLICT_V1],
    conflictsV2: [],
    providerAudit: [PROVIDER_REPORT, PROVIDER_AUDIT],
    providerV1: [PROVIDER_REPORT],
    providerV2: [],
  };
}

function assertExactSourceBinding(snapshot: ReturnType<typeof readRepositorySnapshot>): void {
  const records = new Map(
    snapshot.privacyLocal.records.map((record) => [record.record_revision_id, record] as const),
  );
  for (const item of [...snapshot.evidenceV1, ...snapshot.evidenceV2]) {
    const record = records.get(item.record_revision_id);
    assert.ok(record);
    assert.equal(item.privacy_revision_id, record.privacy_revision_id);
    assert.equal(item.record_id, record.record_id);
    assert.equal(item.source_ref.source_name, record.source_name);
    assert.equal(item.source_ref.sequence, record.sequence);
    assert.equal(
      record.sanitized_content.slice(item.source_ref.char_start, item.source_ref.char_end),
      item.excerpt,
    );
  }
}

function assertProviderMetadataOnly(snapshot: ReturnType<typeof readRepositorySnapshot>): void {
  const forbidden = [
    "prompt",
    "request",
    "response",
    "raw_text",
    "sanitized_content",
    "original_value",
    "revision_salt",
    "authorization",
    "api_key",
    "secret",
    "mapping",
  ];
  for (const call of snapshot.providerAudit) {
    const keys = Object.keys(call).map((key) => key.toLowerCase());
    for (const token of forbidden) {
      assert.equal(keys.some((key) => key.includes(token)), false);
    }
  }
}

test("DEV03 CP-3D1: 10-table repository close/reopen round-trip", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dev03-cp3d1-"));
  const databasePath = join(directory, "round-trip.sqlite");
  let connection1: PersistenceConnection | undefined;
  let connection2: PersistenceConnection | undefined;
  let connection3: PersistenceConnection | undefined;

  try {
    connection1 = openPersistenceConnection(databasePath);
    createFormalFixtureSchema(connection1);
    writeTenTableFixture(connection1);

    const expected = expectedSnapshot();
    const preClose = readRepositorySnapshot(connection1);
    const counts1 = rowCounts(connection1);
    const fk1 = connection1.sqlite.pragma("foreign_keys", { simple: true });

    await t.test("1. all 10 tables receive valid data", () => {
      assert.equal(fk1, 1);
      assert.deepEqual(Object.keys(counts1).sort(), [...TABLES].sort());
      for (const table of TABLES) assert.ok(counts1[table] > 0, `${table} must contain data`);
    });

    await t.test("2. pre-close Repository read matches expected Domain semantics", () => {
      assert.deepEqual(preClose, expected);
    });

    connection1.close();
    assert.equal(connection1.sqlite.open, false);

    connection2 = openPersistenceConnection(databasePath);
    const fk2 = connection2.sqlite.pragma("foreign_keys", { simple: true });
    const reopened2 = readRepositorySnapshot(connection2);
    const counts2 = rowCounts(connection2);

    await t.test("3. connection is truly closed before reopen", () => {
      assert.equal(connection1!.sqlite.open, false);
    });

    await t.test("4. reopened connection re-enables foreign_keys", () => {
      assert.equal(fk2, 1);
    });

    await t.test("5. all 10 tables survive reopen", () => {
      for (const table of TABLES) assert.ok(counts2[table] > 0, `${table} must survive reopen`);
    });

    await t.test("6. reopened Repository results preserve full Domain deep equality", () => {
      assert.deepEqual(reopened2, expected);
      assert.deepEqual(reopened2, preClose);
    });

    await t.test("7. all JSON_TEXT contracts round-trip without shape drift", () => {
      assert.deepEqual(reopened2.privacyLocal.records[0]?.metadata, {});
      assert.deepEqual(reopened2.privacyLocal.mappings[0]?.aliases, ["Synthetic Alias"]);
      assert.deepEqual(reopened2.commitmentsV1[0]?.evidence_ids, [EVIDENCE_V1_B.evidence_id]);
      assert.deepEqual(reopened2.commitmentsV1[1]?.status_evidence_ids, []);
      assert.deepEqual(reopened2.changesV1[0]?.evidence_ids, [EVIDENCE_V1_B.evidence_id]);
      assert.deepEqual(reopened2.conflictsV1[0]?.claim_a.evidence_ids, [EVIDENCE_V1_A.evidence_id]);
      assert.deepEqual(reopened2.conflictsV1[0]?.claim_b.evidence_ids, [EVIDENCE_V1_B.evidence_id]);
      assert.deepEqual(reopened2.conflictsV1[0]?.counter_evidence_ids, [EVIDENCE_V1_B.evidence_id]);
      assert.deepEqual(reopened2.conflictsV1[0]?.alternative_explanations, CONFLICT_V1.alternative_explanations);
      assert.deepEqual(reopened2.conflictsV1[0]?.missing_evidence, CONFLICT_V1.missing_evidence);
      assert.deepEqual(reopened2.providerV1[0]?.output_counts, PROVIDER_REPORT.output_counts);
    });

    await t.test("8. nullable fields preserve null rather than undefined/empty defaults", () => {
      assert.equal(reopened2.privacyLocal.records[1]?.author, null);
      assert.equal(reopened2.privacyLocal.records[1]?.timestamp, null);
      assert.equal(reopened2.evidenceV1[1]?.actor, null);
      assert.equal(reopened2.evidenceV1[1]?.timestamp, null);
      assert.equal(reopened2.reports[1]?.completed_at, null);
      assert.equal(reopened2.providerAudit[1]?.report_version_id, null);
      assert.equal(reopened2.providerAudit[1]?.completed_at, null);
      assert.equal(reopened2.providerAudit[1]?.total_tokens, null);
      assert.equal(reopened2.providerAudit[1]?.cost_amount_micros, null);
      assert.equal(reopened2.providerAudit[1]?.schema_valid, null);
      assert.equal(reopened2.providerAudit[1]?.error_category, null);
      assert.equal(reopened2.providerAudit[1]?.output_counts, null);
    });

    await t.test("9. V1 COMPLETED lifecycle round-trips", () => {
      assert.equal(reopened2.reports[0]?.status, "COMPLETED");
      assert.equal(reopened2.reports[0]?.started_at, REPORT_V1_RUNNING_AT);
      assert.equal(reopened2.reports[0]?.completed_at, REPORT_V1_COMPLETED_AT);
    });

    await t.test("10. V2 RUNNING lifecycle round-trips with null completed_at", () => {
      assert.equal(reopened2.reports[1]?.status, "RUNNING");
      assert.equal(reopened2.reports[1]?.started_at, REPORT_V2_RUNNING_AT);
      assert.equal(reopened2.reports[1]?.completed_at, null);
    });

    await t.test("11. Report parent lineage round-trips", () => {
      assert.equal(reopened2.reports[1]?.parent_report_version_id, REPORT_V1);
    });

    await t.test("12. cross-version Commitment supersession round-trips through real lineage", () => {
      assert.equal(reopened2.commitmentsV2[0]?.supersedes_commitment_id, COMMITMENT_V1_CONFIRMED.commitment_id);
      assert.equal(reopened2.reports[1]?.parent_report_version_id, reopened2.commitmentsV1[1]?.report_version_id);
    });

    await t.test("13. Privacy Snapshot remains privacy_revision_id -> canonical_records single SOT", () => {
      assert.equal(reopened2.reports[0]?.privacy_revision_id, PRIVACY_REVISION_ID);
      assert.equal(reopened2.reports[1]?.privacy_revision_id, PRIVACY_REVISION_ID);
      assert.deepEqual(
        reopened2.privacyLocal.records.map((record) => record.record_revision_id),
        [RECORD_A.record_revision_id, RECORD_B.record_revision_id],
      );
      assert.equal("input_record_revision_ids" in reopened2.reports[0]!, false);
      assert.equal("record_revision_ids" in reopened2.reports[0]!, false);
    });

    await t.test("14. Privacy Mapping remains attached to the correct revision without SECRET mapping", () => {
      assert.equal(reopened2.privacyLocal.mappings[0]?.privacy_revision_id, PRIVACY_REVISION_ID);
      assert.notEqual(reopened2.privacyLocal.mappings[0]?.entity_type, "SECRET");
    });

    await t.test("15. Evidence exact source binding survives close/reopen", () => {
      assertExactSourceBinding(reopened2);
    });

    await t.test("16. Evidence SOURCE_FACT boundary is preserved", () => {
      for (const item of [...reopened2.evidenceV1, ...reopened2.evidenceV2]) {
        assert.equal(item.epistemic_status, "FACT");
        assert.equal(item.fact_scope, "SOURCE_FACT");
      }
    });

    await t.test("17. Commitment Confirmed/Candidate epistemic boundary is preserved", () => {
      const candidate = reopened2.commitmentsV1.find((item) => item.classification === "CANDIDATE");
      const confirmed = reopened2.commitmentsV1.find((item) => item.classification === "CONFIRMED");
      assert.equal(candidate?.epistemic_status, "UNKNOWN");
      assert.equal(confirmed?.epistemic_status, "FACT");
    });

    await t.test("18. Change Confirmed/Candidate epistemic boundary is preserved", () => {
      const candidate = reopened2.changesV1.find((item) => item.classification === "CANDIDATE");
      const confirmed = reopened2.changesV1.find((item) => item.classification === "CONFIRMED");
      assert.equal(candidate?.epistemic_status, "INFERENCE");
      assert.equal(confirmed?.epistemic_status, "FACT");
    });

    await t.test("19. Potential Conflict epistemic boundary is preserved", () => {
      const conflict = reopened2.conflictsV1[0]!;
      assert.equal(conflict.conflict_type, "POTENTIAL_CONFLICT");
      assert.equal(conflict.epistemic_status, "INFERENCE");
      assert.equal(conflict.conflicted, true);
    });

    await t.test("20. Report-level ProviderCall metadata round-trips", () => {
      assert.deepEqual(reopened2.providerV1, [PROVIDER_REPORT]);
      assertProviderMetadataOnly(reopened2);
    });

    await t.test("21. Audit-level ProviderCall with null report linkage round-trips", () => {
      const auditLevel = reopened2.providerAudit.find((call) => call.provider_call_id === PROVIDER_AUDIT.provider_call_id);
      assert.deepEqual(auditLevel, PROVIDER_AUDIT);
    });

    await t.test("22. deterministic Repository read order is preserved after reopen", () => {
      assert.deepEqual(reopened2.privacyLocal.records.map((item) => item.record_revision_id), [RECORD_A.record_revision_id, RECORD_B.record_revision_id]);
      assert.deepEqual(reopened2.reports.map((item) => item.report_version_id), [REPORT_V1, REPORT_V2]);
      assert.deepEqual(reopened2.evidenceV1.map((item) => item.evidence_id), [EVIDENCE_V1_A.evidence_id, EVIDENCE_V1_B.evidence_id]);
      assert.deepEqual(reopened2.commitmentsV1.map((item) => item.commitment_id), [COMMITMENT_V1_CANDIDATE.commitment_id, COMMITMENT_V1_CONFIRMED.commitment_id]);
      assert.deepEqual(reopened2.changesV1.map((item) => item.change_id), [CHANGE_V1_CONFIRMED.change_id, CHANGE_V1_CANDIDATE.change_id]);
      assert.deepEqual(reopened2.conflictsV1.map((item) => item.conflict_id), [CONFLICT_V1.conflict_id]);
      assert.deepEqual(reopened2.providerAudit.map((item) => item.provider_call_id), [PROVIDER_REPORT.provider_call_id, PROVIDER_AUDIT.provider_call_id]);
    });

    await t.test("23. row counts remain stable after first reopen", () => {
      assert.deepEqual(counts2, counts1);
    });

    connection2.close();
    assert.equal(connection2.sqlite.open, false);

    connection3 = openPersistenceConnection(databasePath);
    const fk3 = connection3.sqlite.pragma("foreign_keys", { simple: true });
    const beforeReadCounts = rowCounts(connection3);
    const reopened3 = readRepositorySnapshot(connection3);
    const afterReadCounts = rowCounts(connection3);

    await t.test("24. second reopen returns an identical repository state", () => {
      assert.equal(fk3, 1);
      assert.deepEqual(reopened3, reopened2);
    });

    await t.test("25. repeated reopen preserves stable row counts", () => {
      assert.deepEqual(beforeReadCounts, counts1);
      assert.deepEqual(afterReadCounts, counts1);
    });

    await t.test("26. Repository reads have no persistence side effects", () => {
      assert.deepEqual(afterReadCounts, beforeReadCounts);
      assert.equal(reopened3.reports[0]?.status, "COMPLETED");
      assert.equal(reopened3.reports[1]?.status, "RUNNING");
      assert.deepEqual(reopened3.providerAudit, reopened2.providerAudit);
    });
  } finally {
    if (connection1?.sqlite.open) connection1.close();
    if (connection2?.sqlite.open) connection2.close();
    if (connection3?.sqlite.open) connection3.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
