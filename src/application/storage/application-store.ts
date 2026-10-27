import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { openPersistenceConnection, type PersistenceConnection } from "../../db/connection.js";
import { AuditRepository } from "../../db/repositories/audit-repository.js";
import { PrivacyRepository } from "../../db/repositories/privacy-repository.js";
import { PrivacyRevisionReadAdapter } from "../../db/repositories/privacy-revision-read-adapter.js";
import { AuditApplicationService } from "../audits/audit-application-service.js";
import { PrivacyReviewService } from "../privacy/privacy-review-service.js";
import { PrivacyConfirmationAdapter } from "../privacy/privacy-confirmation-adapter.js";
import { CanonicalReportReadAdapter } from "../reports/canonical-report-read-adapter.js";
import { ReportAcceptanceService } from "../reports/report-acceptance-service.js";
import { AcceptedReportHistoryReadAdapter } from "../reports/accepted-report-history-read-adapter.js";
import { ReportApplicationFacade } from "../reports/report-application-facade.js";
import { ApplicationError, assertServerRuntime } from "../errors.js";
import { WorkflowStateReadAdapter } from "../workflow/workflow-state-read-adapter.js";
import { FourFamilyRunService } from "../runs/four-family-run-service.js";
import { ReportRunPersistenceAdapter } from "../runs/report-run-persistence-adapter.js";
import type { FourFamilyProviderPortFactory } from "../runs/four-family-run-ports.js";
import { preparePrivateDataDirectory, resolveApplicationDataDirectory } from "./data-directory.js";
import { InstanceOwner } from "./instance-owner.js";

/** Trusted server bootstrap configuration, never sourced from client DTOs. No databasePath option exists. */
export interface ServerStorageConfiguration {
  readonly environment?: Readonly<{ LOCALAPPDATA?: string }>;
  /** Local failure-injection seam; the production default is the installed Drizzle migrator. */
  readonly migrationRunner?: (connection: PersistenceConnection, migrationsFolder: string) => void;
  /** Optional server composition seam. The factory runs only when an actual Run first reaches a Provider stage. */
  readonly fourFamilyProviderPortFactory?: FourFamilyProviderPortFactory;
}

export class ApplicationStore {
  readonly audits: AuditApplicationService;
  readonly reviews: PrivacyReviewService;
  readonly confirmation: PrivacyConfirmationAdapter;
  readonly privacy: PrivacyRevisionReadAdapter;
  #reports: ReportApplicationFacade;
  #runs: FourFamilyRunService;
  #workflow: WorkflowStateReadAdapter;
  #connection: PersistenceConnection;
  #owner: InstanceOwner;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  /** Bootstrap owns construction. Consumers never receive the connection or DB path. */
  constructor(connection: PersistenceConnection, owner: InstanceOwner, providerFactory?: FourFamilyProviderPortFactory) {
    assertServerRuntime(); this.#connection = connection; this.#owner = owner;
    const ensureOpen = () => {
      if (this.#closing || !connection.sqlite.open) throw new ApplicationError("STORE_CLOSED", "The application store is closed.");
      owner.assertOwned();
    };
    const audits = new AuditRepository(connection);
    this.audits = new AuditApplicationService(connection, ensureOpen);
    this.privacy = new PrivacyRevisionReadAdapter(connection, ensureOpen);
    this.#workflow = new WorkflowStateReadAdapter(connection, ensureOpen);
    this.reviews = new PrivacyReviewService(ensureOpen, (id) => { audits.getAuditLocalIdentity(id); }, (id) => {
      const latest = this.privacy.getLatestLocal(id);
      return latest?.mappings.map((mapping) => ({ audit_id: mapping.audit_id, entity_type: mapping.entity_type,
        placeholder: mapping.placeholder, original_value: mapping.original_value, normalized_key: mapping.normalized_key,
        aliases: mapping.aliases, active: mapping.active, seed_revision_id: latest.revision.privacy_revision_id })) ?? [];
    });
    this.confirmation = new PrivacyConfirmationAdapter(audits, new PrivacyRepository(connection), this.reviews, ensureOpen);
    this.#reports = new ReportApplicationFacade(
      connection,
      new ReportAcceptanceService(connection, undefined, ensureOpen),
      new CanonicalReportReadAdapter(connection, ensureOpen),
      new AcceptedReportHistoryReadAdapter(connection, ensureOpen),
      ensureOpen,
      (auditId) => { this.audits.open(auditId); },
    );
    const ensureRunAccess = () => {
      if (!connection.sqlite.open) throw new ApplicationError("STORE_CLOSED", "The application store is closed.");
      owner.assertOwned();
    };
    const runPersistence = new ReportRunPersistenceAdapter(connection, ensureRunAccess);
    this.#runs = new FourFamilyRunService({ persistence: runPersistence, providerFactory });
  }

  /** Prototype getter keeps the existing enumerable C1 Store capability surface stable. */
  get runs(): FourFamilyRunService { return this.#runs; }
  /** Safe report capability getter; the connection remains private and non-enumerable. */
  get reports(): ReportApplicationFacade { return this.#reports; }
  /** Read-only Workflow metadata; persistence handles remain private. */
  get workflow(): WorkflowStateReadAdapter { return this.#workflow; }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.reviews.clearAll();
    const runsDrained = this.#runs.closeAndDrain();
    this.#closePromise = (async () => {
      await runsDrained;
      await this.confirmation.drain();
      this.#connection.close();
      this.#owner.release();
    })();
    return this.#closePromise;
  }
}

function removeDatabaseSidecars(databasePath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const file = `${databasePath}${suffix}`;
    if (existsSync(file)) unlinkSync(file);
  }
}

function validateMigrationLedger(connection: PersistenceConnection, folder: string, requireComplete: boolean): void {
  const expected = readMigrationFiles({ migrationsFolder: folder });
  const exists = connection.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='__drizzle_migrations'").get();
  const actual = exists ? connection.sqlite.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at, id").all() as { hash: string; created_at: number }[] : [];
  if (actual.length > expected.length || (requireComplete && actual.length !== expected.length) || actual.some((row, index) => row.hash !== expected[index]?.hash || row.created_at !== expected[index]?.folderMillis)) {
    throw new ApplicationError("MIGRATION_LEDGER_INVALID", "The database migration ledger is unsupported or inconsistent.");
  }
}

export async function bootstrapApplicationStore(configuration: ServerStorageConfiguration = {}): Promise<ApplicationStore> {
  assertServerRuntime();
  if (Object.keys(configuration).some((key) => !["environment", "migrationRunner", "fourFamilyProviderPortFactory"].includes(key)) ||
      (configuration.environment && Object.keys(configuration.environment).some((key) => key !== "LOCALAPPDATA")) ||
      (configuration.fourFamilyProviderPortFactory !== undefined && typeof configuration.fourFamilyProviderPortFactory !== "function")) {
    throw new ApplicationError("INVALID_SERVER_CONFIGURATION", "Client database paths and unknown storage options are forbidden.");
  }
  const directory = resolveApplicationDataDirectory(configuration.environment ?? { LOCALAPPDATA: process.env.LOCALAPPDATA });
  preparePrivateDataDirectory(directory);
  const owner = InstanceOwner.acquire(directory);
  const databasePath = path.join(directory, "audit.sqlite");
  const backupPath = path.join(directory, `.migration-recovery.${randomUUID()}.sqlite`);
  const existed = existsSync(databasePath);
  let connection: PersistenceConnection | undefined;
  let backupReady = false;
  try {
    if (readdirSync(directory).some((name) => name.startsWith(".migration-recovery."))) throw new ApplicationError("RECOVERY_REQUIRED", "An interrupted migration requires explicit local recovery.");
    if (existed && (!lstatSync(databasePath).isFile() || lstatSync(databasePath).isSymbolicLink())) throw new ApplicationError("INVALID_DATABASE_FILE", "The storage database file is invalid.");
    connection = openPersistenceConnection(databasePath);
    if (existed) { await connection.sqlite.backup(backupPath); backupReady = true; }
    owner.assertOwned();
    const folder = path.resolve(process.cwd(), "drizzle");
    validateMigrationLedger(connection, folder, false);
    if (configuration.migrationRunner) configuration.migrationRunner(connection, folder);
    else migrate(connection.db, { migrationsFolder: folder });
    validateMigrationLedger(connection, folder, true);
    if ((connection.sqlite.pragma("foreign_key_check") as unknown[]).length !== 0) throw new Error("Foreign key validation failed.");
    const metadataMissing = connection.sqlite.prepare("SELECT a.audit_id FROM audits a LEFT JOIN audit_metadata m ON m.audit_id=a.audit_id WHERE m.audit_id IS NULL OR length(trim(m.display_name))=0").all();
    if (metadataMissing.length !== 0) throw new Error("Metadata incomplete.");
    const repository = new AuditRepository(connection);
    for (const row of connection.sqlite.prepare("SELECT audit_id FROM audits").all() as { audit_id: string }[]) repository.getAuditLocalIdentity(row.audit_id);
    const store = new ApplicationStore(connection, owner, configuration.fourFamilyProviderPortFactory);
    if (backupReady) unlinkSync(backupPath);
    return store; // publication only after migrations and integrity checks have succeeded
  } catch {
    connection?.close();
    try {
      if (backupReady) { removeDatabaseSidecars(databasePath); renameSync(backupPath, databasePath); }
      else if (!existed && connection) { removeDatabaseSidecars(databasePath); if (existsSync(databasePath)) unlinkSync(databasePath); }
    } catch {
      // Keep the owner and backup on uncertain recovery; a later bootstrap must fail closed.
      throw new ApplicationError("STORAGE_RECOVERY_FAILED", "Migration recovery requires explicit local intervention.");
    }
    owner.release();
    throw new ApplicationError("STORAGE_BOOTSTRAP_FAILED", "Storage startup failed; no application store was published.");
  }
}
