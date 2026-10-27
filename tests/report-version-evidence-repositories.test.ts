import assert from "node:assert/strict";
import test from "node:test";

import { openPersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";
import { EvidenceRepository } from "../src/db/repositories/evidence-repository.js";

const AUDIT_ID = "aud_cp3c3a";
const REVISION_ID = "prv_cp3c3a";
const SECOND_REVISION_ID = "prv_cp3c3a_2";
const REPORT_ID = "rpt_cp3c3a_1";
const SECOND_REPORT_ID = "rpt_cp3c3a_2";
const REVISION_SALT = Buffer.alloc(32, 0x22).toString("base64url");

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
  `);
}

function withRepositories<T>(
  operation: (context: {
    connection: ReturnType<typeof openPersistenceConnection>;
    audits: AuditRepository;
    privacy: PrivacyRepository;
    reports: ReportVersionRepository;
    evidence: EvidenceRepository;
  }) => T,
): T {
  const connection = openPersistenceConnection(":memory:");
  createFixtureSchema(connection);
  const audits = new AuditRepository(connection);
  const privacy = new PrivacyRepository(connection, () => "2026-09-24T04:00:00.000Z");
  const reports = new ReportVersionRepository(connection);
  const evidence = new EvidenceRepository(connection);

  try {
    return operation({ connection, audits, privacy, reports, evidence });
  } finally {
    connection.close();
  }
}

function expectPersistenceCode(code: string) {
  return (error: unknown): boolean => error instanceof PersistenceError && error.code === code;
}

function seedAuditAndPrivacy(audits: AuditRepository, privacy: PrivacyRepository): void {
  audits.createAudit({
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: "2026-09-24T03:00:00.000Z",
  });
  privacy.saveConfirmedPrivacyAggregate(primaryAggregate());
}

function primaryAggregate() {
  return {
    revision: {
      privacy_revision_id: REVISION_ID,
      audit_id: AUDIT_ID,
      confirmation_state: "CONFIRMED",
      algorithm: "privacy-revision-v1",
      confirmed_at: "2026-09-24T03:10:00.000Z",
      record_count: 2,
      mapping_count: 0,
    },
    records: [
      {
        record_revision_id: "rr_cp3c3a_a",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c3a_a",
        privacy_revision_id: REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Source A",
        author: null,
        timestamp: null,
        sanitized_content: "Alpha beta gamma.",
        sequence: 0,
      },
      {
        record_revision_id: "rr_cp3c3a_b",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c3a_b",
        privacy_revision_id: REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Source B",
        author: null,
        timestamp: null,
        sanitized_content: "Delta epsilon zeta.",
        sequence: 1,
      },
    ],
    mappings: [],
  };
}

function secondAggregate() {
  return {
    revision: {
      privacy_revision_id: SECOND_REVISION_ID,
      audit_id: AUDIT_ID,
      confirmation_state: "CONFIRMED",
      algorithm: "privacy-revision-v1",
      confirmed_at: "2026-09-24T03:20:00.000Z",
      record_count: 1,
      mapping_count: 0,
    },
    records: [
      {
        record_revision_id: "rr_cp3c3a_other",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c3a_other",
        privacy_revision_id: SECOND_REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Other Source",
        author: null,
        timestamp: null,
        sanitized_content: "Other snapshot content.",
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
    created_at: "2026-09-24T03:30:00.000Z",
    started_at: null,
    completed_at: null,
    ...overrides,
  };
}

function secondReportInput() {
  return reportInput({
    report_version_id: SECOND_REPORT_ID,
    version_number: 2,
    parent_report_version_id: REPORT_ID,
    created_at: "2026-09-24T03:31:00.000Z",
  });
}

function evidenceInput(overrides: Record<string, unknown> = {}) {
  return {
    evidence_id: "ev_cp3c3a_1",
    report_version_id: REPORT_ID,
    privacy_revision_id: REVISION_ID,
    record_revision_id: "rr_cp3c3a_a",
    record_id: "rec_cp3c3a_a",
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

function seedReport(
  audits: AuditRepository,
  privacy: PrivacyRepository,
  reports: ReportVersionRepository,
): void {
  seedAuditAndPrivacy(audits, privacy);
  reports.createReportVersion(reportInput());
}

function writeEvidence<T>(
  connection: ReturnType<typeof openPersistenceConnection>,
  operation: () => T,
): T {
  return connection.transaction(operation);
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

test("report repository: creates ReportVersion", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    const result = reports.createReportVersion(reportInput());
    assert.equal(result.outcome, "INSERTED");
    assert.equal(result.value.report_version_id, REPORT_ID);
  });
});

test("report repository: identical ReportVersion reinsert is idempotent", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    reports.createReportVersion(reportInput());
    assert.equal(reports.createReportVersion(reportInput()).outcome, "IDEMPOTENT_EXISTING");
  });
});

test("report repository: conflicting same ReportVersion ID is rejected", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    reports.createReportVersion(reportInput());
    assert.throws(
      () => reports.createReportVersion(reportInput({ status: "RUNNING" })),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("report repository: missing Privacy Revision is rejected", () => {
  withRepositories(({ audits, reports }) => {
    audits.createAudit({ audit_id: AUDIT_ID, revision_salt: REVISION_SALT, created_at: "2026-09-24T03:00:00.000Z" });
    assert.throws(
      () => reports.createReportVersion(reportInput({ privacy_revision_id: "prv_missing" })),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("report repository: exposes no second snapshot source", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    reports.createReportVersion(reportInput());
    const report = reports.getReportVersionById(REPORT_ID);
    assert.equal("record_revision_ids" in report, false);
    assert.equal("input_record_revision_ids" in report, false);
    assert.equal("snapshot_record_ids" in report, false);
  });
});

test("evidence repository: inserts valid Evidence", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    const result = writeEvidence(connection, () => evidence.insertEvidence(evidenceInput()));
    assert.equal(result.outcome, "INSERTED");
    assert.equal(result.value.evidence_id, "ev_cp3c3a_1");
  });
});

test("evidence repository: FACT and SOURCE_FACT are preserved", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    const saved = writeEvidence(connection, () => evidence.insertEvidence(evidenceInput())).value;
    assert.equal(saved.epistemic_status, "FACT");
    assert.equal(saved.fact_scope, "SOURCE_FACT");
  });
});

test("evidence repository: missing ReportVersion is rejected", () => {
  withRepositories(({ audits, privacy, evidence, connection }) => {
    seedAuditAndPrivacy(audits, privacy);
    assert.throws(
      () => writeEvidence(connection, () => evidence.insertEvidence(evidenceInput())),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("evidence repository: Privacy Revision mismatch is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    privacy.saveConfirmedPrivacyAggregate(secondAggregate());
    assert.throws(
      () => writeEvidence(
        connection,
        () => evidence.insertEvidence(evidenceInput({ privacy_revision_id: SECOND_REVISION_ID })),
      ),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("evidence repository: record revision outside Report snapshot is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    privacy.saveConfirmedPrivacyAggregate(secondAggregate());
    assert.throws(
      () => writeEvidence(connection, () => evidence.insertEvidence(evidenceInput({
        record_revision_id: "rr_cp3c3a_other",
        record_id: "rec_cp3c3a_other",
        source_ref: { source_name: "Synthetic Other Source", sequence: 0, char_start: 0, char_end: 5 },
        excerpt: "Other",
      }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("evidence repository: record_id mismatch is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => writeEvidence(connection, () => evidence.insertEvidence(evidenceInput({ record_id: "rec_wrong" }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("evidence repository: exact excerpt slice passes", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    const saved = writeEvidence(connection, () => evidence.insertEvidence(evidenceInput({
      evidence_id: "ev_cp3c3a_slice",
      source_ref: { source_name: "Synthetic Source A", sequence: 0, char_start: 6, char_end: 10 },
      excerpt: "beta",
    }))).value;
    assert.equal(saved.excerpt, "beta");
  });
});

test("evidence repository: excerpt mismatch is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => writeEvidence(connection, () => evidence.insertEvidence(evidenceInput({ excerpt: "Wrong" }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("evidence repository: out-of-range span is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => writeEvidence(connection, () => evidence.insertEvidence(evidenceInput({
        source_ref: { source_name: "Synthetic Source A", sequence: 0, char_start: 0, char_end: 999 },
        excerpt: "Synthetic",
      }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("evidence repository: identical Evidence reinsert is idempotent", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    writeEvidence(connection, () => evidence.insertEvidence(evidenceInput()));
    assert.equal(
      writeEvidence(connection, () => evidence.insertEvidence(evidenceInput())).outcome,
      "IDEMPOTENT_EXISTING",
    );
  });
});

test("evidence repository: conflicting same Evidence ID is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    writeEvidence(connection, () => evidence.insertEvidence(evidenceInput()));
    assert.throws(
      () => writeEvidence(
        connection,
        () => evidence.insertEvidence(evidenceInput({ actor: "Synthetic Actor" })),
      ),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("evidence repository: valid batch commits atomically", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    const results = writeEvidence(connection, () => evidence.insertEvidenceBatch([
      evidenceInput({ evidence_id: "ev_batch_1" }),
      evidenceInput({
        evidence_id: "ev_batch_2",
        source_ref: { source_name: "Synthetic Source A", sequence: 0, char_start: 6, char_end: 10 },
        excerpt: "beta",
      }),
    ]));
    assert.equal(results.length, 2);
    const count = connection.sqlite.prepare("SELECT COUNT(*) AS count FROM evidence").get() as { count: number };
    assert.equal(count.count, 2);
  });
});

test("evidence repository: child failure rolls back whole batch", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => connection.transaction(() => evidence.insertEvidenceBatch([
        evidenceInput({ evidence_id: "ev_rollback_1" }),
        evidenceInput({ evidence_id: "ev_rollback_2", excerpt: "Wrong" }),
      ])),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
    const count = connection.sqlite.prepare("SELECT COUNT(*) AS count FROM evidence").get() as { count: number };
    assert.equal(count.count, 0);
  });
});

test("evidence repository: mixed ReportVersion batch is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    reports.createReportVersion(secondReportInput());
    assert.throws(
      () => writeEvidence(connection, () => evidence.insertEvidenceBatch([
        evidenceInput({ evidence_id: "ev_mixed_1" }),
        evidenceInput({ evidence_id: "ev_mixed_2", report_version_id: SECOND_REPORT_ID }),
      ])),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("evidence repository: report read ordering is source sequence, char_start, evidence_id", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    writeEvidence(connection, () => evidence.insertEvidenceBatch([
      evidenceInput({
        evidence_id: "ev_order_c",
        record_revision_id: "rr_cp3c3a_b",
        record_id: "rec_cp3c3a_b",
        source_ref: { source_name: "Synthetic Source B", sequence: 1, char_start: 0, char_end: 5 },
        excerpt: "Delta",
      }),
      evidenceInput({
        evidence_id: "ev_order_b",
        source_ref: { source_name: "Synthetic Source A", sequence: 0, char_start: 6, char_end: 10 },
        excerpt: "beta",
      }),
      evidenceInput({ evidence_id: "ev_order_a" }),
    ]));
    assert.deepEqual(
      evidence.getEvidenceByReportVersion(REPORT_ID).map((item) => item.evidence_id),
      ["ev_order_a", "ev_order_b", "ev_order_c"],
    );
  });
});

test("evidence repository: record-revision query returns only matching Evidence", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    writeEvidence(connection, () => evidence.insertEvidenceBatch([
      evidenceInput({ evidence_id: "ev_record_a" }),
      evidenceInput({
        evidence_id: "ev_record_b",
        record_revision_id: "rr_cp3c3a_b",
        record_id: "rec_cp3c3a_b",
        source_ref: { source_name: "Synthetic Source B", sequence: 1, char_start: 0, char_end: 5 },
        excerpt: "Delta",
      }),
    ]));
    assert.deepEqual(
      evidence.getEvidenceByRecordRevision("rr_cp3c3a_a").map((item) => item.evidence_id),
      ["ev_record_a"],
    );
  });
});

test("repositories expose no update or delete API", () => {
  withRepositories(({ reports, evidence }) => {
    assert.equal("updateReportVersion" in reports, false);
    assert.equal("deleteReportVersion" in reports, false);
    assert.equal("updateEvidence" in evidence, false);
    assert.equal("deleteEvidence" in evidence, false);
  });
});

// R1 authority-regression tests begin here. The original 22 test names above are preserved.

test("R1: ReportVersion create owns a transaction and rolls back on transaction failure", () => {
  withRepositories(({ audits, privacy, reports, connection }) => {
    seedAuditAndPrivacy(audits, privacy);
    const originalTransaction = connection.transaction;
    let transactionCalled = false;

    connection.transaction = <T>(operation: () => T): T => originalTransaction(() => {
      transactionCalled = true;
      operation();
      throw new Error("synthetic transaction failure");
    });

    assert.throws(
      () => reports.createReportVersion(reportInput()),
      expectPersistenceCode("TRANSACTION_FAILED"),
    );
    assert.equal(transactionCalled, true);
    const count = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM report_versions WHERE report_version_id = ?")
      .get(REPORT_ID) as { count: number };
    assert.equal(count.count, 0);
  });
});

test("R1: ReportVersion initial COMPLETED status is rejected", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    assert.throws(
      () => reports.createReportVersion(reportInput({ status: "COMPLETED" })),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("R1: ReportVersion initial FAILED status is rejected", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    assert.throws(
      () => reports.createReportVersion(reportInput({ status: "FAILED" })),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("R1: duplicate Audit version number with different ReportVersion ID is rejected", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    reports.createReportVersion(reportInput());
    assert.throws(
      () => reports.createReportVersion(reportInput({
        report_version_id: SECOND_REPORT_ID,
        version_number: 1,
      })),
      expectPersistenceCode("CONFLICTING_EXISTING_ROW"),
    );
  });
});

test("R1: self-parent ReportVersion is rejected", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    assert.throws(
      () => reports.createReportVersion(reportInput({ parent_report_version_id: REPORT_ID })),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("R1: parent version number must be earlier than child version number", () => {
  withRepositories(({ audits, privacy, reports }) => {
    seedAuditAndPrivacy(audits, privacy);
    reports.createReportVersion(reportInput({
      report_version_id: SECOND_REPORT_ID,
      version_number: 2,
      parent_report_version_id: null,
    }));
    assert.throws(
      () => reports.createReportVersion(reportInput({
        report_version_id: REPORT_ID,
        version_number: 1,
        parent_report_version_id: SECOND_REPORT_ID,
      })),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("R1: Evidence write outside Report Content transaction is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence }) => {
    seedReport(audits, privacy, reports);
    assert.throws(
      () => evidence.insertEvidence(evidenceInput()),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("R1: Evidence write inside outer Report Content transaction passes", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    const result = connection.transaction(() => evidence.insertEvidence(evidenceInput({
      evidence_id: "ev_r1_outer_tx",
    })));
    assert.equal(result.outcome, "INSERTED");
  });
});

test("R1: Evidence write to COMPLETED ReportVersion is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    setReportStatus(connection, REPORT_ID, "COMPLETED");
    assert.throws(
      () => connection.transaction(() => evidence.insertEvidence(evidenceInput({ evidence_id: "ev_r1_completed" }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("R1: Evidence write to FAILED ReportVersion is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    setReportStatus(connection, REPORT_ID, "FAILED");
    assert.throws(
      () => connection.transaction(() => evidence.insertEvidence(evidenceInput({ evidence_id: "ev_r1_failed" }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("R1: Evidence write to CANCELLED ReportVersion is rejected", () => {
  withRepositories(({ audits, privacy, reports, evidence, connection }) => {
    seedReport(audits, privacy, reports);
    setReportStatus(connection, REPORT_ID, "CANCELLED");
    assert.throws(
      () => connection.transaction(() => evidence.insertEvidence(evidenceInput({ evidence_id: "ev_r1_cancelled" }))),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});
