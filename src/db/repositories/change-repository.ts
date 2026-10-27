import { asc, eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import { changes, evidence, reportVersions } from "../schema.js";
import {
  changeRowToDomain,
  changeToRow,
  reportVersionRowToDomain,
} from "../persistence/row-mappers.js";
import {
  ChangeSchema,
  type RequirementDecisionChange,
} from "../../domain/schemas/change.js";
import type { ReportVersion } from "../../domain/schemas/report.js";
import {
  semanticEqual,
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

const WRITABLE_REPORT_STATUSES = new Set<ReportVersion["status"]>(["DRAFT", "RUNNING"]);

export class ChangeRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  insertChange(input: unknown): RepositoryWriteResult<RequirementDecisionChange> {
    try {
      this.requireOuterReportContentTransaction();
      const value = this.normalizeInput(input);
      const report = this.requireWritableReportVersion(value.report_version_id);
      this.validateEvidenceReferences(value);
      return this.insertValidated(value, report);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Change persistence operation failed.",
      );
    }
  }

  insertChangeBatch(
    inputs: readonly unknown[],
  ): readonly RepositoryWriteResult<RequirementDecisionChange>[] {
    try {
      this.requireOuterReportContentTransaction();
      const values = inputs.map((input) => this.normalizeInput(input));
      if (values.length === 0) {
        return [];
      }

      const reportVersionId = values[0]!.report_version_id;
      if (values.some((value) => value.report_version_id !== reportVersionId)) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Change batch must belong to exactly one ReportVersion.",
        );
      }

      const report = this.requireWritableReportVersion(reportVersionId);
      for (const value of values) {
        this.validateEvidenceReferences(value);
      }
      return values.map((value) => this.insertValidated(value, report));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Change batch persistence operation failed.",
      );
    }
  }

  getChangeById(changeId: string): RequirementDecisionChange {
    try {
      const row = this.connection.db
        .select()
        .from(changes)
        .where(eq(changes.changeId, changeId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Change was not found.");
      }
      return changeRowToDomain(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Change read operation failed.",
      );
    }
  }

  getChangesByReportVersion(reportVersionId: string): readonly RequirementDecisionChange[] {
    try {
      this.requireReportVersion(reportVersionId);
      return this.connection.db
        .select()
        .from(changes)
        .where(eq(changes.reportVersionId, reportVersionId))
        .orderBy(asc(changes.timestamp), asc(changes.changeId))
        .all()
        .map((row) => changeRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Change-by-report read failed.",
      );
    }
  }

  private normalizeInput(input: unknown): RequirementDecisionChange {
    const parsed = ChangeSchema.safeParse(input);
    if (!parsed.success) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "Change input does not satisfy the frozen Domain contract.",
      );
    }
    return parsed.data;
  }

  private requireOuterReportContentTransaction(): void {
    if (this.connection.sqlite.inTransaction !== true) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Change writes require an outer Report Content transaction.",
      );
    }
  }

  private requireWritableReportVersion(reportVersionId: string): ReportVersion {
    const report = this.requireReportVersion(reportVersionId);
    if (!WRITABLE_REPORT_STATUSES.has(report.status)) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion lifecycle does not permit Change writes.",
      );
    }
    return report;
  }

  private requireReportVersion(reportVersionId: string): ReportVersion {
    const row = this.connection.db
      .select()
      .from(reportVersions)
      .where(eq(reportVersions.reportVersionId, reportVersionId))
      .get();

    if (row === undefined) {
      throw new PersistenceError("PERSISTENCE_NOT_FOUND", "ReportVersion was not found.");
    }
    return reportVersionRowToDomain(row);
  }

  private validateEvidenceReferences(value: RequirementDecisionChange): void {
    for (const evidenceId of value.evidence_ids) {
      const row = this.connection.db
        .select({ reportVersionId: evidence.reportVersionId })
        .from(evidence)
        .where(eq(evidence.evidenceId, evidenceId))
        .get();

      if (row === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_NOT_FOUND",
          "Change references Evidence that does not exist.",
        );
      }
      if (row.reportVersionId !== value.report_version_id) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Change Evidence reference belongs to a different ReportVersion.",
        );
      }
    }
  }

  private insertValidated(
    value: RequirementDecisionChange,
    knownReport: ReportVersion,
  ): RepositoryWriteResult<RequirementDecisionChange> {
    if (knownReport.report_version_id !== value.report_version_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Change ReportVersion does not match the validated batch context.",
      );
    }

    const existing = this.connection.db
      .select()
      .from(changes)
      .where(eq(changes.changeId, value.change_id))
      .get();

    if (existing !== undefined) {
      const existingDomain = changeRowToDomain(existing);
      if (!semanticEqual(existingDomain, value)) {
        throw new PersistenceError(
          "IMMUTABILITY_VIOLATION",
          "Change identity already exists with different immutable content.",
        );
      }
      return { outcome: "IDEMPOTENT_EXISTING", value: existingDomain };
    }

    this.connection.db.insert(changes).values(changeToRow(value)).run();

    const inserted = this.connection.db
      .select()
      .from(changes)
      .where(eq(changes.changeId, value.change_id))
      .get();

    if (inserted === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Change insert completed without a readable persisted row.",
      );
    }

    return { outcome: "INSERTED", value: changeRowToDomain(inserted) };
  }
}
