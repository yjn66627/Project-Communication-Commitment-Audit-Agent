import type { PersistenceConnection } from "../../db/connection.js";
import { PersistenceError } from "../../db/persistence-errors.js";
import { ReportVersionRepository } from "../../db/repositories/report-version-repository.js";
import type { ReportVersion } from "../../domain/schemas/report.js";
import type { CanonicalReportReadAdapter } from "./canonical-report-read-adapter.js";
import type { ReportAcceptanceService } from "./report-acceptance-service.js";
import type { AcceptedReportHistoryReadAdapter } from "./accepted-report-history-read-adapter.js";
import { PrivacyRevisionReadAdapter } from "../../db/repositories/privacy-revision-read-adapter.js";

export class ReportDigestConflictError extends Error {
  readonly code = "REPORT_DIGEST_CONFLICT";
  constructor() { super("The report digest does not match the current preview."); this.name = "ReportDigestConflictError"; }
}

export class ReportLifecycleConflictError extends Error {
  readonly code = "REPORT_LIFECYCLE_CONFLICT";
  constructor() { super("The report is no longer eligible for this operation."); this.name = "ReportLifecycleConflictError"; }
}

/** Narrow C2 composition surface. The SQLite connection stays private to this facade. */
export class ReportApplicationFacade {
  #versions: ReportVersionRepository;
  #connection: PersistenceConnection;
  #acceptance: ReportAcceptanceService;
  #reads: CanonicalReportReadAdapter;
  #history: AcceptedReportHistoryReadAdapter;
  #ensureOpen: () => void;
  #requireAudit: (auditId: string) => void;
  constructor(
    connection: PersistenceConnection,
    acceptance: ReportAcceptanceService,
    reads: CanonicalReportReadAdapter,
    history: AcceptedReportHistoryReadAdapter,
    ensureOpen: () => void,
    requireAudit: (auditId: string) => void,
  ) {
    this.#connection = connection;
    this.#acceptance = acceptance;
    this.#reads = reads;
    this.#history = history;
    this.#ensureOpen = ensureOpen;
    this.#requireAudit = requireAudit;
    this.#versions = new ReportVersionRepository(connection);
  }

  previewLatest(auditId: string) {
    this.#ensureOpen();
    this.#requireAudit(auditId);
    const latest = this.#latestReport(auditId);
    if (!latest) throw new PersistenceError("PERSISTENCE_NOT_FOUND", "ReportVersion was not found.");
    this.#assertCurrentEligible(auditId, latest);
    return this.#acceptance.preview({ auditId, reportVersionId: latest.report_version_id });
  }

  accept(auditId: string, reportVersionId: string, expectedCanonicalDigest: string) {
    this.#ensureOpen();
    this.#requireAudit(auditId);
    const report = this.#reportForAudit(auditId, reportVersionId);
    const existing = this.#reads.getAcceptedSafe(auditId, reportVersionId);
    if (existing !== undefined) return this.#acceptance.accept({ auditId, reportVersionId, expectedCanonicalDigest });
    this.#assertCurrentEligible(auditId, report);
    const current = this.#acceptance.preview({ auditId, reportVersionId });
    if (current.canonical_digest !== expectedCanonicalDigest) throw new ReportDigestConflictError();
    return this.#acceptance.accept({ auditId, reportVersionId, expectedCanonicalDigest });
  }

  getAccepted(auditId: string, reportVersionId: string) {
    this.#ensureOpen();
    this.#requireAudit(auditId);
    this.#reportForAudit(auditId, reportVersionId);
    const accepted = this.#reads.getAcceptedSafe(auditId, reportVersionId);
    if (!accepted) throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Accepted report was not found.");
    return accepted;
  }

  getLatestAccepted(auditId: string) {
    this.#ensureOpen();
    this.#requireAudit(auditId);
    return this.#reads.getLatestAcceptedSafe(auditId);
  }

  listAccepted(auditId: string) {
    this.#ensureOpen();
    this.#requireAudit(auditId);
    return this.#history.listAccepted(auditId);
  }

  #reportForAudit(auditId: string, reportVersionId: string): ReportVersion {
    try {
      const report = this.#versions.getReportVersionById(reportVersionId);
      if (report.audit_id !== auditId) throw new PersistenceError("PERSISTENCE_NOT_FOUND", "ReportVersion was not found.");
      return report;
    } catch (error) {
      if (error instanceof PersistenceError && error.code === "PERSISTENCE_NOT_FOUND") throw error;
      throw error;
    }
  }

  #latestReport(auditId: string): ReportVersion | undefined {
    const reports = this.#versions.getReportVersionsByAudit(auditId);
    return [...reports].sort((a, b) => b.version_number - a.version_number || a.report_version_id.localeCompare(b.report_version_id))[0];
  }

  #assertCurrentEligible(auditId: string, report: ReportVersion): void {
    const latest = this.#latestReport(auditId);
    const privacy = new PrivacyRevisionReadAdapter(this.#connection, this.#ensureOpen).getLatestSafe(auditId);
    if (report.status !== "COMPLETED" || latest?.report_version_id !== report.report_version_id ||
        privacy?.revision.audit_id !== auditId || privacy.revision.privacy_revision_id !== report.privacy_revision_id) {
      throw new ReportLifecycleConflictError();
    }
  }
}
