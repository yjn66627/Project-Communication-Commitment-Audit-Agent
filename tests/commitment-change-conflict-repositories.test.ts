import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";

import { openPersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";
import { EvidenceRepository } from "../src/db/repositories/evidence-repository.js";
import { CommitmentRepository } from "../src/db/repositories/commitment-repository.js";
import { ChangeRepository } from "../src/db/repositories/change-repository.js";
import { ConflictRepository } from "../src/db/repositories/conflict-repository.js";

const AUDIT_ID = "aud_cp3c3b";
const REVISION_ID = "prv_cp3c3b";
const REPORT_ID = "rpt_cp3c3b_1";
const SECOND_REPORT_ID = "rpt_cp3c3b_2";
const THIRD_REPORT_ID = "rpt_cp3c3b_3";
const SIBLING_REPORT_ID = "rpt_cp3c3b_sibling";
const CROSS_AUDIT_REPORT_ID = "rpt_cp3c3b_other";
const EVIDENCE_ID = "ev_cp3c3b_1";
const SECOND_EVIDENCE_ID = "ev_cp3c3b_2";
const THIRD_EVIDENCE_ID = "ev_cp3c3b_3";
const SIBLING_EVIDENCE_ID = "ev_cp3c3b_sibling";
const CROSS_AUDIT_EVIDENCE_ID = "ev_cp3c3b_other";
const SECOND_AUDIT_ID = "aud_cp3c3b_other";
const SECOND_REVISION_ID = "prv_cp3c3b_other";
const SECOND_REVISION_SALT = Buffer.alloc(32, 0x44).toString("base64url");
const REVISION_SALT = Buffer.alloc(32, 0x33).toString("base64url");

function createFixtureSchema(connection: ReturnType<typeof openPersistenceConnection>): void {
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
      evidence_type TEXT NOT NULL,
      epistemic_status TEXT NOT NULL CHECK(epistemic_status = 'FACT'),
      fact_scope TEXT NOT NULL CHECK(fact_scope = 'SOURCE_FACT'),
      CHECK(char_end > char_start),
      FOREIGN KEY (report_version_id, privacy_revision_id)
        REFERENCES report_versions(report_version_id, privacy_revision_id) ON DELETE RESTRICT,
      FOREIGN KEY (record_revision_id, privacy_revision_id, record_id, source_name, source_sequence)
        REFERENCES canonical_records(record_revision_id, privacy_revision_id, record_id, source_name, sequence)
        ON DELETE RESTRICT
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
      CHECK((classification = 'CONFIRMED' AND epistemic_status = 'FACT') OR (classification = 'CANDIDATE' AND epistemic_status IN ('INFERENCE', 'UNKNOWN')))
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
      CHECK((classification = 'CONFIRMED' AND epistemic_status = 'FACT') OR (classification = 'CANDIDATE' AND epistemic_status IN ('INFERENCE', 'UNKNOWN')))
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
  `);
}

function withRepositories<T>(
  operation: (context: {
    connection: ReturnType<typeof openPersistenceConnection>;
    audits: AuditRepository;
    privacy: PrivacyRepository;
    reports: ReportVersionRepository;
    evidence: EvidenceRepository;
    commitments: CommitmentRepository;
    changes: ChangeRepository;
    conflicts: ConflictRepository;
  }) => T,
): T {
  const connection = openPersistenceConnection(":memory:");
  createFixtureSchema(connection);
  const audits = new AuditRepository(connection);
  const privacy = new PrivacyRepository(connection, () => "2026-09-24T06:00:00.000Z");
  const reports = new ReportVersionRepository(connection);
  const evidence = new EvidenceRepository(connection);
  const commitments = new CommitmentRepository(connection);
  const changes = new ChangeRepository(connection);
  const conflicts = new ConflictRepository(connection);

  try {
    return operation({ connection, audits, privacy, reports, evidence, commitments, changes, conflicts });
  } finally {
    connection.close();
  }
}

function expectPersistenceCode(code: string) {
  return (error: unknown): boolean => error instanceof PersistenceError && error.code === code;
}

function primaryAggregate() {
  return {
    revision: {
      privacy_revision_id: REVISION_ID,
      audit_id: AUDIT_ID,
      confirmation_state: "CONFIRMED",
      algorithm: "privacy-revision-v1",
      confirmed_at: "2026-09-24T06:01:00.000Z",
      record_count: 1,
      mapping_count: 0,
    },
    records: [
      {
        record_revision_id: "rr_cp3c3b_a",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c3b_a",
        privacy_revision_id: REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Source A",
        author: null,
        timestamp: null,
        sanitized_content: "Alpha beta gamma delta.",
        sequence: 0,
      },
    ],
    mappings: [],
  };
}

function secondaryAggregate() {
  return {
    revision: {
      privacy_revision_id: SECOND_REVISION_ID,
      audit_id: SECOND_AUDIT_ID,
      confirmation_state: "CONFIRMED",
      algorithm: "privacy-revision-v1",
      confirmed_at: "2026-09-24T06:10:00.000Z",
      record_count: 1,
      mapping_count: 0,
    },
    records: [
      {
        record_revision_id: "rr_cp3c3b_other",
        audit_id: SECOND_AUDIT_ID,
        record_id: "rec_cp3c3b_other",
        privacy_revision_id: SECOND_REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Source Other",
        author: null,
        timestamp: null,
        sanitized_content: "Omega beta gamma delta.",
        sequence: 0,
      },
    ],
    mappings: [],
  };
}

function reportInput(overrides: Record<string, unknown> = {}) {
  return {
    report_version_id: REPORT_ID,
    audit_id: AUDIT_ID,
    privacy_revision_id: REVISION_ID,
    parent_report_version_id: null,
    version_number: 1,
    status: "DRAFT",
    changes_summary: null,
    created_at: "2026-09-24T06:02:00.000Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function evidenceInput(reportVersionId = REPORT_ID, evidenceId = EVIDENCE_ID) {
  return {
    evidence_id: evidenceId,
    report_version_id: reportVersionId,
    privacy_revision_id: REVISION_ID,
    record_revision_id: "rr_cp3c3b_a",
    record_id: "rec_cp3c3b_a",
    source_ref: {
      source_name: "Synthetic Source A",
      sequence: 0,
      char_start: 0,
      char_end: 5,
    },
    excerpt: "Alpha",
    actor: null,
    timestamp: null,
    evidence_type: "STATEMENT",
    epistemic_status: "FACT",
    fact_scope: "SOURCE_FACT",
  };
}

function seedBase(
  audits: AuditRepository,
  privacy: PrivacyRepository,
  reports: ReportVersionRepository,
  evidence: EvidenceRepository,
  connection: ReturnType<typeof openPersistenceConnection>,
  withSecondReport = false,
): void {
  audits.createAudit({
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: "2026-09-24T06:00:00.000Z",
  });
  privacy.saveConfirmedPrivacyAggregate(primaryAggregate());
  reports.createReportVersion(reportInput());
  connection.transaction(() => evidence.insertEvidence(evidenceInput()));

  if (withSecondReport) {
    reports.createReportVersion(
      reportInput({
        report_version_id: SECOND_REPORT_ID,
        parent_report_version_id: REPORT_ID,
        version_number: 2,
        created_at: "2026-09-24T06:03:00.000Z",
      }),
    );
    connection.transaction(() => evidence.insertEvidence(evidenceInput(SECOND_REPORT_ID, SECOND_EVIDENCE_ID)));
  }
}

function setReportStatus(
  connection: ReturnType<typeof openPersistenceConnection>,
  reportVersionId: string,
  status: "DRAFT" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
): void {
  const result = connection.sqlite
    .prepare("UPDATE report_versions SET status = ? WHERE report_version_id = ?")
    .run(status, reportVersionId);
  assert.equal(result.changes, 1);
}

function commitmentInput(overrides: Record<string, unknown> = {}) {
  return {
    commitment_id: "com_cp3c3b_1",
    report_version_id: REPORT_ID,
    classification: "CONFIRMED",
    epistemic_status: "FACT",
    actor: "Synthetic Actor",
    action_or_deliverable: "Deliver synthetic artifact",
    evidence_ids: [EVIDENCE_ID],
    deadline: null,
    condition: null,
    recipient: null,
    lifecycle_status: "OPEN",
    supersedes_commitment_id: null,
    status_evidence_ids: [],
    ...overrides,
  };
}

function candidateCommitmentInput(overrides: Record<string, unknown> = {}) {
  return commitmentInput({
    commitment_id: "com_cp3c3b_candidate",
    classification: "CANDIDATE",
    epistemic_status: "INFERENCE",
    actor: null,
    ...overrides,
  });
}

function changeInput(overrides: Record<string, unknown> = {}) {
  return {
    change_id: "chg_cp3c3b_1",
    report_version_id: REPORT_ID,
    classification: "CONFIRMED",
    epistemic_status: "FACT",
    change_type: "MODIFY",
    subject: "Synthetic requirement",
    before_summary: "Before",
    after_summary: "After",
    evidence_ids: [EVIDENCE_ID],
    timestamp: null,
    ...overrides,
  };
}

function candidateChangeInput(overrides: Record<string, unknown> = {}) {
  return changeInput({
    change_id: "chg_cp3c3b_candidate",
    classification: "CANDIDATE",
    epistemic_status: "UNKNOWN",
    ...overrides,
  });
}

function conflictInput(overrides: Record<string, unknown> = {}) {
  return {
    conflict_id: "cfl_cp3c3b_1",
    report_version_id: REPORT_ID,
    conflict_type: "POTENTIAL_CONFLICT",
    claim_a: { text: "Claim A", evidence_ids: [EVIDENCE_ID] },
    claim_b: { text: "Claim B", evidence_ids: [EVIDENCE_ID] },
    comparable_context: {
      subject: "Synthetic subject",
      time_context: null,
      version_context: null,
      condition_context: null,
    },
    conflict_reason: "Synthetic statements differ.",
    counter_evidence_ids: [],
    alternative_explanations: [
      { text: "Synthetic alternative", epistemic_status: "INFERENCE" },
    ],
    missing_evidence: [],
    epistemic_status: "INFERENCE",
    conflicted: true,
    ...overrides,
  };
}

// Commitment 1-18

test("commitment repository: inserts valid Confirmed Commitment", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    const result = connection.transaction(() => commitments.insertCommitment(commitmentInput()));
    assert.equal(result.outcome, "INSERTED");
    assert.equal(result.value.classification, "CONFIRMED");
  });
});

test("commitment repository: inserts valid Candidate Commitment", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    const result = connection.transaction(() => commitments.insertCommitment(candidateCommitmentInput()));
    assert.equal(result.value.classification, "CANDIDATE");
    assert.equal(result.value.epistemic_status, "INFERENCE");
  });
});

test("commitment repository: missing Evidence is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({ evidence_ids: ["ev_missing"] }))),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("commitment repository: cross-report Evidence is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection, true);
    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({ evidence_ids: [SECOND_EVIDENCE_ID] }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("commitment repository: FULFILLED status Evidence is validated", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    const result = connection.transaction(() => commitments.insertCommitment(commitmentInput({
      commitment_id: "com_cp3c3b_fulfilled",
      lifecycle_status: "FULFILLED",
      status_evidence_ids: [EVIDENCE_ID],
    })));
    assert.deepEqual(result.value.status_evidence_ids, [EVIDENCE_ID]);
  });
});

test("commitment repository: identical reinsert is idempotent", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => commitments.insertCommitment(commitmentInput()));
    const again = connection.transaction(() => commitments.insertCommitment(commitmentInput()));
    assert.equal(again.outcome, "IDEMPOTENT_EXISTING");
  });
});

test("commitment repository: same ID different content is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => commitments.insertCommitment(commitmentInput()));
    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({ action_or_deliverable: "Changed" }))),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("commitment repository: write outside transaction is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(() => commitments.insertCommitment(commitmentInput()), expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("commitment repository: COMPLETED report is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    setReportStatus(connection, REPORT_ID, "COMPLETED");
    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput())),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("commitment repository: missing supersession target is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({ supersedes_commitment_id: "com_missing" }))),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("commitment repository: self supersession is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({ supersedes_commitment_id: "com_cp3c3b_1" }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("commitment repository: parent-report supersession is accepted", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection, true);
    connection.transaction(() => commitments.insertCommitment(commitmentInput({ commitment_id: "com_cp3c3b_target" })));
    const result = connection.transaction(() => commitments.insertCommitment(commitmentInput({
      commitment_id: "com_cp3c3b_second_report",
      report_version_id: SECOND_REPORT_ID,
      evidence_ids: [SECOND_EVIDENCE_ID],
      supersedes_commitment_id: "com_cp3c3b_target",
    })));
    assert.equal(result.outcome, "INSERTED");
    assert.equal(result.value.supersedes_commitment_id, "com_cp3c3b_target");
  });
});

test("commitment repository: grandparent-report supersession is accepted", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection, true);
    reports.createReportVersion(
      reportInput({
        report_version_id: THIRD_REPORT_ID,
        parent_report_version_id: SECOND_REPORT_ID,
        version_number: 3,
        created_at: "2026-09-24T06:04:00.000Z",
      }),
    );
    connection.transaction(() => evidence.insertEvidence(evidenceInput(THIRD_REPORT_ID, THIRD_EVIDENCE_ID)));
    connection.transaction(() => commitments.insertCommitment(commitmentInput({ commitment_id: "com_cp3c3b_v1_target" })));

    const result = connection.transaction(() => commitments.insertCommitment(commitmentInput({
      commitment_id: "com_cp3c3b_v3_source",
      report_version_id: THIRD_REPORT_ID,
      evidence_ids: [THIRD_EVIDENCE_ID],
      supersedes_commitment_id: "com_cp3c3b_v1_target",
    })));
    assert.equal(result.outcome, "INSERTED");
  });
});

test("commitment repository: sibling-report supersession is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection, true);
    reports.createReportVersion(
      reportInput({
        report_version_id: SIBLING_REPORT_ID,
        parent_report_version_id: REPORT_ID,
        version_number: 3,
        created_at: "2026-09-24T06:04:00.000Z",
      }),
    );
    connection.transaction(() => evidence.insertEvidence(evidenceInput(SIBLING_REPORT_ID, SIBLING_EVIDENCE_ID)));
    connection.transaction(() => commitments.insertCommitment(commitmentInput({
      commitment_id: "com_cp3c3b_sibling_target",
      report_version_id: SECOND_REPORT_ID,
      evidence_ids: [SECOND_EVIDENCE_ID],
    })));

    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({
        commitment_id: "com_cp3c3b_sibling_source",
        report_version_id: SIBLING_REPORT_ID,
        evidence_ids: [SIBLING_EVIDENCE_ID],
        supersedes_commitment_id: "com_cp3c3b_sibling_target",
      }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("commitment repository: cross-audit supersession is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => commitments.insertCommitment(commitmentInput({ commitment_id: "com_cp3c3b_cross_audit_target" })));

    audits.createAudit({
      audit_id: SECOND_AUDIT_ID,
      revision_salt: SECOND_REVISION_SALT,
      created_at: "2026-09-24T06:09:00.000Z",
    });
    privacy.saveConfirmedPrivacyAggregate(secondaryAggregate());
    reports.createReportVersion(reportInput({
      report_version_id: CROSS_AUDIT_REPORT_ID,
      audit_id: SECOND_AUDIT_ID,
      privacy_revision_id: SECOND_REVISION_ID,
      version_number: 1,
      created_at: "2026-09-24T06:11:00.000Z",
    }));
    connection.transaction(() => evidence.insertEvidence({
      ...evidenceInput(CROSS_AUDIT_REPORT_ID, CROSS_AUDIT_EVIDENCE_ID),
      privacy_revision_id: SECOND_REVISION_ID,
      record_revision_id: "rr_cp3c3b_other",
      record_id: "rec_cp3c3b_other",
      source_ref: {
        source_name: "Synthetic Source Other",
        sequence: 0,
        char_start: 0,
        char_end: 5,
      },
      excerpt: "Omega",
    }));

    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({
        commitment_id: "com_cp3c3b_cross_audit_source",
        report_version_id: CROSS_AUDIT_REPORT_ID,
        evidence_ids: [CROSS_AUDIT_EVIDENCE_ID],
        supersedes_commitment_id: "com_cp3c3b_cross_audit_target",
      }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("commitment repository: descendant-report supersession is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection, true);
    connection.transaction(() => commitments.insertCommitment(commitmentInput({
      commitment_id: "com_cp3c3b_future_target",
      report_version_id: SECOND_REPORT_ID,
      evidence_ids: [SECOND_EVIDENCE_ID],
    })));

    assert.throws(
      () => connection.transaction(() => commitments.insertCommitment(commitmentInput({
        commitment_id: "com_cp3c3b_past_source",
        supersedes_commitment_id: "com_cp3c3b_future_target",
      }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("commitment repository: supersession cycle is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => commitments.insertCommitmentBatch([
        commitmentInput({ commitment_id: "com_cp3c3b_cycle_a", supersedes_commitment_id: "com_cp3c3b_cycle_b" }),
        commitmentInput({ commitment_id: "com_cp3c3b_cycle_b", supersedes_commitment_id: "com_cp3c3b_cycle_a" }),
      ])),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
    assert.equal(connection.sqlite.prepare("SELECT COUNT(*) FROM commitments").pluck().get(), 0);
  });
});

test("commitment repository: report read ordering is deterministic", () => {
  withRepositories(({ audits, privacy, reports, evidence, commitments, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => commitments.insertCommitmentBatch([
      commitmentInput({ commitment_id: "com_cp3c3b_z" }),
      commitmentInput({ commitment_id: "com_cp3c3b_a" }),
    ]));
    assert.deepEqual(
      commitments.getCommitmentsByReportVersion(REPORT_ID).map((value) => value.commitment_id),
      ["com_cp3c3b_a", "com_cp3c3b_z"],
    );
  });
});

// Change 19-27

test("change repository: inserts valid Confirmed Change", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    const result = connection.transaction(() => changes.insertChange(changeInput()));
    assert.equal(result.value.classification, "CONFIRMED");
  });
});

test("change repository: inserts valid Candidate Change", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    const result = connection.transaction(() => changes.insertChange(candidateChangeInput()));
    assert.equal(result.value.classification, "CANDIDATE");
  });
});

test("change repository: missing Evidence is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => changes.insertChange(changeInput({ evidence_ids: ["ev_missing"] }))),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("change repository: cross-report Evidence is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection, true);
    assert.throws(
      () => connection.transaction(() => changes.insertChange(changeInput({ evidence_ids: [SECOND_EVIDENCE_ID] }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("change repository: identical reinsert is idempotent", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => changes.insertChange(changeInput()));
    assert.equal(connection.transaction(() => changes.insertChange(changeInput())).outcome, "IDEMPOTENT_EXISTING");
  });
});

test("change repository: same ID different content is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => changes.insertChange(changeInput()));
    assert.throws(
      () => connection.transaction(() => changes.insertChange(changeInput({ after_summary: "Changed" }))),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("change repository: write outside transaction is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(() => changes.insertChange(changeInput()), expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("change repository: closed report states are rejected", () => {
  for (const status of ["FAILED", "CANCELLED", "COMPLETED"] as const) {
    withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
      seedBase(audits, privacy, reports, evidence, connection);
      setReportStatus(connection, REPORT_ID, status);
      assert.throws(
        () => connection.transaction(() => changes.insertChange(changeInput())),
        expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
      );
    });
  }
});

test("change repository: report read ordering is deterministic", () => {
  withRepositories(({ audits, privacy, reports, evidence, changes, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => changes.insertChangeBatch([
      changeInput({ change_id: "chg_cp3c3b_z", timestamp: "2026-09-24T06:20:00Z" }),
      changeInput({ change_id: "chg_cp3c3b_a", timestamp: null }),
      changeInput({ change_id: "chg_cp3c3b_b", timestamp: "2026-09-24T06:10:00Z" }),
    ]));
    assert.deepEqual(
      changes.getChangesByReportVersion(REPORT_ID).map((value) => value.change_id),
      ["chg_cp3c3b_a", "chg_cp3c3b_b", "chg_cp3c3b_z"],
    );
  });
});

// Conflict 28-38

test("conflict repository: inserts valid Potential Conflict", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    const result = connection.transaction(() => conflicts.insertConflict(conflictInput()));
    assert.equal(result.value.conflict_type, "POTENTIAL_CONFLICT");
    assert.equal(result.value.conflicted, true);
  });
});

test("conflict repository: FACT conflict is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => conflicts.insertConflict(conflictInput({ epistemic_status: "FACT" }))),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("conflict repository: claim A missing Evidence is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => conflicts.insertConflict(conflictInput({ claim_a: { text: "A", evidence_ids: ["ev_missing"] } }))),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("conflict repository: claim B cross-report Evidence is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection, true);
    assert.throws(
      () => connection.transaction(() => conflicts.insertConflict(conflictInput({ claim_b: { text: "B", evidence_ids: [SECOND_EVIDENCE_ID] } }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("conflict repository: counter Evidence missing is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(
      () => connection.transaction(() => conflicts.insertConflict(conflictInput({ counter_evidence_ids: ["ev_missing"] }))),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("conflict repository: alternative explanation contract is preserved", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    const result = connection.transaction(() => conflicts.insertConflict(conflictInput({
      conflict_id: "cfl_cp3c3b_alt",
      alternative_explanations: [{ text: "Alternative", epistemic_status: "INFERENCE" }],
    })));
    assert.deepEqual(result.value.alternative_explanations, [
      { text: "Alternative", epistemic_status: "INFERENCE" },
    ]);
    assert.equal("evidence_ids" in result.value.alternative_explanations[0]!, false);
  });
});

test("conflict repository: identical reinsert is idempotent", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => conflicts.insertConflict(conflictInput()));
    assert.equal(connection.transaction(() => conflicts.insertConflict(conflictInput())).outcome, "IDEMPOTENT_EXISTING");
  });
});

test("conflict repository: same ID different content is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => conflicts.insertConflict(conflictInput()));
    assert.throws(
      () => connection.transaction(() => conflicts.insertConflict(conflictInput({ conflict_reason: "Changed" }))),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("conflict repository: write outside transaction is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    assert.throws(() => conflicts.insertConflict(conflictInput()), expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("conflict repository: closed report states are rejected", () => {
  for (const status of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
    withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
      seedBase(audits, privacy, reports, evidence, connection);
      setReportStatus(connection, REPORT_ID, status);
      assert.throws(
        () => connection.transaction(() => conflicts.insertConflict(conflictInput())),
        expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
      );
    });
  }
});

test("conflict repository: report read ordering is deterministic", () => {
  withRepositories(({ audits, privacy, reports, evidence, conflicts, connection }) => {
    seedBase(audits, privacy, reports, evidence, connection);
    connection.transaction(() => conflicts.insertConflictBatch([
      conflictInput({ conflict_id: "cfl_cp3c3b_z" }),
      conflictInput({ conflict_id: "cfl_cp3c3b_a" }),
    ]));
    assert.deepEqual(
      conflicts.getConflictsByReportVersion(REPORT_ID).map((value) => value.conflict_id),
      ["cfl_cp3c3b_a", "cfl_cp3c3b_z"],
    );
  });
});

// API/scope 39-41

test("repository API: no update methods are exposed", () => {
  for (const prototype of [CommitmentRepository.prototype, ChangeRepository.prototype, ConflictRepository.prototype]) {
    assert.equal(Object.getOwnPropertyNames(prototype).some((name) => name.startsWith("update")), false);
  }
});

test("repository API: no delete methods are exposed", () => {
  for (const prototype of [CommitmentRepository.prototype, ChangeRepository.prototype, ConflictRepository.prototype]) {
    assert.equal(Object.getOwnPropertyNames(prototype).some((name) => name.startsWith("delete")), false);
  }
});

test("repository scope: all three child repositories own zero transactions", () => {
  for (const file of [
    "commitment-repository.ts",
    "change-repository.ts",
    "conflict-repository.ts",
  ]) {
    const source = readFileSync(join(process.cwd(), "src", "db", "repositories", file), "utf8");
    assert.equal(source.includes("connection.transaction("), false);
  }
});
