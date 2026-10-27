import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openPersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { ProviderCallRepository } from "../src/db/repositories/provider-call-repository.js";

const AUDIT_ID = "aud_cp3c4b";
const REPORT_ID = "rpt_cp3c4b_1";
const REVISION_ID = "prv_cp3c4b";
const OTHER_AUDIT_ID = "aud_cp3c4b_other";
const OTHER_REPORT_ID = "rpt_cp3c4b_other_1";
const OTHER_REVISION_ID = "prv_cp3c4b_other";

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

  const firstSalt = Buffer.alloc(32, 0x66).toString("base64url");
  const secondSalt = Buffer.alloc(32, 0x77).toString("base64url");
  const insertAudit = connection.sqlite.prepare(
    "INSERT INTO audits (audit_id, revision_salt, created_at) VALUES (?, ?, ?)",
  );
  insertAudit.run(AUDIT_ID, firstSalt, "2026-09-24T08:00:00.000Z");
  insertAudit.run(OTHER_AUDIT_ID, secondSalt, "2026-09-24T08:00:01.000Z");

  const insertRevision = connection.sqlite.prepare(`
    INSERT INTO privacy_revisions
      (privacy_revision_id, audit_id, algorithm, confirmed_at, record_count, mapping_count)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  insertRevision.run(
    REVISION_ID,
    AUDIT_ID,
    "privacy-revision-v1",
    "2026-09-24T08:01:00.000Z",
    1,
    0,
  );
  insertRevision.run(
    OTHER_REVISION_ID,
    OTHER_AUDIT_ID,
    "privacy-revision-v1",
    "2026-09-24T08:01:01.000Z",
    1,
    0,
  );

  const insertReport = connection.sqlite.prepare(`
    INSERT INTO report_versions
      (report_version_id, audit_id, privacy_revision_id, parent_report_version_id,
       version_number, status, changes_summary, created_at, started_at, completed_at)
    VALUES (?, ?, ?, NULL, 1, 'RUNNING', NULL, ?, ?, NULL)
  `);
  insertReport.run(
    REPORT_ID,
    AUDIT_ID,
    REVISION_ID,
    "2026-09-24T08:02:00.000Z",
    "2026-09-24T08:02:01.000Z",
  );
  insertReport.run(
    OTHER_REPORT_ID,
    OTHER_AUDIT_ID,
    OTHER_REVISION_ID,
    "2026-09-24T08:02:02.000Z",
    "2026-09-24T08:02:03.000Z",
  );
}

function withRepository<T>(
  operation: (context: {
    connection: ReturnType<typeof openPersistenceConnection>;
    repository: ProviderCallRepository;
  }) => T,
): T {
  const connection = openPersistenceConnection(":memory:");
  createFixtureSchema(connection);
  const repository = new ProviderCallRepository(connection);

  try {
    return operation({ connection, repository });
  } finally {
    connection.close();
  }
}

function providerCallInput(overrides: Record<string, unknown> = {}) {
  return {
    provider_call_id: "pcall_cp3c4b_1",
    audit_id: AUDIT_ID,
    report_version_id: null,
    stage: "SYNTHETIC_STAGE",
    provider_name: "Synthetic Provider",
    model_name: "Synthetic Model",
    started_at: "2026-09-24T08:03:00.000Z",
    completed_at: "2026-09-24T08:03:01.000Z",
    latency_ms: 1000,
    status: "SUCCESS",
    input_record_count: 1,
    input_size_chars: 128,
    input_tokens: 32,
    output_tokens: 16,
    total_tokens: 48,
    cost_amount_micros: 25,
    cost_currency: "USD",
    retry_count: 0,
    schema_valid: true,
    error_category: null,
    output_counts: {
      evidence: 1,
      commitments: 2,
      changes: 3,
      conflicts: 4,
      unknown: 0,
    },
    ...overrides,
  };
}

function expectPersistenceCode(code: string) {
  return (error: unknown): boolean => error instanceof PersistenceError && error.code === code;
}

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

test("1. valid Audit-level ProviderCall insert", () => {
  withRepository(({ repository }) => {
    const result = repository.insertProviderCall(providerCallInput());
    assert.equal(result.outcome, "INSERTED");
    assert.equal(result.value.report_version_id, null);
  });
});

test("2. valid Report-level ProviderCall insert", () => {
  withRepository(({ repository }) => {
    const result = repository.insertProviderCall(
      providerCallInput({ report_version_id: REPORT_ID }),
    );
    assert.equal(result.outcome, "INSERTED");
    assert.equal(result.value.report_version_id, REPORT_ID);
  });
});

test("3. missing Audit rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () => repository.insertProviderCall(providerCallInput({ audit_id: "aud_missing" })),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("4. missing Report rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () =>
        repository.insertProviderCall(
          providerCallInput({ report_version_id: "rpt_missing" }),
        ),
      expectPersistenceCode("PERSISTENCE_NOT_FOUND"),
    );
  });
});

test("5. report from another Audit rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () =>
        repository.insertProviderCall(
          providerCallInput({ report_version_id: OTHER_REPORT_ID }),
        ),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("6. identical reinsert idempotent", () => {
  withRepository(({ repository }) => {
    repository.insertProviderCall(providerCallInput());
    const result = repository.insertProviderCall(providerCallInput());
    assert.equal(result.outcome, "IDEMPOTENT_EXISTING");
  });
});

test("7. same ID different content rejected", () => {
  withRepository(({ repository }) => {
    repository.insertProviderCall(providerCallInput());
    assert.throws(
      () => repository.insertProviderCall(providerCallInput({ status: "FAILED_SAFE_CATEGORY" })),
      expectPersistenceCode("IMMUTABILITY_VIOLATION"),
    );
  });
});

test("8. output_counts round-trip", () => {
  withRepository(({ repository }) => {
    repository.insertProviderCall(providerCallInput());
    assert.deepEqual(repository.getProviderCallById("pcall_cp3c4b_1").output_counts, {
      evidence: 1,
      commitments: 2,
      changes: 3,
      conflicts: 4,
      unknown: 0,
    });
  });
});

test("9. output_counts unknown key rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () =>
        repository.insertProviderCall(
          providerCallInput({ output_counts: { evidence: 1, unexpected: 2 } }),
        ),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("10. negative metadata rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () => repository.insertProviderCall(providerCallInput({ latency_ms: -1 })),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("11. schema_valid true false null round-trip", () => {
  withRepository(({ repository }) => {
    repository.insertProviderCall(providerCallInput({ provider_call_id: "pcall_cp3c4b_true" }));
    repository.insertProviderCall(
      providerCallInput({ provider_call_id: "pcall_cp3c4b_false", schema_valid: false }),
    );
    repository.insertProviderCall(
      providerCallInput({ provider_call_id: "pcall_cp3c4b_null", schema_valid: null }),
    );
    assert.equal(repository.getProviderCallById("pcall_cp3c4b_true").schema_valid, true);
    assert.equal(repository.getProviderCallById("pcall_cp3c4b_false").schema_valid, false);
    assert.equal(repository.getProviderCallById("pcall_cp3c4b_null").schema_valid, null);
  });
});

test("12. nullable usage and cost fields round-trip", () => {
  withRepository(({ repository }) => {
    const result = repository.insertProviderCall(
      providerCallInput({
        completed_at: null,
        latency_ms: null,
        input_record_count: null,
        input_size_chars: null,
        input_tokens: null,
        output_tokens: null,
        total_tokens: null,
        cost_amount_micros: null,
        cost_currency: null,
        schema_valid: null,
        error_category: null,
        output_counts: null,
      }),
    );
    assert.equal(result.value.completed_at, null);
    assert.equal(result.value.total_tokens, null);
    assert.equal(result.value.cost_amount_micros, null);
    assert.equal(result.value.output_counts, null);
  });
});

test("13. deterministic Audit read order", () => {
  withRepository(({ repository }) => {
    repository.insertProviderCall(
      providerCallInput({
        provider_call_id: "pcall_cp3c4b_b",
        started_at: "2026-09-24T08:05:00.000Z",
        completed_at: null,
      }),
    );
    repository.insertProviderCall(
      providerCallInput({
        provider_call_id: "pcall_cp3c4b_c",
        started_at: "2026-09-24T08:04:00.000Z",
        completed_at: null,
      }),
    );
    repository.insertProviderCall(
      providerCallInput({
        provider_call_id: "pcall_cp3c4b_a",
        started_at: "2026-09-24T08:04:00.000Z",
        completed_at: null,
      }),
    );
    assert.deepEqual(
      repository.getProviderCallsByAudit(AUDIT_ID).map((item) => item.provider_call_id),
      ["pcall_cp3c4b_a", "pcall_cp3c4b_c", "pcall_cp3c4b_b"],
    );
  });
});

test("14. deterministic Report read order", () => {
  withRepository(({ repository }) => {
    repository.insertProviderCall(
      providerCallInput({
        provider_call_id: "pcall_cp3c4b_report_b",
        report_version_id: REPORT_ID,
        started_at: "2026-09-24T08:05:00.000Z",
        completed_at: null,
      }),
    );
    repository.insertProviderCall(
      providerCallInput({
        provider_call_id: "pcall_cp3c4b_report_a",
        report_version_id: REPORT_ID,
        started_at: "2026-09-24T08:04:00.000Z",
        completed_at: null,
      }),
    );
    assert.deepEqual(
      repository
        .getProviderCallsByReportVersion(REPORT_ID)
        .map((item) => item.provider_call_id),
      ["pcall_cp3c4b_report_a", "pcall_cp3c4b_report_b"],
    );
  });
});

test("15. forbidden prompt field rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () => repository.insertProviderCall({ ...providerCallInput(), prompt: "Synthetic blocked" }),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("16. forbidden request field rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () =>
        repository.insertProviderCall({
          ...providerCallInput(),
          request_body: "Synthetic blocked",
        }),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("17. forbidden response field rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () =>
        repository.insertProviderCall({
          ...providerCallInput(),
          response_body: "Synthetic blocked",
        }),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("18. forbidden authorization field rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () =>
        repository.insertProviderCall({
          ...providerCallInput(),
          authorization: "Synthetic blocked",
        }),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("19. forbidden secret field rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () => repository.insertProviderCall({ ...providerCallInput(), secret: "Synthetic blocked" }),
      expectPersistenceCode("DOMAIN_VALIDATION_ERROR"),
    );
  });
});

test("20. no update API", () => {
  assert.equal("updateProviderCall" in ProviderCallRepository.prototype, false);
});

test("21. no delete API", () => {
  assert.equal("deleteProviderCall" in ProviderCallRepository.prototype, false);
});

test("22. ProviderCall independent from Report Content transaction", () => {
  withRepository(({ connection, repository }) => {
    assert.equal(connection.sqlite.inTransaction, false);
    const result = repository.insertProviderCall(providerCallInput());
    assert.equal(result.outcome, "INSERTED");
    assert.equal(connection.sqlite.inTransaction, false);
  });
});

test("23. Repository integrated transaction ownership audit", () => {
  const privacy = source("src/db/repositories/privacy-repository.ts");
  const reports = source("src/db/repositories/report-version-repository.ts");
  const content = source("src/db/repositories/report-content-repository.ts");
  const evidence = source("src/db/repositories/evidence-repository.ts");
  const commitments = source("src/db/repositories/commitment-repository.ts");
  const changes = source("src/db/repositories/change-repository.ts");
  const conflicts = source("src/db/repositories/conflict-repository.ts");
  const provider = source("src/db/repositories/provider-call-repository.ts");

  assert.equal((privacy.match(/this\.connection\.transaction\(/g) ?? []).length, 1);
  assert.equal((reports.match(/this\.connection\.transaction\(/g) ?? []).length, 1);
  assert.equal((content.match(/this\.connection\.transaction\(/g) ?? []).length, 1);
  assert.equal((evidence.match(/this\.connection\.transaction\(/g) ?? []).length, 0);
  assert.equal((commitments.match(/this\.connection\.transaction\(/g) ?? []).length, 0);
  assert.equal((changes.match(/this\.connection\.transaction\(/g) ?? []).length, 0);
  assert.equal((conflicts.match(/this\.connection\.transaction\(/g) ?? []).length, 0);
  assert.equal((provider.match(/this\.connection\.transaction\(/g) ?? []).length, 0);
});

test("24. Report lifecycle UPDATE remains limited to lifecycle fields", () => {
  const reports = source("src/db/repositories/report-version-repository.ts");
  assert.equal((reports.match(/\.update\(reportVersions\)/g) ?? []).length, 1);
  assert.match(
    reports,
    /\.set\(\{\s*status:\s*lifecycleRow\.status,\s*startedAt:\s*lifecycleRow\.startedAt,\s*completedAt:\s*lifecycleRow\.completedAt,\s*\}\)/s,
  );
});

test("25. no second Privacy confirmation SOT", () => {
  const schema = source("src/db/schema.ts");
  assert.equal(/(?:text|integer)\(["'](?:confirmed|is_confirmed|confirmation_state|confirmed_flag)["']/.test(schema), false);
  assert.equal((schema.match(/confirmedAt:\s*text\("confirmed_at"\)/g) ?? []).length, 1);
});

test("26. no second input snapshot SOT", () => {
  const schema = source("src/db/schema.ts");
  assert.equal(/input_record_revision_ids|record_revision_ids|snapshot_record_ids/.test(schema), false);
});

test("27. completion timestamp before start is rejected", () => {
  withRepository(({ repository }) => {
    assert.throws(
      () =>
        repository.insertProviderCall(
          providerCallInput({ completed_at: "2026-09-24T08:02:59.000Z" }),
        ),
      expectPersistenceCode("PERSISTENCE_INTEGRITY_ERROR"),
    );
  });
});

test("28. ProviderCall production source contains no direct JSON codec or transaction ownership", () => {
  const provider = source("src/db/repositories/provider-call-repository.ts");
  assert.equal((provider.match(/JSON\.parse\(/g) ?? []).length, 0);
  assert.equal((provider.match(/JSON\.stringify\(/g) ?? []).length, 0);
  assert.equal((provider.match(/\.transaction\(/g) ?? []).length, 0);
});
