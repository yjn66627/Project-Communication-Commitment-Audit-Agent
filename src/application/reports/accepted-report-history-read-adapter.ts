import { asc, eq, or } from "drizzle-orm";
import type { PersistenceConnection } from "../../db/connection.js";
import { PersistenceError } from "../../db/persistence-errors.js";
import { IsoUtcTextSchema } from "../../db/persistence/persistence-types.js";
import { reportAcceptances, reportVersions } from "../../db/schema.js";
import { AuditIdSchema, ReportVersionIdSchema } from "../../domain/schemas/base.js";
import { CanonicalDigestSchema } from "./canonical-report-builder.js";

export type AcceptedReportHistoryItem = Readonly<{ reportVersionId: string; versionNumber: number; acceptedAt: string }>;

/** Metadata-only listing; body integrity remains the C2 CanonicalReportReadAdapter's responsibility. */
export class AcceptedReportHistoryReadAdapter {
  constructor(private readonly connection: PersistenceConnection, private readonly ensureOpen: () => void = () => {}) {}

  listAccepted(auditId: string): readonly AcceptedReportHistoryItem[] {
    this.ensureOpen();
    if (!AuditIdSchema.safeParse(auditId).success) throw new PersistenceError("DOMAIN_VALIDATION_ERROR", "Accepted history Audit identity is invalid.");
    try {
      const rows = this.connection.db.select({
        reportVersionId: reportAcceptances.reportVersionId,
        acceptanceAuditId: reportAcceptances.auditId,
        acceptancePrivacyRevisionId: reportAcceptances.privacyRevisionId,
        canonicalDigest: reportAcceptances.canonicalDigest,
        acceptedAt: reportAcceptances.acceptedAt,
        authorityAuditId: reportVersions.auditId,
        authorityPrivacyRevisionId: reportVersions.privacyRevisionId,
        authorityStatus: reportVersions.status,
        versionNumber: reportVersions.versionNumber,
      }).from(reportAcceptances).leftJoin(reportVersions, eq(reportVersions.reportVersionId, reportAcceptances.reportVersionId))
        .where(or(eq(reportVersions.auditId, auditId), eq(reportAcceptances.auditId, auditId)))
        .orderBy(asc(reportVersions.versionNumber), asc(reportAcceptances.reportVersionId)).all();

      const result: AcceptedReportHistoryItem[] = [];
      for (const row of rows) {
        const valid = row.authorityAuditId === auditId && row.acceptanceAuditId === auditId &&
          row.authorityPrivacyRevisionId === row.acceptancePrivacyRevisionId &&
          row.authorityStatus === "COMPLETED" && ReportVersionIdSchema.safeParse(row.reportVersionId).success && Number.isSafeInteger(row.versionNumber) &&
          CanonicalDigestSchema.safeParse(row.canonicalDigest).success && IsoUtcTextSchema.safeParse(row.acceptedAt).success;
        if (!valid) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Accepted report history binding is invalid.");
        result.push(Object.freeze({ reportVersionId: row.reportVersionId, versionNumber: row.versionNumber!, acceptedAt: row.acceptedAt }));
      }
      return Object.freeze(result);
    } catch (error) {
      if (error instanceof PersistenceError) throw error;
      throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Accepted report history could not be read safely.");
    }
  }
}
