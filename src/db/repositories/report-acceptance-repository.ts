import { asc, desc, eq, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import type { PersistenceConnection } from "../connection.js";
import { normalizePersistenceError, PersistenceError } from "../persistence-errors.js";
import { IsoUtcTextSchema } from "../persistence/persistence-types.js";
import { reportAcceptances, reportVersions } from "../schema.js";
import { AuditIdSchema, PrivacyRevisionIdSchema, ReportVersionIdSchema } from "../../domain/schemas/base.js";

export const ReportAcceptanceRowSchema = z.object({
  reportVersionId: ReportVersionIdSchema,
  auditId: AuditIdSchema,
  privacyRevisionId: PrivacyRevisionIdSchema,
  canonicalFormatVersion: z.literal(1),
  canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  canonicalJson: z.string().min(1),
  acceptedAt: IsoUtcTextSchema.refine((value) => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value, "Acceptance timestamp must be normalized UTC milliseconds."),
}).strict();
export type ReportAcceptanceRow = z.infer<typeof ReportAcceptanceRowSchema>;

function validatedRow(input: unknown): ReportAcceptanceRow {
  const parsed = ReportAcceptanceRowSchema.safeParse(input);
  if (!parsed.success) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Report acceptance row validation failed.");
  return parsed.data;
}

/** Insert-only API. The application owns full V1 integrity and the outer acceptance transaction. */
export class ReportAcceptanceRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  getByReportVersionId(reportVersionId: string): ReportAcceptanceRow | undefined {
    try {
      const row = this.connection.db.select().from(reportAcceptances).where(eq(reportAcceptances.reportVersionId, reportVersionId)).get();
      return row === undefined ? undefined : validatedRow(row);
    } catch (error) {
      throw normalizePersistenceError(error, "PERSISTENCE_INTEGRITY_ERROR", "Report acceptance read failed.");
    }
  }

  getLatestByAudit(auditId: string): ReportAcceptanceRow | undefined {
    try {
      const rows = this.connection.db.select({ ...getTableColumns(reportAcceptances), authorityAuditId: reportVersions.auditId, authorityPrivacyRevisionId: reportVersions.privacyRevisionId, authorityVersionNumber: reportVersions.versionNumber }).from(reportAcceptances)
        .leftJoin(reportVersions, eq(reportVersions.reportVersionId, reportAcceptances.reportVersionId))
        .where(eq(reportVersions.auditId, auditId))
        .orderBy(desc(reportVersions.versionNumber), asc(reportAcceptances.reportVersionId)).all();
      // Select by ReportVersion's Audit authority, then reject any mutable acceptance binding mismatch.
      for (const row of rows) {
        if (row.authorityAuditId !== row.auditId || row.authorityPrivacyRevisionId !== row.privacyRevisionId || row.authorityVersionNumber === null) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Latest accepted report binding is invalid.");
      }
      const row = rows[0];
      if (row === undefined) return undefined;
      const { authorityAuditId: _audit, authorityPrivacyRevisionId: _privacy, authorityVersionNumber: _number, ...acceptance } = row;
      return validatedRow(acceptance);
    } catch (error) {
      throw normalizePersistenceError(error, "PERSISTENCE_INTEGRITY_ERROR", "Latest accepted report read failed.");
    }
  }

  insertImmutable(input: unknown): ReportAcceptanceRow {
    if (!this.connection.sqlite.inTransaction) throw new PersistenceError("TRANSACTION_FAILED", "Acceptance insert requires its outer transaction.");
    const value = validatedRow(input);
    try {
      if (this.getByReportVersionId(value.reportVersionId) !== undefined) throw new PersistenceError("IMMUTABILITY_VIOLATION", "An existing report acceptance cannot be replaced.");
      this.connection.db.insert(reportAcceptances).values(value).run();
      const inserted = this.getByReportVersionId(value.reportVersionId);
      if (inserted === undefined) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Acceptance insert did not produce a readable row.");
      return inserted;
    } catch (error) {
      throw normalizePersistenceError(error, "TRANSACTION_FAILED", "Report acceptance insert failed.");
    }
  }
}
