import { eq } from "drizzle-orm";
import type { PersistenceConnection } from "../connection.js";
import { privacyRevisions } from "../schema.js";
import { AuditRepository } from "./audit-repository.js";
import { PrivacyRepository, type LocalConfirmedPrivacyAggregate, type SafeConfirmedPrivacyAggregate } from "./privacy-repository.js";
import { selectLatestApplicableConfirmedRevision } from "../../privacy/revision/latest-confirmed.js";

/** Local server port. The safe method excludes the reversible mapping vault. */
export class PrivacyRevisionReadAdapter {
  #connection: PersistenceConnection;
  #repository: PrivacyRepository;
  #audits: AuditRepository;
  #ensureOpen: () => void;
  constructor(connection: PersistenceConnection, ensureOpen: () => void) {
    this.#connection = connection;
    this.#repository = new PrivacyRepository(connection);
    this.#audits = new AuditRepository(connection);
    this.#ensureOpen = ensureOpen;
  }
  #latest(auditId: string): string | undefined {
    this.#ensureOpen();
    this.#audits.getAuditLocalIdentity(auditId);
    const rows = this.#connection.db.select({ audit_id: privacyRevisions.auditId, privacy_revision_id: privacyRevisions.privacyRevisionId, confirmed_at: privacyRevisions.confirmedAt })
      .from(privacyRevisions).where(eq(privacyRevisions.auditId, auditId)).all();
    return selectLatestApplicableConfirmedRevision(auditId, rows)?.privacy_revision_id;
  }
  getLatestSafe(auditId: string): SafeConfirmedPrivacyAggregate | undefined {
    const id = this.#latest(auditId);
    return id === undefined ? undefined : this.#repository.getConfirmedPrivacyAggregateSafe(id);
  }
  /** Explicit high-sensitivity local read; never serialize this result to logs/export/client DTOs. */
  getLatestLocal(auditId: string): LocalConfirmedPrivacyAggregate | undefined {
    const id = this.#latest(auditId);
    return id === undefined ? undefined : this.#repository.getConfirmedPrivacyAggregateLocal(id);
  }
}
