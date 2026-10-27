import { and, asc, eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import {
  privacyRevisions,
  reportVersions,
} from "../schema.js";
import {
  reportVersionRowToDomain,
  reportVersionToRow,
} from "../persistence/row-mappers.js";
import {
  ReportVersionSchema,
  ReportVersionStatusSchema,
  type ReportVersion,
} from "../../domain/schemas/report.js";
import {
  semanticEqual,
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

const INITIAL_REPORT_STATUSES = new Set<ReportVersion["status"]>(["DRAFT", "RUNNING"]);

export class ReportVersionRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  createReportVersion(input: unknown): RepositoryWriteResult<ReportVersion> {
    const parsed = ReportVersionSchema.safeParse(input);
    if (!parsed.success) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "ReportVersion input does not satisfy the frozen Domain contract.",
      );
    }
    const value = parsed.data;

    try {
      return this.connection.transaction(() => this.createValidatedReportVersion(value));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "TRANSACTION_FAILED",
        "ReportVersion creation transaction failed.",
      );
    }
  }

  getReportVersionById(reportVersionId: string): ReportVersion {
    try {
      const row = this.connection.db
        .select()
        .from(reportVersions)
        .where(eq(reportVersions.reportVersionId, reportVersionId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "ReportVersion was not found.");
      }

      return reportVersionRowToDomain(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion read operation failed.",
      );
    }
  }

  getReportVersionsByAudit(auditId: string): readonly ReportVersion[] {
    try {
      return this.connection.db
        .select()
        .from(reportVersions)
        .where(eq(reportVersions.auditId, auditId))
        .orderBy(asc(reportVersions.versionNumber), asc(reportVersions.reportVersionId))
        .all()
        .map((row) => reportVersionRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion history read failed.",
      );
    }
  }

  transitionLifecycle(
    reportVersionId: string,
    targetStatusInput: unknown,
    transitionAtInput: unknown,
  ): ReportVersion {
    if (this.connection.sqlite.inTransaction !== true) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion lifecycle transition requires an outer transaction.",
      );
    }

    const targetStatusParsed = ReportVersionStatusSchema.safeParse(targetStatusInput);
    if (!targetStatusParsed.success || typeof transitionAtInput !== "string") {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "ReportVersion lifecycle transition input is invalid.",
      );
    }

    try {
      const currentRow = this.connection.db
        .select()
        .from(reportVersions)
        .where(eq(reportVersions.reportVersionId, reportVersionId))
        .get();

      if (currentRow === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "ReportVersion was not found.");
      }

      const current = reportVersionRowToDomain(currentRow);
      const targetStatus = targetStatusParsed.data;
      if (!this.isAllowedLifecycleTransition(current.status, targetStatus)) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion lifecycle transition is not allowed.",
        );
      }

      const candidate: ReportVersion = {
        ...current,
        status: targetStatus,
        started_at:
          current.status === "DRAFT" && targetStatus === "RUNNING"
            ? current.started_at ?? transitionAtInput
            : current.started_at,
        completed_at:
          targetStatus === "COMPLETED" || targetStatus === "FAILED" || targetStatus === "CANCELLED"
            ? transitionAtInput
            : null,
      };

      const validated = ReportVersionSchema.safeParse(candidate);
      if (!validated.success) {
        throw new PersistenceError(
          "DOMAIN_VALIDATION_ERROR",
          "ReportVersion lifecycle timestamps do not satisfy the frozen Domain contract.",
        );
      }

      const lifecycleRow = reportVersionToRow(validated.data);
      if (lifecycleRow.startedAt === undefined || lifecycleRow.completedAt === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion lifecycle mapper returned an incomplete persistence row.",
        );
      }

      const updateResult = this.connection.db
        .update(reportVersions)
        .set({
          status: lifecycleRow.status,
          startedAt: lifecycleRow.startedAt,
          completedAt: lifecycleRow.completedAt,
        })
        .where(eq(reportVersions.reportVersionId, reportVersionId))
        .run();

      if (updateResult.changes !== 1) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion lifecycle transition did not update exactly one row.",
        );
      }

      const updatedRow = this.connection.db
        .select()
        .from(reportVersions)
        .where(eq(reportVersions.reportVersionId, reportVersionId))
        .get();

      if (updatedRow === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion lifecycle transition completed without a readable row.",
        );
      }

      return reportVersionRowToDomain(updatedRow);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion lifecycle transition failed.",
      );
    }
  }

  private isAllowedLifecycleTransition(
    current: ReportVersion["status"],
    target: ReportVersion["status"],
  ): boolean {
    if (current === "DRAFT") {
      return target === "RUNNING" || target === "FAILED" || target === "CANCELLED";
    }

    if (current === "RUNNING") {
      return target === "COMPLETED" || target === "FAILED" || target === "CANCELLED";
    }

    return false;
  }

  private createValidatedReportVersion(value: ReportVersion): RepositoryWriteResult<ReportVersion> {
    if (!INITIAL_REPORT_STATUSES.has(value.status)) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion initial status must be DRAFT or RUNNING.",
      );
    }

    const existing = this.connection.db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportVersionId, value.report_version_id))
      .get();

    if (existing !== undefined) {
      const existingDomain = reportVersionRowToDomain(existing);
      if (!semanticEqual(existingDomain, value)) {
        throw new PersistenceError(
          "IMMUTABILITY_VIOLATION",
          "ReportVersion identity already exists with different immutable content.",
        );
      }

      return {
        outcome: "IDEMPOTENT_EXISTING",
        value: existingDomain,
      };
    }

    const privacyRevision = this.connection.db
      .select({ auditId: privacyRevisions.auditId })
      .from(privacyRevisions)
      .where(eq(privacyRevisions.privacyRevisionId, value.privacy_revision_id))
      .get();

    if (privacyRevision === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_NOT_FOUND",
        "ReportVersion requires an existing confirmed Privacy Revision.",
      );
    }

    if (privacyRevision.auditId !== value.audit_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion Audit identity does not match its confirmed Privacy Revision.",
      );
    }

    if (value.parent_report_version_id !== null) {
      if (value.parent_report_version_id === value.report_version_id) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion cannot reference itself as its parent.",
        );
      }

      const parent = this.connection.db
        .select({
          auditId: reportVersions.auditId,
          versionNumber: reportVersions.versionNumber,
        })
        .from(reportVersions)
        .where(eq(reportVersions.reportVersionId, value.parent_report_version_id))
        .get();

      if (parent === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_NOT_FOUND",
          "ReportVersion parent does not exist.",
        );
      }

      if (parent.auditId !== value.audit_id) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion parent belongs to a different Audit.",
        );
      }

      if (parent.versionNumber >= value.version_number) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion parent must have an earlier version number.",
        );
      }
    }

    const versionConflict = this.connection.db
      .select({ reportVersionId: reportVersions.reportVersionId })
      .from(reportVersions)
      .where(
        and(
          eq(reportVersions.auditId, value.audit_id),
          eq(reportVersions.versionNumber, value.version_number),
        ),
      )
      .get();

    if (
      versionConflict !== undefined &&
      versionConflict.reportVersionId !== value.report_version_id
    ) {
      throw new PersistenceError(
        "CONFLICTING_EXISTING_ROW",
        "Audit already contains a different ReportVersion with this version number.",
      );
    }

    this.connection.db.insert(reportVersions).values(reportVersionToRow(value)).run();

    const inserted = this.connection.db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportVersionId, value.report_version_id))
      .get();

    if (inserted === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion insert completed without a readable persisted row.",
      );
    }

    return {
      outcome: "INSERTED",
      value: reportVersionRowToDomain(inserted),
    };
  }
}
