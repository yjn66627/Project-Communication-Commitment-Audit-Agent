import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openPersistenceConnection, type PersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";

const ROLLBACK_AUDIT_ID = "aud_cp3d3_uncommitted";
const LOCK_OWNER_AUDIT_ID = "aud_cp3d3_lock_owner";
const CONTENDER_AUDIT_ID = "aud_cp3d3_contender";
const ROLLBACK_SALT = Buffer.alloc(32, 0x71).toString("base64url");
const OWNER_SALT = Buffer.alloc(32, 0x72).toString("base64url");
const CONTENDER_SALT = Buffer.alloc(32, 0x73).toString("base64url");

function createAuditOnlySchema(connection: PersistenceConnection): void {
  connection.sqlite.exec(`
    CREATE TABLE audits (
      audit_id TEXT PRIMARY KEY NOT NULL,
      revision_salt TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `);
}

function auditCount(connection: PersistenceConnection, auditId: string): number {
  const row = connection.sqlite
    .prepare("SELECT COUNT(*) AS count FROM audits WHERE audit_id = ?")
    .get(auditId) as { count: number };
  return row.count;
}

function isNotFound(error: unknown): boolean {
  return error instanceof PersistenceError && error.code === "PERSISTENCE_NOT_FOUND";
}

test("DEV03 CP-3D3: SQLite two-connection visibility and bounded write contention", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "dev03-cp3d3-lock-"));
  const databasePath = join(directory, "contention.sqlite");
  let connectionA: PersistenceConnection | undefined;
  let connectionB: PersistenceConnection | undefined;
  let connectionC: PersistenceConnection | undefined;

  try {
    connectionA = openPersistenceConnection(databasePath);
    createAuditOnlySchema(connectionA);
    connectionB = openPersistenceConnection(databasePath);
    connectionB.sqlite.pragma("busy_timeout = 75");

    const auditA = new AuditRepository(connectionA);
    const auditB = new AuditRepository(connectionB);

    await t.test("19. two independent persistence connections open with foreign_keys enabled", () => {
      assert.equal(connectionA!.sqlite.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(connectionB!.sqlite.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(connectionA!.sqlite.open, true);
      assert.equal(connectionB!.sqlite.open, true);
    });

    connectionA.sqlite.exec("BEGIN IMMEDIATE");
    auditA.createAudit({
      audit_id: ROLLBACK_AUDIT_ID,
      revision_salt: ROLLBACK_SALT,
      created_at: "2026-09-24T13:00:00.000Z",
    });

    await t.test("20. uncommitted Repository write is invisible to the second connection", () => {
      assert.equal(auditCount(connectionA!, ROLLBACK_AUDIT_ID), 1);
      assert.equal(auditCount(connectionB!, ROLLBACK_AUDIT_ID), 0);
      assert.throws(() => auditB.getAuditById(ROLLBACK_AUDIT_ID), isNotFound);
    });

    connectionA.sqlite.exec("ROLLBACK");

    await t.test("21. rolled-back write remains invisible to the second connection", () => {
      assert.equal(auditCount(connectionA!, ROLLBACK_AUDIT_ID), 0);
      assert.equal(auditCount(connectionB!, ROLLBACK_AUDIT_ID), 0);
    });

    connectionA.sqlite.exec("BEGIN IMMEDIATE");
    auditA.createAudit({
      audit_id: LOCK_OWNER_AUDIT_ID,
      revision_salt: OWNER_SALT,
      created_at: "2026-09-24T13:01:00.000Z",
    });

    let contentionError: unknown;
    try {
      auditB.createAudit({
        audit_id: CONTENDER_AUDIT_ID,
        revision_salt: CONTENDER_SALT,
        created_at: "2026-09-24T13:02:00.000Z",
      });
    } catch (error: unknown) {
      contentionError = error;
    }

    await t.test("22. bounded writer contention fails safely instead of hanging", () => {
      assert.ok(contentionError instanceof Error);
      assert.equal(connectionA!.sqlite.inTransaction, true);
      assert.equal(connectionB!.sqlite.inTransaction, false);
    });

    await t.test("23. failed contender leaves no partial row", () => {
      assert.equal(auditCount(connectionB!, CONTENDER_AUDIT_ID), 0);
    });

    await t.test("24. lock-owner transaction remains intact during contender failure", () => {
      assert.equal(auditCount(connectionA!, LOCK_OWNER_AUDIT_ID), 1);
      assert.equal(auditCount(connectionB!, LOCK_OWNER_AUDIT_ID), 0);
    });

    connectionA.sqlite.exec("COMMIT");

    await t.test("25. contender retry succeeds after writer lock is released", () => {
      const result = auditB.createAudit({
        audit_id: CONTENDER_AUDIT_ID,
        revision_salt: CONTENDER_SALT,
        created_at: "2026-09-24T13:02:00.000Z",
      });
      assert.equal(result.outcome, "INSERTED");
      assert.equal(auditCount(connectionB!, CONTENDER_AUDIT_ID), 1);
      assert.equal(auditCount(connectionB!, LOCK_OWNER_AUDIT_ID), 1);
    });

    connectionA.close();
    connectionA = undefined;
    connectionB.close();
    connectionB = undefined;
    connectionC = openPersistenceConnection(databasePath);

    await t.test("26. close/reopen after contention contains only committed rows", () => {
      assert.equal(connectionC!.sqlite.pragma("foreign_keys", { simple: true }), 1);
      assert.equal(auditCount(connectionC!, ROLLBACK_AUDIT_ID), 0);
      assert.equal(auditCount(connectionC!, LOCK_OWNER_AUDIT_ID), 1);
      assert.equal(auditCount(connectionC!, CONTENDER_AUDIT_ID), 1);
      assert.equal(connectionC!.sqlite.pragma("integrity_check", { simple: true }), "ok");
    });
  } finally {
    if (connectionA?.sqlite.open) {
      if (connectionA.sqlite.inTransaction) connectionA.sqlite.exec("ROLLBACK");
      connectionA.close();
    }
    if (connectionB?.sqlite.open) connectionB.close();
    if (connectionC?.sqlite.open) connectionC.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
