import { asc, eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import {
  canonicalRecords,
  evidence as evidenceTable,
  reportVersions,
} from "../schema.js";
import {
  canonicalRecordRowToDomain,
  evidenceRowToDomain,
  evidenceToRow,
  reportVersionRowToDomain,
} from "../persistence/row-mappers.js";
import { EvidenceSchema, type Evidence } from "../../domain/schemas/evidence.js";
import type { ReportVersion } from "../../domain/schemas/report.js";
import { validateEvidenceExcerpt } from "../../domain/validators/invariants.js";
import {
  semanticEqual,
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

const WRITABLE_REPORT_STATUSES = new Set<ReportVersion["status"]>(["DRAFT", "RUNNING"]);

export class EvidenceRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  insertEvidence(input: unknown): RepositoryWriteResult<Evidence> {
    try {
      this.requireOuterReportContentTransaction();
      const value = this.normalizeEvidenceInput(input);
      return this.insertValidatedEvidence(value);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence persistence operation failed.",
      );
    }
  }

  insertEvidenceBatch(inputs: readonly unknown[]): readonly RepositoryWriteResult<Evidence>[] {
    try {
      this.requireOuterReportContentTransaction();
      const values = inputs.map((input) => this.normalizeEvidenceInput(input));

      if (values.length === 0) {
        return [];
      }

      const reportVersionId = values[0]!.report_version_id;
      if (values.some((value) => value.report_version_id !== reportVersionId)) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Evidence batch must belong to exactly one ReportVersion.",
        );
      }

      const reportVersion = this.requireWritableReportVersion(reportVersionId);
      return values.map((value) => this.insertValidatedEvidence(value, reportVersion));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence batch persistence operation failed.",
      );
    }
  }

  getEvidenceById(evidenceId: string): Evidence {
    try {
      const row = this.connection.db
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.evidenceId, evidenceId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Evidence was not found.");
      }

      return evidenceRowToDomain(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence read operation failed.",
      );
    }
  }

  getEvidenceByReportVersion(reportVersionId: string): readonly Evidence[] {
    try {
      this.requireReportVersion(reportVersionId);
      return this.connection.db
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.reportVersionId, reportVersionId))
        .orderBy(
          asc(evidenceTable.sourceSequence),
          asc(evidenceTable.charStart),
          asc(evidenceTable.evidenceId),
        )
        .all()
        .map((row) => evidenceRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence-by-report read failed.",
      );
    }
  }

  getEvidenceByRecordRevision(recordRevisionId: string): readonly Evidence[] {
    try {
      const record = this.connection.db
        .select({ recordRevisionId: canonicalRecords.recordRevisionId })
        .from(canonicalRecords)
        .where(eq(canonicalRecords.recordRevisionId, recordRevisionId))
        .get();

      if (record === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_NOT_FOUND",
          "Canonical record revision was not found.",
        );
      }

      return this.connection.db
        .select()
        .from(evidenceTable)
        .where(eq(evidenceTable.recordRevisionId, recordRevisionId))
        .orderBy(asc(evidenceTable.charStart), asc(evidenceTable.evidenceId))
        .all()
        .map((row) => evidenceRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence-by-record read failed.",
      );
    }
  }

  private normalizeEvidenceInput(input: unknown): Evidence {
    const parsed = EvidenceSchema.safeParse(input);
    if (!parsed.success) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "Evidence input does not satisfy the frozen Domain contract.",
      );
    }
    return parsed.data;
  }

  private requireOuterReportContentTransaction(): void {
    if (this.connection.sqlite.inTransaction !== true) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence writes require an outer Report Content transaction.",
      );
    }
  }

  private insertValidatedEvidence(
    value: Evidence,
    knownReportVersion?: ReportVersion,
  ): RepositoryWriteResult<Evidence> {
    const reportVersion = knownReportVersion ?? this.requireWritableReportVersion(value.report_version_id);
    if (reportVersion.report_version_id !== value.report_version_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence ReportVersion identity does not match the validated batch context.",
      );
    }

    if (reportVersion.privacy_revision_id !== value.privacy_revision_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence Privacy Revision does not match its ReportVersion.",
      );
    }

    const recordRow = this.connection.db
      .select()
      .from(canonicalRecords)
      .where(eq(canonicalRecords.recordRevisionId, value.record_revision_id))
      .get();

    if (recordRow === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_NOT_FOUND",
        "Evidence requires an existing Canonical Record Revision.",
      );
    }

    const record = canonicalRecordRowToDomain(recordRow);
    if (record.privacy_revision_id !== reportVersion.privacy_revision_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence Canonical Record Revision is outside the ReportVersion Privacy Snapshot.",
      );
    }

    const excerptValidation = validateEvidenceExcerpt(record, value);
    if (!excerptValidation.ok) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence source binding, span, or excerpt violates the frozen integrity contract.",
      );
    }

    const existing = this.connection.db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.evidenceId, value.evidence_id))
      .get();

    if (existing !== undefined) {
      const existingDomain = evidenceRowToDomain(existing);
      if (!semanticEqual(existingDomain, value)) {
        throw new PersistenceError(
          "IMMUTABILITY_VIOLATION",
          "Evidence identity already exists with different immutable content.",
        );
      }

      return {
        outcome: "IDEMPOTENT_EXISTING",
        value: existingDomain,
      };
    }

    this.connection.db.insert(evidenceTable).values(evidenceToRow(value)).run();

    const inserted = this.connection.db
      .select()
      .from(evidenceTable)
      .where(eq(evidenceTable.evidenceId, value.evidence_id))
      .get();

    if (inserted === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Evidence insert completed without a readable persisted row.",
      );
    }

    return {
      outcome: "INSERTED",
      value: evidenceRowToDomain(inserted),
    };
  }

  private requireWritableReportVersion(reportVersionId: string): ReportVersion {
    const reportVersion = this.requireReportVersion(reportVersionId);
    if (!WRITABLE_REPORT_STATUSES.has(reportVersion.status)) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion lifecycle does not permit Evidence writes.",
      );
    }
    return reportVersion;
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
}
