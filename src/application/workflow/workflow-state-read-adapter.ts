import { eq, or } from "drizzle-orm";
import type { PersistenceConnection } from "../../db/connection.js";
import { PersistenceError } from "../../db/persistence-errors.js";
import { IsoUtcTextSchema } from "../../db/persistence/persistence-types.js";
import { AuditRepository } from "../../db/repositories/audit-repository.js";
import { privacyRevisions, reportVersions } from "../../db/schema.js";
import { AuditIdSchema, PrivacyRevisionIdSchema, ReportVersionIdSchema } from "../../domain/schemas/base.js";
import { selectLatestApplicableConfirmedRevision } from "../../privacy/revision/latest-confirmed.js";
import { ApplicationError } from "../errors.js";

export type SettledWorkflowReport = Readonly<{ reportVersionId: string; versionNumber: number; status: "COMPLETED" | "FAILED" }>;
export type WorkflowState = Readonly<{
  auditId: string;
  privacyConfirmed: boolean;
  privacyConfirmedAt: string | null;
  latestSettledReport: SettledWorkflowReport | null;
}>;

const PrivacyId = PrivacyRevisionIdSchema.max(128).regex(/^[A-Za-z0-9_-]+$/u);
const ReportId = ReportVersionIdSchema.max(128).regex(/^[A-Za-z0-9_-]+$/u);

/** Read-only authority metadata. Review memory, report bodies and Provider data are never read. */
export class WorkflowStateReadAdapter {
  #connection: PersistenceConnection;
  #audits: AuditRepository;
  #ensureOpen: () => void;

  constructor(connection: PersistenceConnection, ensureOpen: () => void = () => {}) {
    this.#connection = connection;
    this.#audits = new AuditRepository(connection);
    this.#ensureOpen = ensureOpen;
  }

  get(auditId: string): WorkflowState {
    this.#ensureOpen();
    if (!AuditIdSchema.safeParse(auditId).success) throw new PersistenceError("DOMAIN_VALIDATION_ERROR", "Workflow Audit identity is invalid.");
    try {
      const identity = this.#audits.getAuditLocalIdentity(auditId);
      if (identity.audit_id !== auditId) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Workflow Audit binding is invalid.");
      const revisions = this.#connection.db.select({
        audit_id: privacyRevisions.auditId,
        privacy_revision_id: privacyRevisions.privacyRevisionId,
        confirmed_at: privacyRevisions.confirmedAt,
      }).from(privacyRevisions).where(eq(privacyRevisions.auditId, auditId)).all();
      for (const revision of revisions) {
        if (revision.audit_id !== auditId || !PrivacyId.safeParse(revision.privacy_revision_id).success || !IsoUtcTextSchema.safeParse(revision.confirmed_at).success) {
          throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Workflow Privacy authority is invalid.");
        }
      }
      const latest = selectLatestApplicableConfirmedRevision(auditId, revisions);
      if (revisions.length > 0 && !latest) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Workflow Privacy confirmation time is invalid.");
      const revisionIds = new Set(revisions.map((revision) => revision.privacy_revision_id));
      // Include either side of the Audit binding so corrupt cross-Audit links fail closed.
      const rows = this.#connection.db.select({
        reportVersionId: reportVersions.reportVersionId,
        reportAuditId: reportVersions.auditId,
        reportPrivacyRevisionId: reportVersions.privacyRevisionId,
        privacyAuditId: privacyRevisions.auditId,
        privacyRevisionId: privacyRevisions.privacyRevisionId,
        versionNumber: reportVersions.versionNumber,
        status: reportVersions.status,
      }).from(reportVersions).leftJoin(privacyRevisions, eq(reportVersions.privacyRevisionId, privacyRevisions.privacyRevisionId))
        .where(or(eq(reportVersions.auditId, auditId), eq(privacyRevisions.auditId, auditId))).all();
      let settled: SettledWorkflowReport | null = null;
      for (const row of rows) {
        if (row.reportAuditId !== auditId || row.privacyAuditId !== auditId || row.reportPrivacyRevisionId !== row.privacyRevisionId ||
            !revisionIds.has(row.reportPrivacyRevisionId) || !ReportId.safeParse(row.reportVersionId).success ||
            !Number.isSafeInteger(row.versionNumber) || row.versionNumber <= 0 ||
            !["DRAFT", "RUNNING", "COMPLETED", "FAILED", "CANCELLED"].includes(row.status)) {
          throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Workflow Report authority binding is invalid.");
        }
        if (row.reportPrivacyRevisionId !== latest?.privacy_revision_id || (row.status !== "COMPLETED" && row.status !== "FAILED")) continue;
        if (!settled || row.versionNumber > settled.versionNumber) {
          settled = Object.freeze({ reportVersionId: row.reportVersionId, versionNumber: row.versionNumber, status: row.status });
        }
      }
      return Object.freeze({ auditId, privacyConfirmed: latest !== undefined, privacyConfirmedAt: latest?.confirmed_at ?? null, latestSettledReport: settled });
    } catch (error) {
      if (error instanceof PersistenceError) {
        if (error.code === "PERSISTENCE_NOT_FOUND") throw new ApplicationError("AUDIT_NOT_FOUND", "Audit not found.");
        throw error;
      }
      throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Workflow state could not be read safely.");
    }
  }
}
