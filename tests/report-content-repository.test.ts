import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openPersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";
import { ReportContentRepository } from "../src/db/repositories/report-content-repository.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";

const AUDIT_ID = "aud_cp3c4a";
const REVISION_ID = "prv_cp3c4a";
const REPORT_ID = "rpt_cp3c4a_1";
const SECOND_REPORT_ID = "rpt_cp3c4a_2";
const EVIDENCE_ID = "ev_cp3c4a_1";
const REVISION_SALT = Buffer.alloc(32, 0x55).toString("base64url");

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
    content: ReportContentRepository;
  }) => T,
): T {
  const connection = openPersistenceConnection(":memory:");
  createFixtureSchema(connection);
  const audits = new AuditRepository(connection);
  const privacy = new PrivacyRepository(connection, () => "2026-09-24T07:00:00.000Z");
  const reports = new ReportVersionRepository(connection);
  const content = new ReportContentRepository(connection);

  try {
    return operation({ connection, audits, privacy, reports, content });
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
      confirmed_at: "2026-09-24T07:01:00.000Z",
      record_count: 1,
      mapping_count: 0,
    },
    records: [
      {
        record_revision_id: "rr_cp3c4a_a",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c4a_a",
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

function reportInput(overrides: Record<string, unknown> = {}) {
  return {
    report_version_id: REPORT_ID,
    audit_id: AUDIT_ID,
    privacy_revision_id: REVISION_ID,
    parent_report_version_id: null,
    version_number: 1,
    status: "DRAFT",
    changes_summary: null,
    created_at: "2026-09-24T07:02:00.000Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function evidenceInput(overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: EVIDENCE_ID,
    report_version_id: REPORT_ID,
    privacy_revision_id: REVISION_ID,
    record_revision_id: "rr_cp3c4a_a",
    record_id: "rec_cp3c4a_a",
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
    ...overrides,
  };
}

function commitmentInput(overrides: Record<string, unknown> = {}) {
  return {
    commitment_id: "com_cp3c4a_1",
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

function changeInput(overrides: Record<string, unknown> = {}) {
  return {
    change_id: "chg_cp3c4a_1",
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

function conflictInput(overrides: Record<string, unknown> = {}) {
  return {
    conflict_id: "cfl_cp3c4a_1",
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

function validContent(overrides: Partial<{
  evidence: readonly unknown[];
  commitments: readonly unknown[];
  changes: readonly unknown[];
  conflicts: readonly unknown[];
  completeReport: boolean;
  completionTimestamp: string;
}> = {}) {
  return {
    report_version_id: REPORT_ID,
    evidence: [evidenceInput()],
    commitments: [commitmentInput()],
    changes: [changeInput()],
    conflicts: [conflictInput()],
    completeReport: false,
    ...overrides,
  };
}

function seedReport(
  audits: AuditRepository,
  privacy: PrivacyRepository,
  reports: ReportVersionRepository,
): void {
  audits.createAudit({
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: "2026-09-24T07:00:00.000Z",
  });
  privacy.saveConfirmedPrivacyAggregate(primaryAggregate());
  reports.createReportVersion(reportInput());
}

function transition(
  connection: ReturnType<typeof openPersistenceConnection>,
  reports: ReportVersionRepository,
  target: "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED",
  at: string,
) {
  return connection.transaction(() => reports.transitionLifecycle(REPORT_ID, target, at));
}

function rowCount(
  connection: ReturnType<typeof openPersistenceConnection>,
  tableName: "evidence" | "commitments" | "changes" | "conflicts",
): number {
  const row = connection.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}

function assertNoContent(connection: ReturnType<typeof openPersistenceConnection>): void {
  assert.equal(rowCount(connection, "evidence"), 0);
  assert.equal(rowCount(connection, "commitments"), 0);
  assert.equal(rowCount(connection, "changes"), 0);
  assert.equal(rowCount(connection, "conflicts"), 0);
}

test("report content: happy path commits all four semantic content types", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    content.persistReportContent(validContent());
    assert.equal(rowCount(connection, "evidence"), 1);
    assert.equal(rowCount(connection, "commitments"), 1);
    assert.equal(rowCount(connection, "changes"), 1);
    assert.equal(rowCount(connection, "conflicts"), 1);
  });
});

test("report content: Evidence failure rolls back everything", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => content.persistReportContent(validContent({ evidence: [evidenceInput({ excerpt: "Wrong" })] })),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
    assertNoContent(connection);
  });
});

test("report content: Commitment failure rolls back Evidence", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => content.persistReportContent(validContent({ commitments: [commitmentInput({ evidence_ids: ["ev_missing"] })] })),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
    assertNoContent(connection);
  });
});

test("report content: Change failure rolls back Evidence and Commitment", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => content.persistReportContent(validContent({ changes: [changeInput({ evidence_ids: ["ev_missing"] })] })),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
    assertNoContent(connection);
  });
});

test("report content: Conflict failure rolls back Evidence, Commitment, and Change", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => content.persistReportContent(validContent({ conflicts: [conflictInput({ counter_evidence_ids: ["ev_missing"] })] })),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
    assertNoContent(connection);
    assert.notEqual(reports.getReportVersionById(REPORT_ID).status, "COMPLETED");
  });
});

test("report content: mixed report_version_id is rejected", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => content.persistReportContent(validContent({ changes: [changeInput({ report_version_id: SECOND_REPORT_ID })] })),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
    assertNoContent(connection);
  });
});

test("report content: COMPLETED report rejects content write", () => {
  withRepositories(({ connection, audits, privacy, reports, content }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    transition(connection, reports, "COMPLETED", "2026-09-24T07:04:00.000Z");
    assert.throws(() => content.persistReportContent(validContent()), expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("report content: FAILED report rejects content write", () => {
  withRepositories(({ connection, audits, privacy, reports, content }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "FAILED", "2026-09-24T07:03:00.000Z");
    assert.throws(() => content.persistReportContent(validContent()), expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("report content: CANCELLED report rejects content write", () => {
  withRepositories(({ connection, audits, privacy, reports, content }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "CANCELLED", "2026-09-24T07:03:00.000Z");
    assert.throws(() => content.persistReportContent(validContent()), expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"));
  });
});

test("report lifecycle: DRAFT to RUNNING is allowed", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    const updated = transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    assert.equal(updated.status, "RUNNING");
  });
});

test("report lifecycle: DRAFT to FAILED is allowed", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    assert.equal(transition(connection, reports, "FAILED", "2026-09-24T07:03:00.000Z").status, "FAILED");
  });
});

test("report lifecycle: DRAFT to CANCELLED is allowed", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    assert.equal(transition(connection, reports, "CANCELLED", "2026-09-24T07:03:00.000Z").status, "CANCELLED");
  });
});

test("report lifecycle: RUNNING to COMPLETED is allowed", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    assert.equal(transition(connection, reports, "COMPLETED", "2026-09-24T07:04:00.000Z").status, "COMPLETED");
  });
});

test("report lifecycle: RUNNING to FAILED is allowed", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    assert.equal(transition(connection, reports, "FAILED", "2026-09-24T07:04:00.000Z").status, "FAILED");
  });
});

test("report lifecycle: RUNNING to CANCELLED is allowed", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    assert.equal(transition(connection, reports, "CANCELLED", "2026-09-24T07:04:00.000Z").status, "CANCELLED");
  });
});

test("report lifecycle: DRAFT to COMPLETED is rejected", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => connection.transaction(() => reports.transitionLifecycle(REPORT_ID, "COMPLETED", "2026-09-24T07:03:00.000Z")),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("report lifecycle: terminal states cannot reopen", () => {
  for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
    withRepositories(({ connection, audits, privacy, reports }) => {
      seedReport(audits, privacy, reports);
      if (terminal === "COMPLETED") {
        transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
      }
      transition(connection, reports, terminal, "2026-09-24T07:04:00.000Z");
      assert.throws(
        () => connection.transaction(() => reports.transitionLifecycle(REPORT_ID, "RUNNING", "2026-09-24T07:05:00.000Z")),
        expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
      );
    });
  }
});

test("report lifecycle: transition requires an outer transaction", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => reports.transitionLifecycle(REPORT_ID, "RUNNING", "2026-09-24T07:03:00.000Z"),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("report lifecycle: transition preserves immutable report identity fields", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    const before = reports.getReportVersionById(REPORT_ID);
    const after = transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    assert.equal(after.audit_id, before.audit_id);
    assert.equal(after.privacy_revision_id, before.privacy_revision_id);
    assert.equal(after.parent_report_version_id, before.parent_report_version_id);
    assert.equal(after.version_number, before.version_number);
    assert.equal(after.created_at, before.created_at);
  });
});

test("report content: completeReport=true commits content and COMPLETED atomically", () => {
  withRepositories(({ connection, audits, privacy, reports, content }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    const result = content.persistReportContent(validContent({
      completeReport: true,
      completionTimestamp: "2026-09-24T07:04:00.000Z",
    }));
    assert.equal(result.report.status, "COMPLETED");
    assert.equal(rowCount(connection, "evidence"), 1);
    assert.equal(rowCount(connection, "commitments"), 1);
    assert.equal(rowCount(connection, "changes"), 1);
    assert.equal(rowCount(connection, "conflicts"), 1);
  });
});

test("report content: final child failure prevents COMPLETED and rolls back all content", () => {
  withRepositories(({ connection, audits, privacy, reports, content }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    assert.throws(
      () => content.persistReportContent(validContent({
        conflicts: [conflictInput({ counter_evidence_ids: ["ev_missing"] })],
        completeReport: true,
        completionTimestamp: "2026-09-24T07:04:00.000Z",
      })),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
    assertNoContent(connection);
    assert.equal(reports.getReportVersionById(REPORT_ID).status, "RUNNING");
  });
});

test("report content: completeReport=false preserves writable report state", () => {
  withRepositories(({ audits, privacy, reports, content }) => {
    seedReport(audits, privacy, reports);
    const result = content.persistReportContent(validContent({ completeReport: false }));
    assert.equal(result.report.status, "DRAFT");
    assert.equal(reports.getReportVersionById(REPORT_ID).status, "DRAFT");
  });
});

test("report lifecycle: started_at and completed_at follow transition timestamps", () => {
  withRepositories(({ connection, audits, privacy, reports }) => {
    seedReport(audits, privacy, reports);
    const running = transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    assert.equal(running.started_at, "2026-09-24T07:03:00.000Z");
    assert.equal(running.completed_at, null);
    const completed = transition(connection, reports, "COMPLETED", "2026-09-24T07:04:00.000Z");
    assert.equal(completed.started_at, "2026-09-24T07:03:00.000Z");
    assert.equal(completed.completed_at, "2026-09-24T07:04:00.000Z");
  });
});

test("report content: orchestrator owns one transaction and preserves frozen child order", () => {
  const root = process.cwd();
  const orchestratorSource = readFileSync(join(root, "src/db/repositories/report-content-repository.ts"), "utf8");
  assert.equal((orchestratorSource.match(/connection\.transaction\(/g) ?? []).length, 1);

  const evidenceIndex = orchestratorSource.indexOf("this.evidence.insertEvidenceBatch");
  const commitmentIndex = orchestratorSource.indexOf("this.commitments.insertCommitmentBatch");
  const changeIndex = orchestratorSource.indexOf("this.changes.insertChangeBatch");
  const conflictIndex = orchestratorSource.indexOf("this.conflicts.insertConflictBatch");
  assert.ok(evidenceIndex >= 0 && evidenceIndex < commitmentIndex);
  assert.ok(commitmentIndex < changeIndex);
  assert.ok(changeIndex < conflictIndex);

  for (const file of [
    "evidence-repository.ts",
    "commitment-repository.ts",
    "change-repository.ts",
    "conflict-repository.ts",
  ]) {
    const source = readFileSync(join(root, "src/db/repositories", file), "utf8");
    assert.equal((source.match(/connection\.transaction\(/g) ?? []).length, 0);
  }
});

test("report content: empty semantic arrays are allowed and RUNNING report may complete", () => {
  withRepositories(({ connection, audits, privacy, reports, content }) => {
    seedReport(audits, privacy, reports);
    transition(connection, reports, "RUNNING", "2026-09-24T07:03:00.000Z");
    const result = content.persistReportContent({
      report_version_id: REPORT_ID,
      evidence: [],
      commitments: [],
      changes: [],
      conflicts: [],
      completeReport: true,
      completionTimestamp: "2026-09-24T07:04:00.000Z",
    });
    assert.equal(result.report.status, "COMPLETED");
    assertNoContent(connection);
  });
});

test("report content: identical semantic content can be retried while report remains writable", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    content.persistReportContent(validContent({ completeReport: false }));
    content.persistReportContent(validContent({ completeReport: false }));
    assert.equal(rowCount(connection, "evidence"), 1);
    assert.equal(rowCount(connection, "commitments"), 1);
    assert.equal(rowCount(connection, "changes"), 1);
    assert.equal(rowCount(connection, "conflicts"), 1);
    assert.equal(reports.getReportVersionById(REPORT_ID).status, "DRAFT");
  });
});

test("report content: DRAFT completeReport attempt rolls back content when COMPLETED transition is illegal", () => {
  withRepositories(({ audits, privacy, reports, content, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => content.persistReportContent(validContent({
        completeReport: true,
        completionTimestamp: "2026-09-24T07:04:00.000Z",
      })),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
    assertNoContent(connection);
    assert.equal(reports.getReportVersionById(REPORT_ID).status, "DRAFT");
  });
});
