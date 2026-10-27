import type { PersistenceConnection } from "../../db/connection.js";
import { normalizePersistenceError, PersistenceError } from "../../db/persistence-errors.js";
import { ReportAcceptanceRepository, ReportAcceptanceRowSchema } from "../../db/repositories/report-acceptance-repository.js";
import { ReportVersionRepository } from "../../db/repositories/report-version-repository.js";
import { AuditIdSchema, ReportVersionIdSchema } from "../../domain/schemas/base.js";
import { stableCanonicalSerialize } from "../../shared/ids/stable-serialization.js";
import { canonicalDigestV1, deepFreeze, parseAcceptedCanonicalReportV1, type AcceptedCanonicalReportV1 } from "./canonical-report-builder.js";

export type SafeAcceptedReport = Readonly<{
  report_version_id: string;
  audit_id: string;
  privacy_revision_id: string;
  canonical_format_version: 1;
  canonical_digest: string;
  canonical_json: string;
  accepted_at: string;
  canonical_snapshot: AcceptedCanonicalReportV1;
}>;

/** Historical reads decode the immutable stored snapshot; they never rebuild from live authority. */
export class CanonicalReportReadAdapter {
  private readonly acceptances: ReportAcceptanceRepository;
  private readonly versions: ReportVersionRepository;
  constructor(private readonly connection: PersistenceConnection, private readonly ensureOpen: () => void = () => {}) {
    this.acceptances = new ReportAcceptanceRepository(connection);
    this.versions = new ReportVersionRepository(connection);
  }

  #decodeStoredAcceptance(input: unknown, expectedAuditId: string): SafeAcceptedReport {
    try {
      this.ensureOpen();
      const row = ReportAcceptanceRowSchema.safeParse(input);
      if (!row.success || row.data.auditId !== expectedAuditId) throw new Error();
      const r = row.data;
      const snapshot = parseAcceptedCanonicalReportV1(JSON.parse(r.canonicalJson) as unknown);
      const binding = snapshot.binding;
      const report = this.versions.getReportVersionById(r.reportVersionId);
      const storedVersion = snapshot.report.report_version;
      if (stableCanonicalSerialize(snapshot) !== r.canonicalJson || canonicalDigestV1(r.canonicalJson) !== r.canonicalDigest || binding.audit_id !== r.auditId || binding.report_version_id !== r.reportVersionId || binding.privacy_revision_id !== r.privacyRevisionId || snapshot.canonical_format_version !== r.canonicalFormatVersion || report.audit_id !== r.auditId || report.privacy_revision_id !== r.privacyRevisionId || report.version_number !== storedVersion.version_number || report.parent_report_version_id !== storedVersion.parent_report_version_id || report.created_at !== storedVersion.created_at) throw new Error();
      return deepFreeze({ report_version_id: r.reportVersionId, audit_id: r.auditId, privacy_revision_id: r.privacyRevisionId, canonical_format_version: 1 as const, canonical_digest: r.canonicalDigest, canonical_json: r.canonicalJson, accepted_at: r.acceptedAt, canonical_snapshot: snapshot });
    } catch {
      throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Stored accepted report integrity validation failed.");
    }
  }

  getAcceptedSafe(auditId: string, reportVersionId: string): SafeAcceptedReport | undefined {
    try {
      this.ensureOpen();
      if (!AuditIdSchema.safeParse(auditId).success || !ReportVersionIdSchema.safeParse(reportVersionId).success) throw new Error();
      const readPersisted = () => {
        const row = this.acceptances.getByReportVersionId(reportVersionId);
        return row === undefined ? undefined : this.#decodeStoredAcceptance(row, auditId);
      };
      return this.connection.sqlite.inTransaction ? readPersisted() : this.connection.transaction(readPersisted);
    } catch (error) {
      throw normalizePersistenceError(error, "PERSISTENCE_INTEGRITY_ERROR", "Accepted report safe read failed.");
    }
  }

  getLatestAcceptedSafe(auditId: string): SafeAcceptedReport | undefined {
    try {
      this.ensureOpen();
      if (!AuditIdSchema.safeParse(auditId).success) throw new Error();
      const readPersisted = () => {
        const row = this.acceptances.getLatestByAudit(auditId);
        return row === undefined ? undefined : this.#decodeStoredAcceptance(row, auditId);
      };
      return this.connection.sqlite.inTransaction ? readPersisted() : this.connection.transaction(readPersisted);
    } catch (error) {
      throw normalizePersistenceError(error, "PERSISTENCE_INTEGRITY_ERROR", "Latest accepted report safe read failed.");
    }
  }
}
