import assert from "node:assert/strict";
import test from "node:test";

import { openPersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";

const AUDIT_ID = "aud_cp3c2";
const REVISION_ID = "prv_cp3c2";
const REVISION_SALT = Buffer.alloc(32, 0x11).toString("base64url");
const CREATED_AT = "2026-09-24T00:00:00.000Z";

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
      UNIQUE (audit_id, record_id, privacy_revision_id)
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
  `);
}

function withRepositories<T>(
  operation: (context: {
    connection: ReturnType<typeof openPersistenceConnection>;
    audits: AuditRepository;
    privacy: PrivacyRepository;
  }) => T,
): T {
  const connection = openPersistenceConnection(":memory:");
  createFixtureSchema(connection);
  const audits = new AuditRepository(connection);
  const privacy = new PrivacyRepository(connection, () => "2026-09-24T00:00:01.000Z");

  try {
    return operation({ connection, audits, privacy });
  } finally {
    connection.close();
  }
}

function auditInput(overrides: Record<string, unknown> = {}) {
  return {
    audit_id: AUDIT_ID,
    revision_salt: REVISION_SALT,
    created_at: CREATED_AT,
    ...overrides,
  };
}

function aggregateInput(overrides: Record<string, unknown> = {}) {
  return {
    revision: {
      privacy_revision_id: REVISION_ID,
      audit_id: AUDIT_ID,
      confirmation_state: "CONFIRMED",
      algorithm: "privacy-revision-v1",
      confirmed_at: "2026-09-24T00:10:00.000Z",
      record_count: 3,
      mapping_count: 1,
    },
    records: [
      {
        record_revision_id: "rr_cp3c2_c",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c2_c",
        privacy_revision_id: REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Source",
        author: null,
        timestamp: null,
        sanitized_content: "third",
        sequence: 1,
      },
      {
        record_revision_id: "rr_cp3c2_b",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c2_b",
        privacy_revision_id: REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Source",
        author: null,
        timestamp: null,
        sanitized_content: "second",
        sequence: 0,
      },
      {
        record_revision_id: "rr_cp3c2_a",
        audit_id: AUDIT_ID,
        record_id: "rec_cp3c2_a",
        privacy_revision_id: REVISION_ID,
        source_type: "PASTE",
        source_name: "Synthetic Source",
        author: null,
        timestamp: null,
        sanitized_content: "first",
        sequence: 0,
      },
    ],
    mappings: [
      {
        mapping_id: "map_cp3c2_person_1",
        audit_id: AUDIT_ID,
        privacy_revision_id: REVISION_ID,
        entity_type: "PERSON",
        placeholder: "<PERSON_1>",
        original_value: "Synthetic Original",
        normalized_key: "synthetic-original",
        active: true,
      },
    ],
    ...overrides,
  };
}

function seedAudit(audits: AuditRepository): void {
  audits.createAudit(auditInput());
}

function expectPersistenceCode(code: string) {
  return (error: unknown): boolean => error instanceof PersistenceError && error.code === code;
}

test("audit repository: creates an Audit", () => {
  withRepositories(({ audits }) => {
    const result = audits.createAudit(auditInput());
    assert.equal(result.outcome, "INSERTED");
    assert.deepEqual(result.value, { audit_id: AUDIT_ID, created_at: CREATED_AT });
  });
});

test("audit repository: identical create is idempotent", () => {
  withRepositories(({ audits }) => {
    audits.createAudit(auditInput());
    const retry = audits.createAudit(auditInput());
    assert.equal(retry.outcome, "IDEMPOTENT_EXISTING");
  });
});

test("audit repository: same-id immutable mutation is rejected", () => {
  withRepositories(({ audits }) => {
    audits.createAudit(auditInput());
    assert.throws(
      () => audits.createAudit(auditInput({ created_at: "2026-09-24T00:00:02.000Z" })),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("audit repository: safe read hides revision_salt", () => {
  withRepositories(({ audits }) => {
    audits.createAudit(auditInput());
    const safe = audits.getAuditById(AUDIT_ID);
    assert.equal("revision_salt" in safe, false);
    assert.deepEqual(Object.keys(safe).sort(), ["audit_id", "created_at"]);
  });
});

test("audit repository: explicit local identity can access revision_salt", () => {
  withRepositories(({ audits }) => {
    audits.createAudit(auditInput());
    const local = audits.getAuditLocalIdentity(AUDIT_ID);
    assert.equal(local.revision_salt, REVISION_SALT);
  });
});

test("privacy repository: confirmed aggregate inserts atomically", () => {
  withRepositories(({ audits, privacy, connection }) => {
    seedAudit(audits);
    const result = privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    assert.equal(result.outcome, "INSERTED");

    const revisionCount = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM privacy_revisions")
      .get() as { count: number };
    const recordCount = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM canonical_records")
      .get() as { count: number };
    const mappingCount = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM privacy_mappings")
      .get() as { count: number };

    assert.equal(revisionCount.count, 1);
    assert.equal(recordCount.count, 3);
    assert.equal(mappingCount.count, 1);
  });
});

test("privacy repository: child failure rolls back the entire aggregate", () => {
  withRepositories(({ audits, privacy, connection }) => {
    seedAudit(audits);
    const failing = aggregateInput({
      revision: {
        privacy_revision_id: "prv_cp3c2_rollback",
        audit_id: AUDIT_ID,
        confirmation_state: "CONFIRMED",
        algorithm: "privacy-revision-v1",
        confirmed_at: "2026-09-24T00:20:00.000Z",
        record_count: 2,
        mapping_count: 0,
      },
      records: [
        {
          record_revision_id: "rr_cp3c2_rollback_1",
          audit_id: AUDIT_ID,
          record_id: "rec_cp3c2_duplicate",
          privacy_revision_id: "prv_cp3c2_rollback",
          source_type: "PASTE",
          source_name: "Synthetic Source",
          author: null,
          timestamp: null,
          sanitized_content: "one",
          sequence: 0,
        },
        {
          record_revision_id: "rr_cp3c2_rollback_2",
          audit_id: AUDIT_ID,
          record_id: "rec_cp3c2_duplicate",
          privacy_revision_id: "prv_cp3c2_rollback",
          source_type: "PASTE",
          source_name: "Synthetic Source",
          author: null,
          timestamp: null,
          sanitized_content: "two",
          sequence: 1,
        },
      ],
      mappings: [],
    });

    assert.throws(
      () => privacy.saveConfirmedPrivacyAggregate(failing),
      expectPersistenceCode("TRANSACTION_FAILED"),
    );

    const revisionCount = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM privacy_revisions WHERE privacy_revision_id = ?")
      .get("prv_cp3c2_rollback") as { count: number };
    const recordCount = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM canonical_records WHERE privacy_revision_id = ?")
      .get("prv_cp3c2_rollback") as { count: number };

    assert.equal(revisionCount.count, 0);
    assert.equal(recordCount.count, 0);
  });
});

test("privacy repository: identical historical aggregate reinsert is idempotent", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    const retry = privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    assert.equal(retry.outcome, "IDEMPOTENT_EXISTING");
  });
});

test("privacy repository: conflicting historical revision is rejected", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    const conflicting = aggregateInput({
      revision: {
        privacy_revision_id: REVISION_ID,
        audit_id: AUDIT_ID,
        confirmation_state: "CONFIRMED",
        algorithm: "privacy-revision-v1",
        confirmed_at: "2026-09-24T01:10:00.000Z",
        record_count: 3,
        mapping_count: 1,
      },
    });

    assert.throws(
      () => privacy.saveConfirmedPrivacyAggregate(conflicting),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("privacy repository: privacy_revision_id reconstructs the canonical snapshot", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    const records = privacy.getCanonicalRecordsByPrivacyRevision(REVISION_ID);
    assert.equal(records.length, 3);
    assert.ok(records.every((record) => record.privacy_revision_id === REVISION_ID));
  });
});

test("privacy repository: confirmed revision exposes no second snapshot source", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    const revision = privacy.getConfirmedPrivacyRevision(REVISION_ID);
    assert.equal("record_revision_ids" in revision, false);
    assert.equal("input_record_revision_ids" in revision, false);
    assert.equal("snapshot_record_ids" in revision, false);
  });
});

test("privacy repository: local mapping vault retains original_value", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    const mappings = privacy.getLocalMappingsByPrivacyRevision(REVISION_ID);
    assert.equal(mappings[0]?.original_value, "Synthetic Original");
  });
});

test("privacy repository: safe aggregate does not expose original_value", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    const safe = privacy.getConfirmedPrivacyAggregateSafe(REVISION_ID);
    assert.equal("mappings" in safe, false);
    assert.equal("original_value" in safe, false);
  });
});

test("privacy repository: canonical record ordering is sequence then record_id", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    privacy.saveConfirmedPrivacyAggregate(aggregateInput());
    const records = privacy.getCanonicalRecordsByPrivacyRevision(REVISION_ID);
    assert.deepEqual(
      records.map((record) => record.record_id),
      ["rec_cp3c2_a", "rec_cp3c2_b", "rec_cp3c2_c"],
    );
  });
});

test("privacy repository R1: canonical timestamp must be present even when nullable", () => {
  withRepositories(({ audits, privacy }) => {
    seedAudit(audits);
    const invalid = aggregateInput({
      revision: {
        privacy_revision_id: "prv_cp3c2_r1_missing_timestamp",
        audit_id: AUDIT_ID,
        confirmation_state: "CONFIRMED",
        algorithm: "privacy-revision-v1",
        confirmed_at: "2026-09-24T02:10:00.000Z",
        record_count: 1,
        mapping_count: 0,
      },
      records: [
        {
          record_revision_id: "rr_cp3c2_r1_missing_timestamp",
          audit_id: AUDIT_ID,
          record_id: "rec_cp3c2_r1_missing_timestamp",
          privacy_revision_id: "prv_cp3c2_r1_missing_timestamp",
          source_type: "PASTE",
          source_name: "Synthetic Source",
          author: null,
          sanitized_content: "missing timestamp field",
          sequence: 0,
        },
      ],
      mappings: [],
    });

    assert.throws(
      () => privacy.saveConfirmedPrivacyAggregate(invalid),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});
