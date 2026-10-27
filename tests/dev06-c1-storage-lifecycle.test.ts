import assert from "node:assert/strict";
import test from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openPersistenceConnection, type PersistenceConnection } from "../src/db/connection.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { bootstrapApplicationStore, type ApplicationStore, type ServerStorageConfiguration } from "../src/application/storage/application-store.js";
import { preparePrivateDataDirectory, resolveApplicationDataDirectory } from "../src/application/storage/data-directory.js";
import { ApplicationError } from "../src/application/errors.js";

const OLD_ID = "aud_c1_upgrade_fixture";
const OLD_SALT = Buffer.alloc(32, 0x31).toString("base64url");
const OLD_TIME = "2026-09-24T10:00:00.000Z";

async function fixture(operation: (context: { root: string; config: ServerStorageConfiguration; directory: string; database: string; open: () => Promise<ApplicationStore> }) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "dev06-c1-storage-"));
  const config = { environment: { LOCALAPPDATA: root } };
  const directory = resolveApplicationDataDirectory(config.environment);
  const stores: ApplicationStore[] = [];
  try { await operation({ root, config, directory, database: path.join(directory, "audit.sqlite"), open: async () => { const store = await bootstrapApplicationStore(config); stores.push(store); return store; } }); }
  finally { for (const store of stores) await store.close(); assert.equal(path.dirname(root), tmpdir()); rmSync(root, { recursive: true, force: true }); }
}

function oldDatabase(root: string, directory: string, database: string): void {
  mkdirSync(directory, { recursive: true });
  const folder = path.join(root, "old-migrations"); mkdirSync(path.join(folder, "meta"), { recursive: true });
  copyFileSync(path.resolve("drizzle/0000_robust_cloak.sql"), path.join(folder, "0000_robust_cloak.sql"));
  const journal = JSON.parse(readFileSync(path.resolve("drizzle/meta/_journal.json"), "utf8"));
  writeFileSync(path.join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
  const connection = openPersistenceConnection(database);
  try { migrate(connection.db, { migrationsFolder: folder }); new AuditRepository(connection).createAudit({ audit_id: OLD_ID, revision_salt: OLD_SALT, created_at: OLD_TIME }); }
  finally { connection.close(); }
}

test("C1-01 C1-04 C1-06 C1-07 C1-09 fresh install, named Audit and owner close/reopen", async () => fixture(async ({ open, database, directory }) => {
  const first = await open(); const audit = first.audits.create({ displayName: "  Synthetic project  " });
  assert.equal(audit.displayName, "Synthetic project"); assert.deepEqual(first.audits.open(audit.auditId), audit);
  assert.ok(existsSync(database)); assert.ok(existsSync(path.join(directory, "owner.lock/owner.json")));
  await first.close(); assert.equal(existsSync(path.join(directory, "owner.lock")), false);
  const second = await open(); assert.deepEqual(second.audits.open(audit.auditId), audit);
}));

test("C1-02 C1-10 real 0000 upgrade backfills only audit_id and preserves salt", async () => fixture(async ({ root, directory, database, open }) => {
  oldDatabase(root, directory, database);
  const store = await open(); assert.equal(store.audits.open(OLD_ID).displayName, OLD_ID);
  const db = new Database(database);
  try {
    assert.deepEqual(db.prepare("SELECT * FROM audit_metadata").get(), { audit_id: OLD_ID, display_name: OLD_ID, updated_at: OLD_TIME });
    assert.equal((db.prepare("SELECT revision_salt FROM audits").get() as { revision_salt: string }).revision_salt, OLD_SALT);
    assert.equal((db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n, 2);
  } finally { db.close(); }
  await store.close(); const reopened = await open(); assert.equal(reopened.audits.open(OLD_ID).displayName, OLD_ID);
}));

test("C1-03 failed upgrade restores real SQLite file even after nontransactional mutation", async () => fixture(async ({ root, directory, database, config, open }) => {
  oldDatabase(root, directory, database); let connection: PersistenceConnection | undefined; let published = false;
  await assert.rejects(async () => {
    const result = await bootstrapApplicationStore({ ...config, migrationRunner: (c) => {
      connection = c;
      c.sqlite.exec("CREATE TABLE partial_migration (value TEXT); UPDATE audits SET revision_salt='broken-by-fixture'");
      throw new Error("synthetic migration failure");
    } }); published = true; await result.close();
  }, (error: unknown) => error instanceof ApplicationError && error.code === "STORAGE_BOOTSTRAP_FAILED");
  assert.equal(published, false); assert.equal(connection?.sqlite.open, false);
  const db = new Database(database);
  try {
    assert.equal((db.prepare("SELECT revision_salt FROM audits").get() as { revision_salt: string }).revision_salt, OLD_SALT);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name IN ('partial_migration','audit_metadata')").all().length, 0);
    assert.equal((db.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get() as { n: number }).n, 1);
  } finally { db.close(); }
  assert.equal(readdirSync(directory).some((name) => name.startsWith(".migration-recovery.")), false);
  assert.equal(existsSync(path.join(directory, "owner.lock")), false);
  const recovered = await open(); assert.equal(recovered.audits.open(OLD_ID).displayName, OLD_ID);
}));

test("C1-03 failed fresh migration removes partial file, closes connection and never publishes", async () => fixture(async ({ config, database, directory }) => {
  let connection: PersistenceConnection | undefined;
  await assert.rejects(bootstrapApplicationStore({ ...config, migrationRunner: (c) => { connection = c; c.sqlite.exec("CREATE TABLE partial_migration (value TEXT)"); throw new Error("fixture"); } }));
  assert.equal(connection?.sqlite.open, false); assert.equal(existsSync(database), false);
  assert.equal(existsSync(path.join(directory, "owner.lock")), false);
}));

test("C1-05 second owner denied in both same process and independent Node process", async () => fixture(async ({ open, config, root }) => {
  await open();
  await assert.rejects(bootstrapApplicationStore(config), (error: unknown) => error instanceof ApplicationError && error.code === "OWNER_BUSY");
  const modulePath = path.resolve(__dirname, "../src/application/storage/application-store.js");
  const code = `const {bootstrapApplicationStore}=require(${JSON.stringify(modulePath)}); bootstrapApplicationStore({environment:{LOCALAPPDATA:${JSON.stringify(root)}}}).then(async s=>{await s.close();process.exit(9)}).catch(e=>{process.stdout.write(e.code);process.exit(e.code==='OWNER_BUSY'?0:8)})`;
  const child = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", windowsHide: true });
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, "OWNER_BUSY");
}));

test("C1-03 unsupported migration ledger or silently skipped migrations never publish a Store", async () => fixture(async ({ root, directory, database, config }) => {
  oldDatabase(root, directory, database);
  await assert.rejects(bootstrapApplicationStore({ ...config, migrationRunner: () => undefined }));
  const db = new Database(database);
  try { db.prepare("UPDATE __drizzle_migrations SET hash='fixture-invalid-hash'").run(); } finally { db.close(); }
  await assert.rejects(bootstrapApplicationStore(config));
  const check = new Database(database);
  try {
    assert.equal((check.prepare("SELECT hash FROM __drizzle_migrations").get() as { hash: string }).hash, "fixture-invalid-hash");
    assert.equal(check.prepare("SELECT name FROM sqlite_master WHERE name='audit_metadata'").get(), undefined);
  } finally { check.close(); }
}));

test("C1-04 Windows directory ACL is protected and grants only current user + SYSTEM", async () => fixture(async ({ open, directory }) => {
  await open();
  const code = "$a=[System.IO.Directory]::GetAccessControl($env:DEV06_ACL_FIXTURE); $u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])); $valid=$a.AreAccessRulesProtected -and $rules.Count -eq 2; $seen=@(); foreach($r in $rules){$sid=$r.IdentityReference.Value; $seen+=$sid; if($r.IsInherited -or $r.AccessControlType -ne 'Allow' -or $r.FileSystemRights -ne 'FullControl' -or $sid -notin @($u,'S-1-5-18')){$valid=$false}}; if($valid -and $seen.Contains($u) -and $seen.Contains('S-1-5-18')){[Console]::Write('PASS')}else{[Console]::Write('FAIL')}";
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { env: { ...process.env, DEV06_ACL_FIXTURE: directory }, encoding: "utf8", windowsHide: true });
  assert.equal(result, "PASS");
}));

test("C1-04 stale PID recovery requires mechanically absent owner", async () => fixture(async ({ directory, open }) => {
  preparePrivateDataDirectory(directory);
  const child = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true }); assert.equal(child.status, 0);
  assert.throws(() => process.kill(child.pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  mkdirSync(path.join(directory, "owner.lock")); writeFileSync(path.join(directory, "owner.lock/owner.json"), JSON.stringify({ pid: child.pid, token: randomUUID() }));
  await open(); assert.equal(readdirSync(directory).some((name) => name.startsWith("stale-owner.")), false);
}));

test("C1-04 malformed owner and interrupted migration backup fail closed", async () => fixture(async ({ directory, config, database }) => {
  preparePrivateDataDirectory(directory); mkdirSync(path.join(directory, "owner.lock"));
  const ownerFile = path.join(directory, "owner.lock/owner.json"); const bytes = "malformed-fixture-owner"; writeFileSync(ownerFile, bytes);
  await assert.rejects(bootstrapApplicationStore(config), (error: unknown) => error instanceof ApplicationError && error.code === "OWNER_UNCERTAIN");
  assert.equal(readFileSync(ownerFile, "utf8"), bytes); assert.equal(existsSync(database), false);
  rmSync(path.join(directory, "owner.lock"), { recursive: true });
  writeFileSync(path.join(directory, ".migration-recovery.fixture.sqlite"), "fixture-marker");
  await assert.rejects(bootstrapApplicationStore(config)); assert.equal(existsSync(database), false);
}));

test("C1-08 safe Audit list has stable time/id order and exact DTO allowlist", async () => fixture(async ({ open, database }) => {
  const store = await open(); const a = store.audits.create({ displayName: "First" }); const b = store.audits.create({ displayName: "Second" });
  const db = new Database(database); try { db.prepare("UPDATE audits SET created_at=?").run(OLD_TIME); } finally { db.close(); }
  const list = store.audits.list(); assert.deepEqual(list.map((v) => v.auditId), [a.auditId, b.auditId].sort());
  for (const dto of list) assert.deepEqual(Object.keys(dto).sort(), ["auditId", "displayName", "createdAt"].sort());
  assert.equal(JSON.stringify(list).includes("revisionSalt"), false); assert.equal(JSON.stringify(list).includes("revision_salt"), false);
}));

test("C1-07 name constraints, metadata FK/RESTRICT and identity+metadata atomic rollback", async () => fixture(async ({ open, database }) => {
  const store = await open(); assert.throws(() => store.audits.create({ displayName: " \t\n " }));
  const audit = store.audits.create({ displayName: "Named fixture" }); const db = new Database(database); db.pragma("foreign_keys=ON");
  try {
    assert.throws(() => db.prepare("INSERT INTO audit_metadata VALUES (?, ?, ?)").run("aud_missing", "Valid", OLD_TIME));
    assert.throws(() => db.prepare("UPDATE audit_metadata SET display_name=' ' WHERE audit_id=?").run(audit.auditId));
    assert.throws(() => db.prepare("DELETE FROM audits WHERE audit_id=?").run(audit.auditId));
    db.exec("CREATE TRIGGER fixture_deny_metadata BEFORE INSERT ON audit_metadata BEGIN SELECT RAISE(ABORT,'fixture'); END");
    assert.throws(() => store.audits.create({ displayName: "Must rollback" }));
    assert.equal((db.prepare("SELECT count(*) AS n FROM audits").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM audit_metadata").get() as { n: number }).n, 1);
  } finally { db.close(); }
}));

test("C1-10 salt stays exactly 32-byte canonical base64url across close/reopen", async () => fixture(async ({ open, database }) => {
  const first = await open(); const audit = first.audits.create({ displayName: "Salt fixture" });
  const read = () => { const db = new Database(database); try { return (db.prepare("SELECT revision_salt FROM audits WHERE audit_id=?").get(audit.auditId) as { revision_salt: string }).revision_salt; } finally { db.close(); } };
  const original = read(); assert.equal(Buffer.from(original, "base64url").length, 32); assert.equal(Buffer.from(original, "base64url").toString("base64url"), original);
  await first.close(); const second = await open(); second.audits.open(audit.auditId); assert.equal(read(), original);
}));

test("C1-11 C1-12 corrupt, empty/missing and noncanonical salts fail closed without regeneration", async () => fixture(async ({ open, database, config }) => {
  const store = await open(); const audit = store.audits.create({ displayName: "Corruption fixture" }); const db = new Database(database);
  try {
    for (const value of ["corrupt", "", Buffer.alloc(32, 2).toString("base64")]) {
      db.prepare("UPDATE audits SET revision_salt=? WHERE audit_id=?").run(value, audit.auditId);
      assert.throws(() => store.audits.open(audit.auditId)); assert.throws(() => store.audits.list());
      assert.equal((db.prepare("SELECT revision_salt FROM audits WHERE audit_id=?").get(audit.auditId) as { revision_salt: string }).revision_salt, value);
    }
    assert.throws(() => db.prepare("UPDATE audits SET revision_salt=NULL WHERE audit_id=?").run(audit.auditId));
    assert.throws(() => store.audits.open("aud_absent"));
  } finally { db.close(); }
  await store.close(); await assert.rejects(bootstrapApplicationStore(config));
}));

test("C1-19 DB path/salt fields rejected by strict application inputs; path resolver deterministic", async () => fixture(async ({ open, config }) => {
  assert.equal(resolveApplicationDataDirectory(config.environment), resolveApplicationDataDirectory(config.environment));
  assert.throws(() => resolveApplicationDataDirectory({})); assert.throws(() => resolveApplicationDataDirectory({ LOCALAPPDATA: "relative" }));
  assert.throws(() => resolveApplicationDataDirectory({ LOCALAPPDATA: "\\\\server\\share" }));
  assert.throws(() => resolveApplicationDataDirectory({ LOCALAPPDATA: "\\drive-relative-root" }));
  assert.throws(() => resolveApplicationDataDirectory({ LOCALAPPDATA: "/drive-relative-root" }));
  assert.throws(() => resolveApplicationDataDirectory(config.environment, "linux"));
  await assert.rejects(bootstrapApplicationStore({ ...config, databasePath: "client-controlled" } as ServerStorageConfiguration));
  const store = await open();
  assert.throws(() => store.audits.create({ displayName: "Name", revisionSalt: OLD_SALT }));
  assert.throws(() => store.audits.create({ displayName: "Name", databasePath: "client-controlled" }));
  assert.deepEqual(Object.keys(store).sort(), ["audits", "confirmation", "privacy", "reviews"].sort());
}));
