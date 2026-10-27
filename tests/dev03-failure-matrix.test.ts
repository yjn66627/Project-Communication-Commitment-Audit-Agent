import assert from "node:assert/strict";
import test from "node:test";

import { openPersistenceConnection, type PersistenceConnection } from "../src/db/connection.js";
import {
  normalizePersistenceError,
  PersistenceError,
  type PersistenceErrorCode,
} from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { ChangeRepository } from "../src/db/repositories/change-repository.js";
import { CommitmentRepository } from "../src/db/repositories/commitment-repository.js";
import { ConflictRepository } from "../src/db/repositories/conflict-repository.js";
import { EvidenceRepository } from "../src/db/repositories/evidence-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";
import { ProviderCallRepository } from "../src/db/repositories/provider-call-repository.js";
import { ReportContentRepository } from "../src/db/repositories/report-content-repository.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";

const AUDIT_ID = "aud_cp3d2";
const PRIVACY_REVISION_ID = "prv_cp3d2";
const REPORT_V1 = "rpt_cp3d2_v1";
const REPORT_V2 = "rpt_cp3d2_v2";
const RECORD_ID = "rec_cp3d2_1";
const RECORD_REVISION_ID = "rr_cp3d2_1";
const REVISION_SALT = Buffer.alloc(32, 0x6a).toString("base64url");
const SECRET_MARKER = "SECRET_TEST_VALUE_SHOULD_NOT_LEAK";
const AUTH_MARKER = "Authorization: Bearer TEST_SECRET";

const RECORD = {
  record_revision_id: RECORD_REVISION_ID,
  audit_id: AUDIT_ID,
  record_id: RECORD_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  source_type: "PASTE" as const,
  source_name: "Synthetic Source",
  author: null,
  timestamp: null,
  sanitized_content: "Alpha commitment delivered.",
  sequence: 0,
  metadata: {},
};

const MAPPING = {
  mapping_id: "map_cp3d2_person_1",
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
  confirmed_at: "2026-09-24T11:00:00.000Z",
  record_count: 1,
  mapping_count: 1,
};

const REPORT_INPUT = {
  report_version_id: REPORT_V1,
  audit_id: AUDIT_ID,
  privacy_revision_id: PRIVACY_REVISION_ID,
  parent_report_version_id: null,
  version_number: 1,
  status: "DRAFT" as const,
  changes_summary: null,
  created_at: "2026-09-24T11:01:00.000Z",
  started_at: null,
  completed_at: null,
};

const EVIDENCE = {
  evidence_id: "ev_cp3d2_1",
  report_version_id: REPORT_V1,
  privacy_revision_id: PRIVACY_REVISION_ID,
  record_revision_id: RECORD_REVISION_ID,
  record_id: RECORD_ID,
  source_ref: {
    source_name: RECORD.source_name,
    sequence: RECORD.sequence,
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

const COMMITMENT = {
  commitment_id: "com_cp3d2_1",
  report_version_id: REPORT_V1,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  actor: "Synthetic Actor",
  action_or_deliverable: "Deliver synthetic artifact",
  evidence_ids: [EVIDENCE.evidence_id],
  deadline: null,
  condition: null,
  recipient: null,
  lifecycle_status: "OPEN" as const,
  supersedes_commitment_id: null,
  status_evidence_ids: [],
};

const CHANGE = {
  change_id: "chg_cp3d2_1",
  report_version_id: REPORT_V1,
  classification: "CONFIRMED" as const,
  epistemic_status: "FACT" as const,
  change_type: "MODIFY" as const,
  subject: "Synthetic requirement",
  before_summary: "Synthetic before",
  after_summary: "Synthetic after",
  evidence_ids: [EVIDENCE.evidence_id],
  timestamp: null,
};

const CONFLICT = {
  conflict_id: "cfl_cp3d2_1",
  report_version_id: REPORT_V1,
  conflict_type: "POTENTIAL_CONFLICT" as const,
  claim_a: { text: "Synthetic claim A", evidence_ids: [EVIDENCE.evidence_id] },
  claim_b: { text: "Synthetic claim B", evidence_ids: [EVIDENCE.evidence_id] },
  comparable_context: {
    subject: "Synthetic subject",
    time_context: null,
    version_context: null,
    condition_context: null,
  },
  conflict_reason: "Synthetic potential conflict.",
  counter_evidence_ids: [EVIDENCE.evidence_id],
  alternative_explanations: [
    { text: "Synthetic alternative", epistemic_status: "INFERENCE" as const },
  ],
  missing_evidence: ["Synthetic missing item"],
  epistemic_status: "INFERENCE" as const,
  conflicted: true as const,
};

const PROVIDER_CALL = {
  provider_call_id: "pcall_cp3d2_1",
  audit_id: AUDIT_ID,
  report_version_id: REPORT_V1,
  stage: "SYNTHETIC_STAGE",
  provider_name: "Synthetic Provider",
  model_name: "Synthetic Model",
  started_at: "2026-09-24T11:10:00.000Z",
  completed_at: "2026-09-24T11:10:01.000Z",
  latency_ms: 1000,
  status: "SUCCESS",
  input_record_count: 1,
  input_size_chars: 27,
  input_tokens: 10,
  output_tokens: 5,
  total_tokens: 15,
  cost_amount_micros: 10,
  cost_currency: "USD",
  retry_count: 0,
  schema_valid: true,
  error_category: null,
  output_counts: { evidence: 1, commitments: 1, changes: 1, conflicts: 1, unknown: 0 },
};

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
    privacy: new PrivacyRepository(connection, () => "2026-09-24T11:00:30.000Z"),
    reports: new ReportVersionRepository(connection),
    evidence: new EvidenceRepository(connection),
    commitments: new CommitmentRepository(connection),
    changes: new ChangeRepository(connection),
    conflicts: new ConflictRepository(connection),
    content: new ReportContentRepository(connection),
    providerCalls: new ProviderCallRepository(connection),
  };
}

function withDb<T>(operation: (connection: PersistenceConnection, repo: ReturnType<typeof repositories>) => T): T {
  const connection = openPersistenceConnection(":memory:");
  createFormalFixtureSchema(connection);
  const repo = repositories(connection);
  try {
    return operation(connection, repo);
  } finally {
    connection.close();
  }
}

function expectCode(code: PersistenceErrorCode) {
  return (error: unknown): boolean => error instanceof PersistenceError && error.code === code;
}

function countRows(connection: PersistenceConnection, table: string): number {
  return (connection.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function seedAuditPrivacy(repo: ReturnType<typeof repositories>): void {
  repo.audits.createAudit({
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: "2026-09-24T10:59:00.000Z",
  });
  repo.privacy.saveConfirmedPrivacyAggregate({
    revision: PRIVACY_REVISION,
    records: [RECORD],
    mappings: [MAPPING],
  });
}

function seedReport(repo: ReturnType<typeof repositories>, connection: PersistenceConnection, status: "DRAFT" | "RUNNING" = "RUNNING"): void {
  repo.reports.createReportVersion(REPORT_INPUT);
  if (status === "RUNNING") {
    connection.transaction(() => repo.reports.transitionLifecycle(REPORT_V1, "RUNNING", "2026-09-24T11:01:30.000Z"));
  }
}

function seedCore(connection: PersistenceConnection, repo: ReturnType<typeof repositories>, status: "DRAFT" | "RUNNING" = "RUNNING"): void {
  seedAuditPrivacy(repo);
  seedReport(repo, connection, status);
}

function insertEvidence(connection: PersistenceConnection, repo: ReturnType<typeof repositories>, input: unknown = EVIDENCE): void {
  connection.transaction(() => repo.evidence.insertEvidence(input));
}

function insertCommitment(connection: PersistenceConnection, repo: ReturnType<typeof repositories>, input: unknown = COMMITMENT): void {
  connection.transaction(() => repo.commitments.insertCommitment(input));
}

function insertChange(connection: PersistenceConnection, repo: ReturnType<typeof repositories>, input: unknown = CHANGE): void {
  connection.transaction(() => repo.changes.insertChange(input));
}

function insertConflict(connection: PersistenceConnection, repo: ReturnType<typeof repositories>, input: unknown = CONFLICT): void {
  connection.transaction(() => repo.conflicts.insertConflict(input));
}

function seedEvidenceAndReportContentBase(connection: PersistenceConnection, repo: ReturnType<typeof repositories>): void {
  seedCore(connection, repo, "RUNNING");
  insertEvidence(connection, repo);
}

function assertNoReportContentRows(connection: PersistenceConnection): void {
  assert.equal(countRows(connection, "evidence"), 0);
  assert.equal(countRows(connection, "commitments"), 0);
  assert.equal(countRows(connection, "changes"), 0);
  assert.equal(countRows(connection, "conflicts"), 0);
}

function assertReportNotCompleted(repo: ReturnType<typeof repositories>): void {
  assert.notEqual(repo.reports.getReportVersionById(REPORT_V1).status, "COMPLETED");
}

// 1-2 Audit immutability.
test("1. Audit identical replay is idempotent", () => {
  withDb((_connection, repo) => {
    const input = { audit_id: AUDIT_ID, revision_salt: REVISION_SALT, created_at: "2026-09-24T10:59:00.000Z" };
    assert.equal(repo.audits.createAudit(input).outcome, "INSERTED");
    assert.equal(repo.audits.createAudit(input).outcome, "IDEMPOTENT_EXISTING");
    assert.equal(countRows(_connection, "audits"), 1);
  });
});

test("2. Audit same-ID immutable mutation is rejected as IMMUTABILITY_VIOLATION", () => {
  withDb((connection, repo) => {
    repo.audits.createAudit({ audit_id: AUDIT_ID, revision_salt: REVISION_SALT, created_at: "2026-09-24T10:59:00.000Z" });
    assert.throws(
      () => repo.audits.createAudit({ audit_id: AUDIT_ID, revision_salt: REVISION_SALT, created_at: "2026-09-24T10:59:01.000Z" }),
      expectCode("IMMUTABILITY_VIOLATION"),
    );
    assert.equal(countRows(connection, "audits"), 1);
  });
});

// 3-5 Privacy aggregate immutability + rollback.
test("3. Privacy aggregate exact replay is idempotent", () => {
  withDb((_connection, repo) => {
    repo.audits.createAudit({ audit_id: AUDIT_ID, revision_salt: REVISION_SALT, created_at: "2026-09-24T10:59:00.000Z" });
    const aggregate = { revision: PRIVACY_REVISION, records: [RECORD], mappings: [MAPPING] };
    assert.equal(repo.privacy.saveConfirmedPrivacyAggregate(aggregate).outcome, "INSERTED");
    assert.equal(repo.privacy.saveConfirmedPrivacyAggregate(aggregate).outcome, "IDEMPOTENT_EXISTING");
  });
});

test("4. Privacy aggregate same revision with changed canonical content is immutable", () => {
  withDb((_connection, repo) => {
    repo.audits.createAudit({ audit_id: AUDIT_ID, revision_salt: REVISION_SALT, created_at: "2026-09-24T10:59:00.000Z" });
    repo.privacy.saveConfirmedPrivacyAggregate({ revision: PRIVACY_REVISION, records: [RECORD], mappings: [MAPPING] });
    assert.throws(
      () => repo.privacy.saveConfirmedPrivacyAggregate({
        revision: PRIVACY_REVISION,
        records: [{ ...RECORD, sanitized_content: "Mutated synthetic content." }],
        mappings: [MAPPING],
      }),
      expectCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("5. Privacy aggregate mapping-stage constraint failure rolls back revision and records", () => {
  withDb((connection, repo) => {
    repo.audits.createAudit({ audit_id: AUDIT_ID, revision_salt: REVISION_SALT, created_at: "2026-09-24T10:59:00.000Z" });
    const revision = { ...PRIVACY_REVISION, privacy_revision_id: "prv_cp3d2_rollback", mapping_count: 2 };
    const record = { ...RECORD, privacy_revision_id: revision.privacy_revision_id, record_revision_id: "rr_cp3d2_rollback", record_id: "rec_cp3d2_rollback" };
    const mappingA = { ...MAPPING, privacy_revision_id: revision.privacy_revision_id, mapping_id: "map_cp3d2_rollback_a" };
    const mappingB = { ...mappingA, mapping_id: "map_cp3d2_rollback_b", original_value: "Synthetic Other" };
    assert.throws(() => repo.privacy.saveConfirmedPrivacyAggregate({ revision, records: [record], mappings: [mappingA, mappingB] }));
    assert.equal(countRows(connection, "privacy_revisions"), 0);
    assert.equal(countRows(connection, "canonical_records"), 0);
    assert.equal(countRows(connection, "privacy_mappings"), 0);
  });
});

// 6-10 ReportVersion identity/history/lifecycle failures.
test("6. ReportVersion same-ID semantic mutation is rejected", () => {
  withDb((_connection, repo) => {
    seedAuditPrivacy(repo);
    repo.reports.createReportVersion(REPORT_INPUT);
    assert.throws(() => repo.reports.createReportVersion({ ...REPORT_INPUT, changes_summary: "Mutation" }), expectCode("IMMUTABILITY_VIOLATION"));
  });
});

test("7. duplicate audit/version with different ReportVersion ID is rejected", () => {
  withDb((_connection, repo) => {
    seedAuditPrivacy(repo);
    repo.reports.createReportVersion(REPORT_INPUT);
    assert.throws(
      () => repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: "rpt_cp3d2_conflict" }),
      expectCode("CONFLICTING_EXISTING_ROW"),
    );
  });
});

test("8. missing parent ReportVersion is rejected", () => {
  withDb((_connection, repo) => {
    seedAuditPrivacy(repo);
    assert.throws(
      () => repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: REPORT_V2, version_number: 2, parent_report_version_id: "rpt_missing" }),
      expectCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("9. cross-Audit parent is rejected", () => {
  withDb((_connection, repo) => {
    seedAuditPrivacy(repo);
    repo.reports.createReportVersion(REPORT_INPUT);
    const otherAudit = "aud_cp3d2_other";
    const otherPrivacy = "prv_cp3d2_other";
    repo.audits.createAudit({ audit_id: otherAudit, revision_salt: Buffer.alloc(32, 0x6b).toString("base64url"), created_at: "2026-09-24T11:20:00.000Z" });
    repo.privacy.saveConfirmedPrivacyAggregate({
      revision: { ...PRIVACY_REVISION, audit_id: otherAudit, privacy_revision_id: otherPrivacy },
      records: [{ ...RECORD, audit_id: otherAudit, privacy_revision_id: otherPrivacy, record_revision_id: "rr_cp3d2_other", record_id: "rec_cp3d2_other" }],
      mappings: [{ ...MAPPING, audit_id: otherAudit, privacy_revision_id: otherPrivacy, mapping_id: "map_cp3d2_other" }],
    });
    assert.throws(
      () => repo.reports.createReportVersion({
        ...REPORT_INPUT,
        report_version_id: "rpt_cp3d2_other_child",
        audit_id: otherAudit,
        privacy_revision_id: otherPrivacy,
        parent_report_version_id: REPORT_V1,
        version_number: 2,
      }),
      expectCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("10. illegal Report lifecycle transitions and outside-transaction transition fail closed", () => {
  withDb((connection, repo) => {
    seedAuditPrivacy(repo);
    repo.reports.createReportVersion(REPORT_INPUT);
    assert.throws(() => repo.reports.transitionLifecycle(REPORT_V1, "RUNNING", "2026-09-24T11:02:00.000Z"), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
    connection.transaction(() => {
      assert.throws(() => repo.reports.transitionLifecycle(REPORT_V1, "COMPLETED", "2026-09-24T11:02:00.000Z"), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
    });
    connection.transaction(() => repo.reports.transitionLifecycle(REPORT_V1, "RUNNING", "2026-09-24T11:02:00.000Z"));
    connection.transaction(() => repo.reports.transitionLifecycle(REPORT_V1, "COMPLETED", "2026-09-24T11:03:00.000Z"));
    for (const target of ["RUNNING", "FAILED", "CANCELLED"] as const) {
      connection.transaction(() => assert.throws(() => repo.reports.transitionLifecycle(REPORT_V1, target, "2026-09-24T11:04:00.000Z"), expectCode("PERSISTENCE_INTEGRITY_ERROR")));
    }
  });
});

// 11-15 Evidence failures.
test("11. Evidence missing ReportVersion is rejected", () => {
  withDb((connection, repo) => {
    seedAuditPrivacy(repo);
    connection.transaction(() => assert.throws(() => repo.evidence.insertEvidence({ ...EVIDENCE, report_version_id: "rpt_missing" }), expectCode("PERSISTENCE_NOT_FOUND")));
  });
});

test("12. Evidence source identity mismatch is rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    connection.transaction(() => assert.throws(() => repo.evidence.insertEvidence({ ...EVIDENCE, source_ref: { ...EVIDENCE.source_ref, source_name: "Wrong Source" } }), expectCode("PERSISTENCE_INTEGRITY_ERROR")));
  });
});

test("13. Evidence span/excerpt mismatch is rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    connection.transaction(() => {
      assert.throws(() => repo.evidence.insertEvidence({ ...EVIDENCE, excerpt: "Wrong" }), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
      assert.throws(() => repo.evidence.insertEvidence({ ...EVIDENCE, source_ref: { ...EVIDENCE.source_ref, char_end: 999 } }), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
    });
  });
});

test("14. Evidence epistemic/source-fact Domain violations are rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    connection.transaction(() => {
      assert.throws(() => repo.evidence.insertEvidence({ ...EVIDENCE, epistemic_status: "INFERENCE" }), expectCode("DOMAIN_VALIDATION_ERROR"));
      assert.throws(() => repo.evidence.insertEvidence({ ...EVIDENCE, fact_scope: "REAL_WORLD_FACT" }), expectCode("DOMAIN_VALIDATION_ERROR"));
    });
  });
});

test("15. Evidence same-ID semantic mutation is rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    connection.transaction(() => assert.throws(() => repo.evidence.insertEvidence({ ...EVIDENCE, actor: "Synthetic Mutated Actor" }), expectCode("IMMUTABILITY_VIOLATION")));
    assert.equal(countRows(connection, "evidence"), 1);
  });
});

// 16-21 Commitment failures.
test("16. Commitment missing and cross-report Evidence are rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    connection.transaction(() => assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, evidence_ids: ["ev_missing"] }), expectCode("PERSISTENCE_NOT_FOUND")));
    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: REPORT_V2, version_number: 2, parent_report_version_id: REPORT_V1 });
    connection.transaction(() => repo.reports.transitionLifecycle(REPORT_V2, "RUNNING", "2026-09-24T11:05:00.000Z"));
    connection.transaction(() => assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, commitment_id: "com_cp3d2_cross_ev", report_version_id: REPORT_V2 }), expectCode("PERSISTENCE_INTEGRITY_ERROR")));
  });
});

test("17. FULFILLED Commitment without status Evidence is rejected by Domain contract", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    connection.transaction(() => assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, lifecycle_status: "FULFILLED" }), expectCode("DOMAIN_VALIDATION_ERROR")));
  });
});

test("18. Commitment missing status Evidence reference is rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    connection.transaction(() => assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, lifecycle_status: "FULFILLED", status_evidence_ids: ["ev_missing"] }), expectCode("PERSISTENCE_NOT_FOUND")));
  });
});

test("19. Commitment self/missing supersession is rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    connection.transaction(() => {
      assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, supersedes_commitment_id: COMMITMENT.commitment_id }), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
      assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, commitment_id: "com_cp3d2_missing_target", supersedes_commitment_id: "com_missing" }), expectCode("PERSISTENCE_NOT_FOUND"));
    });
  });
});

test("20. Commitment invalid lineage (cross-Audit, sibling, descendant) is rejected while ancestor remains legal", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    insertCommitment(connection, repo);

    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: "rpt_cp3d2_v2a", version_number: 2, parent_report_version_id: REPORT_V1 });
    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: "rpt_cp3d2_v2b", version_number: 3, parent_report_version_id: REPORT_V1 });
    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: "rpt_cp3d2_v3", version_number: 4, parent_report_version_id: "rpt_cp3d2_v2a" });
    for (const id of ["rpt_cp3d2_v2a", "rpt_cp3d2_v2b", "rpt_cp3d2_v3"] as const) {
      connection.transaction(() => repo.reports.transitionLifecycle(id, "RUNNING", "2026-09-24T11:06:00.000Z"));
    }
    const evV2a = { ...EVIDENCE, evidence_id: "ev_cp3d2_v2a", report_version_id: "rpt_cp3d2_v2a" };
    const evV2b = { ...EVIDENCE, evidence_id: "ev_cp3d2_v2b", report_version_id: "rpt_cp3d2_v2b" };
    const evV3 = { ...EVIDENCE, evidence_id: "ev_cp3d2_v3", report_version_id: "rpt_cp3d2_v3" };
    insertEvidence(connection, repo, evV2a);
    insertEvidence(connection, repo, evV2b);
    insertEvidence(connection, repo, evV3);
    const cV2a = { ...COMMITMENT, commitment_id: "com_cp3d2_v2a", report_version_id: "rpt_cp3d2_v2a", evidence_ids: [evV2a.evidence_id], supersedes_commitment_id: COMMITMENT.commitment_id };
    insertCommitment(connection, repo, cV2a);
    const cV2b = { ...COMMITMENT, commitment_id: "com_cp3d2_v2b", report_version_id: "rpt_cp3d2_v2b", evidence_ids: [evV2b.evidence_id] };
    insertCommitment(connection, repo, cV2b);
    const cV3 = { ...COMMITMENT, commitment_id: "com_cp3d2_v3", report_version_id: "rpt_cp3d2_v3", evidence_ids: [evV3.evidence_id], supersedes_commitment_id: cV2a.commitment_id };
    insertCommitment(connection, repo, cV3);
    connection.transaction(() => {
      assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, commitment_id: "com_cp3d2_sibling_bad", report_version_id: "rpt_cp3d2_v2a", evidence_ids: [evV2a.evidence_id], supersedes_commitment_id: cV2b.commitment_id }), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
      assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, commitment_id: "com_cp3d2_desc_bad", report_version_id: REPORT_V1, supersedes_commitment_id: cV2a.commitment_id }), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
    });

    const otherAudit = "aud_cp3d2_lineage_other";
    const otherPrivacy = "prv_cp3d2_lineage_other";
    repo.audits.createAudit({ audit_id: otherAudit, revision_salt: Buffer.alloc(32, 0x6c).toString("base64url"), created_at: "2026-09-24T11:30:00.000Z" });
    repo.privacy.saveConfirmedPrivacyAggregate({
      revision: { ...PRIVACY_REVISION, audit_id: otherAudit, privacy_revision_id: otherPrivacy },
      records: [{ ...RECORD, audit_id: otherAudit, privacy_revision_id: otherPrivacy, record_revision_id: "rr_cp3d2_lineage_other", record_id: "rec_cp3d2_lineage_other" }],
      mappings: [{ ...MAPPING, audit_id: otherAudit, privacy_revision_id: otherPrivacy, mapping_id: "map_cp3d2_lineage_other" }],
    });
    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: "rpt_cp3d2_lineage_other", audit_id: otherAudit, privacy_revision_id: otherPrivacy, version_number: 1 });
    connection.transaction(() => repo.reports.transitionLifecycle("rpt_cp3d2_lineage_other", "RUNNING", "2026-09-24T11:31:00.000Z"));
    const otherEvidence = { ...EVIDENCE, evidence_id: "ev_cp3d2_lineage_other", report_version_id: "rpt_cp3d2_lineage_other", privacy_revision_id: otherPrivacy, record_revision_id: "rr_cp3d2_lineage_other", record_id: "rec_cp3d2_lineage_other" };
    insertEvidence(connection, repo, otherEvidence);
    const otherCommitment = { ...COMMITMENT, commitment_id: "com_cp3d2_lineage_other", report_version_id: "rpt_cp3d2_lineage_other", evidence_ids: [otherEvidence.evidence_id] };
    insertCommitment(connection, repo, otherCommitment);
    connection.transaction(() => assert.throws(() => repo.commitments.insertCommitment({ ...cV2a, commitment_id: "com_cp3d2_cross_audit_bad", supersedes_commitment_id: otherCommitment.commitment_id }), expectCode("PERSISTENCE_INTEGRITY_ERROR")));
  });
});

test("21. Commitment supersession cycle and same-ID mutation are rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    const a = { ...COMMITMENT, commitment_id: "com_cp3d2_cycle_a", supersedes_commitment_id: "com_cp3d2_cycle_b" };
    const b = { ...COMMITMENT, commitment_id: "com_cp3d2_cycle_b", supersedes_commitment_id: "com_cp3d2_cycle_a" };
    connection.transaction(() => assert.throws(() => repo.commitments.insertCommitmentBatch([a, b]), expectCode("PERSISTENCE_INTEGRITY_ERROR")));
    insertCommitment(connection, repo);
    connection.transaction(() => assert.throws(() => repo.commitments.insertCommitment({ ...COMMITMENT, action_or_deliverable: "Mutated deliverable" }), expectCode("IMMUTABILITY_VIOLATION")));
  });
});

// 22-23 Change failures.
test("22. Change missing/cross-report Evidence and invalid epistemic status are rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    insertEvidence(connection, repo);
    connection.transaction(() => {
      assert.throws(() => repo.changes.insertChange({ ...CHANGE, evidence_ids: ["ev_missing"] }), expectCode("PERSISTENCE_NOT_FOUND"));
      assert.throws(() => repo.changes.insertChange({ ...CHANGE, epistemic_status: "UNKNOWN" }), expectCode("DOMAIN_VALIDATION_ERROR"));
    });
    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: REPORT_V2, version_number: 2, parent_report_version_id: REPORT_V1 });
    connection.transaction(() => repo.reports.transitionLifecycle(REPORT_V2, "RUNNING", "2026-09-24T11:08:00.000Z"));
    connection.transaction(() => assert.throws(() => repo.changes.insertChange({ ...CHANGE, change_id: "chg_cp3d2_cross", report_version_id: REPORT_V2 }), expectCode("PERSISTENCE_INTEGRITY_ERROR")));
  });
});

test("23. Change same-ID semantic mutation is rejected", () => {
  withDb((connection, repo) => {
    seedEvidenceAndReportContentBase(connection, repo);
    insertChange(connection, repo);
    connection.transaction(() => assert.throws(() => repo.changes.insertChange({ ...CHANGE, after_summary: "Mutated" }), expectCode("IMMUTABILITY_VIOLATION")));
  });
});

// 24-26 Conflict failures.
test("24. Conflict FACT and alternative-explanation-as-Evidence are rejected by Domain contract", () => {
  withDb((connection, repo) => {
    seedEvidenceAndReportContentBase(connection, repo);
    connection.transaction(() => {
      assert.throws(() => repo.conflicts.insertConflict({ ...CONFLICT, epistemic_status: "FACT" }), expectCode("DOMAIN_VALIDATION_ERROR"));
      assert.throws(() => repo.conflicts.insertConflict({ ...CONFLICT, alternative_explanations: [{ text: "Synthetic", epistemic_status: "INFERENCE", evidence_ids: [EVIDENCE.evidence_id] }] }), expectCode("DOMAIN_VALIDATION_ERROR"));
    });
  });
});

test("25. Conflict claim/counter Evidence missing or cross-report is rejected", () => {
  withDb((connection, repo) => {
    seedEvidenceAndReportContentBase(connection, repo);
    connection.transaction(() => {
      assert.throws(() => repo.conflicts.insertConflict({ ...CONFLICT, claim_a: { ...CONFLICT.claim_a, evidence_ids: ["ev_missing"] } }), expectCode("PERSISTENCE_NOT_FOUND"));
      assert.throws(() => repo.conflicts.insertConflict({ ...CONFLICT, counter_evidence_ids: ["ev_missing"] }), expectCode("PERSISTENCE_NOT_FOUND"));
    });
    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: REPORT_V2, version_number: 2, parent_report_version_id: REPORT_V1 });
    connection.transaction(() => repo.reports.transitionLifecycle(REPORT_V2, "RUNNING", "2026-09-24T11:09:00.000Z"));
    connection.transaction(() => assert.throws(() => repo.conflicts.insertConflict({ ...CONFLICT, conflict_id: "cfl_cp3d2_cross", report_version_id: REPORT_V2 }), expectCode("PERSISTENCE_INTEGRITY_ERROR")));
  });
});

test("26. Conflict same-ID semantic mutation is rejected", () => {
  withDb((connection, repo) => {
    seedEvidenceAndReportContentBase(connection, repo);
    insertConflict(connection, repo);
    connection.transaction(() => assert.throws(() => repo.conflicts.insertConflict({ ...CONFLICT, conflict_reason: "Mutated reason" }), expectCode("IMMUTABILITY_VIOLATION")));
  });
});

// 27-32 Report Content failure injection + recovery.
function assertContentFailureRollsBack(
  mutate: () => { evidence: readonly unknown[]; commitments: readonly unknown[]; changes: readonly unknown[]; conflicts: readonly unknown[] },
  startStatus: "DRAFT" | "RUNNING" = "RUNNING",
  completeReport = false,
): void {
  withDb((connection, repo) => {
    seedCore(connection, repo, startStatus);
    const content = mutate();
    assert.throws(() => repo.content.persistReportContent({ report_version_id: REPORT_V1, ...content, completeReport, completionTimestamp: completeReport ? "2026-09-24T11:15:00.000Z" : undefined }));
    assertNoReportContentRows(connection);
    assertReportNotCompleted(repo);
  });
}

test("27. ReportContent Evidence-stage failure rolls back everything", () => {
  assertContentFailureRollsBack(() => ({ evidence: [{ ...EVIDENCE, excerpt: "Wrong" }], commitments: [COMMITMENT], changes: [CHANGE], conflicts: [CONFLICT] }));
});

test("28. ReportContent Commitment-stage failure rolls back Evidence", () => {
  assertContentFailureRollsBack(() => ({ evidence: [EVIDENCE], commitments: [{ ...COMMITMENT, evidence_ids: ["ev_missing"] }], changes: [CHANGE], conflicts: [CONFLICT] }));
});

test("29. ReportContent Change-stage failure rolls back Evidence and Commitment", () => {
  assertContentFailureRollsBack(() => ({ evidence: [EVIDENCE], commitments: [COMMITMENT], changes: [{ ...CHANGE, evidence_ids: ["ev_missing"] }], conflicts: [CONFLICT] }));
});

test("30. ReportContent Conflict-stage failure rolls back Evidence/Commitment/Change", () => {
  assertContentFailureRollsBack(() => ({ evidence: [EVIDENCE], commitments: [COMMITMENT], changes: [CHANGE], conflicts: [{ ...CONFLICT, counter_evidence_ids: ["ev_missing"] }] }));
});

test("31. final DRAFT->COMPLETED transition failure rolls back all newly persisted content", () => {
  assertContentFailureRollsBack(() => ({ evidence: [EVIDENCE], commitments: [COMMITMENT], changes: [CHANGE], conflicts: [CONFLICT] }), "DRAFT", true);
});

test("32. rollback leaves a clean database and corrected retry succeeds exactly once", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo, "RUNNING");
    assert.throws(() => repo.content.persistReportContent({
      report_version_id: REPORT_V1,
      evidence: [EVIDENCE],
      commitments: [COMMITMENT],
      changes: [CHANGE],
      conflicts: [{ ...CONFLICT, counter_evidence_ids: ["ev_missing"] }],
      completeReport: false,
    }));
    assertNoReportContentRows(connection);
    const result = repo.content.persistReportContent({ report_version_id: REPORT_V1, evidence: [EVIDENCE], commitments: [COMMITMENT], changes: [CHANGE], conflicts: [CONFLICT], completeReport: false });
    assert.equal(result.evidence[0]?.outcome, "INSERTED");
    assert.equal(countRows(connection, "evidence"), 1);
    assert.equal(countRows(connection, "commitments"), 1);
    assert.equal(countRows(connection, "changes"), 1);
    assert.equal(countRows(connection, "conflicts"), 1);
  });
});

// 33-36 ProviderCall failures and sensitive-field fail-closed.
test("33. ProviderCall missing Audit/missing Report/cross-Audit relation is rejected", () => {
  withDb((_connection, repo) => {
    assert.throws(() => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, audit_id: "aud_missing", report_version_id: null }), expectCode("PERSISTENCE_NOT_FOUND"));
    seedCore(_connection, repo);
    assert.throws(() => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, report_version_id: "rpt_missing" }), expectCode("PERSISTENCE_NOT_FOUND"));
    const otherAudit = "aud_cp3d2_provider_other";
    const otherPrivacy = "prv_cp3d2_provider_other";
    repo.audits.createAudit({ audit_id: otherAudit, revision_salt: Buffer.alloc(32, 0x6d).toString("base64url"), created_at: "2026-09-24T11:40:00.000Z" });
    repo.privacy.saveConfirmedPrivacyAggregate({ revision: { ...PRIVACY_REVISION, audit_id: otherAudit, privacy_revision_id: otherPrivacy }, records: [{ ...RECORD, audit_id: otherAudit, privacy_revision_id: otherPrivacy, record_revision_id: "rr_cp3d2_provider_other", record_id: "rec_cp3d2_provider_other" }], mappings: [{ ...MAPPING, audit_id: otherAudit, privacy_revision_id: otherPrivacy, mapping_id: "map_cp3d2_provider_other" }] });
    repo.reports.createReportVersion({ ...REPORT_INPUT, report_version_id: "rpt_cp3d2_provider_other", audit_id: otherAudit, privacy_revision_id: otherPrivacy, version_number: 1 });
    assert.throws(() => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, report_version_id: "rpt_cp3d2_provider_other" }), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("34. ProviderCall same-ID mutation and completed-before-start are rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    repo.providerCalls.insertProviderCall(PROVIDER_CALL);
    assert.throws(() => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, status: "MUTATED" }), expectCode("IMMUTABILITY_VIOLATION"));
    assert.throws(() => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, provider_call_id: "pcall_cp3d2_time", completed_at: "2026-09-24T11:09:59.000Z" }), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("35. ProviderCall negative metadata and unknown output_counts key are rejected", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    for (const mutation of [
      { latency_ms: -1 }, { input_record_count: -1 }, { input_size_chars: -1 }, { input_tokens: -1 },
      { output_tokens: -1 }, { total_tokens: -1 }, { cost_amount_micros: -1 }, { retry_count: -1 },
    ]) {
      assert.throws(() => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, provider_call_id: `pcall_cp3d2_neg_${Object.keys(mutation)[0]}`, ...mutation }), expectCode("DOMAIN_VALIDATION_ERROR"));
    }
    assert.throws(() => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, provider_call_id: "pcall_cp3d2_bad_counts", output_counts: { evidence: 1, text: 1 } }), expectCode("DOMAIN_VALIDATION_ERROR"));
  });
});

test("36. ProviderCall forbidden sensitive/payload fields fail closed rather than being picked away", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    const forbidden = ["prompt", "request", "response", "request_body", "response_body", "raw_text", "sanitized_content", "original_value", "revision_salt", "authorization", "api_key", "secret", "mapping"];
    for (const field of forbidden) {
      const value = field === "authorization" ? AUTH_MARKER : SECRET_MARKER;
      assert.throws(
        () => repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, provider_call_id: `pcall_cp3d2_forbidden_${field}`, [field]: value }),
        expectCode("DOMAIN_VALIDATION_ERROR"),
      );
    }
  });
});

// 37-40 SQLite hard-constraint failure injection.
test("37. representative SQLite FK constraints fail closed", () => {
  withDb((connection, _repo) => {
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO canonical_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("rr_fk_missing", "aud_missing", "rec_fk_missing", "prv_missing", "PASTE", "Synthetic", null, null, "text", 0, null));
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO report_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("rpt_fk_missing", "aud_missing", "prv_missing", null, 1, "DRAFT", null, "2026-09-24T12:00:00.000Z", null, null));
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO provider_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("pcall_fk_missing", "aud_missing", null, "S", "P", "M", "2026-09-24T12:00:00.000Z", null, null, "X", null, null, null, null, null, null, null, 0, null, null, null));
  });
});

test("38. representative SQLite CHECK constraints fail closed", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo, "DRAFT");
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO privacy_mappings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("map_secret", AUDIT_ID, PRIVACY_REVISION_ID, "SECRET", "<SECRET_1>", "Synthetic", "synthetic", "[]", 1, "2026-09-24T12:00:00.000Z"));
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO evidence VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("ev_check_bad", REPORT_V1, PRIVACY_REVISION_ID, RECORD_REVISION_ID, RECORD_ID, RECORD.source_name, 0, 0, 5, "Alpha", null, null, "STATEMENT", "INFERENCE", "SOURCE_FACT"));
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO conflicts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("cfl_check_bad", REPORT_V1, "POTENTIAL_CONFLICT", "A", "[]", "B", "[]", "S", null, null, null, "R", "[]", "[]", "[]", "FACT", 1));
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO provider_calls VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("pcall_check_bad", AUDIT_ID, null, "S", "P", "M", "2026-09-24T12:00:00.000Z", null, -1, "X", null, null, null, null, null, null, null, 0, null, null, null));
  });
});

test("39. representative SQLite UNIQUE constraints fail closed", () => {
  withDb((connection, repo) => {
    seedAuditPrivacy(repo);
    repo.reports.createReportVersion(REPORT_INPUT);
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO audits (audit_id, revision_salt, created_at) VALUES (?, ?, ?)`)
      .run("aud_cp3d2_dup_salt", REVISION_SALT, "2026-09-24T12:00:00.000Z"));
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO report_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("rpt_cp3d2_dup_version", AUDIT_ID, PRIVACY_REVISION_ID, null, 1, "DRAFT", null, "2026-09-24T12:01:00.000Z", null, null));
    assert.throws(() => connection.sqlite.prepare(`INSERT INTO canonical_records VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("rr_cp3d2_dup_record", AUDIT_ID, RECORD_ID, PRIVACY_REVISION_ID, "PASTE", "Other Source", null, null, "text", 1, null));
  });
});

test("40. ON DELETE RESTRICT protects referenced Audit, PrivacyRevision, ReportVersion, and CanonicalRecord", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo, "RUNNING");
    insertEvidence(connection, repo);
    insertCommitment(connection, repo);
    assert.throws(() => connection.sqlite.prepare(`DELETE FROM audits WHERE audit_id = ?`).run(AUDIT_ID));
    assert.throws(() => connection.sqlite.prepare(`DELETE FROM privacy_revisions WHERE privacy_revision_id = ?`).run(PRIVACY_REVISION_ID));
    assert.throws(() => connection.sqlite.prepare(`DELETE FROM report_versions WHERE report_version_id = ?`).run(REPORT_V1));
    assert.throws(() => connection.sqlite.prepare(`DELETE FROM canonical_records WHERE record_revision_id = ?`).run(RECORD_REVISION_ID));
  });
});

// 41-43 Corrupted read fail-closed.
test("41. malformed persisted JSON fails closed with JSON_CODEC_ERROR", () => {
  withDb((connection, repo) => {
    seedEvidenceAndReportContentBase(connection, repo);
    insertCommitment(connection, repo);
    connection.sqlite.prepare(`UPDATE commitments SET evidence_ids_json = ? WHERE commitment_id = ?`).run("{malformed", COMMITMENT.commitment_id);
    assert.throws(() => repo.commitments.getCommitmentById(COMMITMENT.commitment_id), expectCode("JSON_CODEC_ERROR"));
  });
});

test("42. syntactically valid but semantically invalid persisted JSON fails closed", () => {
  withDb((connection, repo) => {
    seedEvidenceAndReportContentBase(connection, repo);
    insertCommitment(connection, repo);
    connection.sqlite.prepare(`UPDATE commitments SET evidence_ids_json = ? WHERE commitment_id = ?`).run(JSON.stringify(["not-an-evidence-id"]), COMMITMENT.commitment_id);
    assert.throws(() => repo.commitments.getCommitmentById(COMMITMENT.commitment_id), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("43. corrupted non-JSON row fails closed through Row Mapper / Domain validation", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo, "DRAFT");
    connection.sqlite.prepare(`UPDATE report_versions SET created_at = ? WHERE report_version_id = ?`).run("not-a-datetime", REPORT_V1);
    assert.throws(() => repo.reports.getReportVersionById(REPORT_V1), expectCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

// 44-45 Error safety.
test("44. PersistenceError messages do not leak synthetic secret/Authorization/raw payload values", () => {
  withDb((connection, repo) => {
    seedCore(connection, repo);
    let caught: unknown;
    try {
      repo.providerCalls.insertProviderCall({ ...PROVIDER_CALL, secret: SECRET_MARKER, authorization: AUTH_MARKER });
    } catch (error: unknown) {
      caught = error;
    }
    assert.ok(caught instanceof PersistenceError);
    assert.equal(caught.code, "DOMAIN_VALIDATION_ERROR");
    assert.equal(caught.message.includes(SECRET_MARKER), false);
    assert.equal(caught.message.includes(AUTH_MARKER), false);
    assert.equal(caught.message.includes(RECORD.sanitized_content), false);
    assert.equal(caught.message.includes(MAPPING.original_value), false);
  });
});

test("45. unknown lower-level error normalization uses only the caller-supplied safe message", () => {
  const normalized = normalizePersistenceError(
    new Error(`${SECRET_MARKER} ${AUTH_MARKER}`),
    "TRANSACTION_FAILED",
    "Persistence operation failed safely.",
  );
  assert.equal(normalized.code, "TRANSACTION_FAILED");
  assert.equal(normalized.message, "Persistence operation failed safely.");
  assert.equal(normalized.message.includes(SECRET_MARKER), false);
  assert.equal(normalized.message.includes(AUTH_MARKER), false);
});
