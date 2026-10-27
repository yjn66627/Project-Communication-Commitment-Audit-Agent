import { asc, eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import { conflicts, evidence, reportVersions } from "../schema.js";
import {
  conflictRowToDomain,
  conflictToRow,
  reportVersionRowToDomain,
} from "../persistence/row-mappers.js";
import {
  PotentialConflictSchema,
  type PotentialConflict,
} from "../../domain/schemas/conflict.js";
import type { ReportVersion } from "../../domain/schemas/report.js";
import {
  semanticEqual,
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

const WRITABLE_REPORT_STATUSES = new Set<ReportVersion["status"]>(["DRAFT", "RUNNING"]);

export class ConflictRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  insertConflict(input: unknown): RepositoryWriteResult<PotentialConflict> {
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
        "Conflict persistence operation failed.",
      );
    }
  }

  insertConflictBatch(inputs: readonly unknown[]): readonly RepositoryWriteResult<PotentialConflict>[] {
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
          "Conflict batch must belong to exactly one ReportVersion.",
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
        "Conflict batch persistence operation failed.",
      );
    }
  }

  getConflictById(conflictId: string): PotentialConflict {
    try {
      const row = this.connection.db
        .select()
        .from(conflicts)
        .where(eq(conflicts.conflictId, conflictId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Conflict was not found.");
      }
      return conflictRowToDomain(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Conflict read operation failed.",
      );
    }
  }

  getConflictsByReportVersion(reportVersionId: string): readonly PotentialConflict[] {
    try {
      this.requireReportVersion(reportVersionId);
      return this.connection.db
        .select()
        .from(conflicts)
        .where(eq(conflicts.reportVersionId, reportVersionId))
        .orderBy(asc(conflicts.conflictId))
        .all()
        .map((row) => conflictRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Conflict-by-report read failed.",
      );
    }
  }

  private normalizeInput(input: unknown): PotentialConflict {
    const parsed = PotentialConflictSchema.safeParse(input);
    if (!parsed.success) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "Conflict input does not satisfy the frozen Domain contract.",
      );
    }
    return parsed.data;
  }

  private requireOuterReportContentTransaction(): void {
    if (this.connection.sqlite.inTransaction !== true) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Conflict writes require an outer Report Content transaction.",
      );
    }
  }

  private requireWritableReportVersion(reportVersionId: string): ReportVersion {
    const report = this.requireReportVersion(reportVersionId);
    if (!WRITABLE_REPORT_STATUSES.has(report.status)) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion lifecycle does not permit Conflict writes.",
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

  private validateEvidenceReferences(value: PotentialConflict): void {
    const evidenceIds = [
      ...value.claim_a.evidence_ids,
      ...value.claim_b.evidence_ids,
      ...value.counter_evidence_ids,
    ];

    for (const evidenceId of evidenceIds) {
      const row = this.connection.db
        .select({ reportVersionId: evidence.reportVersionId })
        .from(evidence)
        .where(eq(evidence.evidenceId, evidenceId))
        .get();

      if (row === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_NOT_FOUND",
          "Conflict references Evidence that does not exist.",
        );
      }
      if (row.reportVersionId !== value.report_version_id) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Conflict Evidence reference belongs to a different ReportVersion.",
        );
      }
    }
  }

  private insertValidated(
    value: PotentialConflict,
    knownReport: ReportVersion,
  ): RepositoryWriteResult<PotentialConflict> {
    if (knownReport.report_version_id !== value.report_version_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Conflict ReportVersion does not match the validated batch context.",
      );
    }

    const existing = this.connection.db
      .select()
      .from(conflicts)
      .where(eq(conflicts.conflictId, value.conflict_id))
      .get();

    if (existing !== undefined) {
      const existingDomain = conflictRowToDomain(existing);
      if (!semanticEqual(existingDomain, value)) {
        throw new PersistenceError(
          "IMMUTABILITY_VIOLATION",
          "Conflict identity already exists with different immutable content.",
        );
      }
      return { outcome: "IDEMPOTENT_EXISTING", value: existingDomain };
    }

    this.connection.db.insert(conflicts).values(conflictToRow(value)).run();

    const inserted = this.connection.db
      .select()
      .from(conflicts)
      .where(eq(conflicts.conflictId, value.conflict_id))
      .get();

    if (inserted === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Conflict insert completed without a readable persisted row.",
      );
    }

    return { outcome: "INSERTED", value: conflictRowToDomain(inserted) };
  }
}
