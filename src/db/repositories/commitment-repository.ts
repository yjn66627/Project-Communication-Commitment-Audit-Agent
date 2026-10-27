import { asc, eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import { commitments, evidence, reportVersions } from "../schema.js";
import {
  commitmentRowToDomain,
  commitmentToRow,
  reportVersionRowToDomain,
} from "../persistence/row-mappers.js";
import { CommitmentSchema, type Commitment } from "../../domain/schemas/commitment.js";
import type { ReportVersion } from "../../domain/schemas/report.js";
import {
  semanticEqual,
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

const WRITABLE_REPORT_STATUSES = new Set<ReportVersion["status"]>(["DRAFT", "RUNNING"]);

type PendingCommitmentMap = ReadonlyMap<string, Commitment>;

export class CommitmentRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  insertCommitment(input: unknown): RepositoryWriteResult<Commitment> {
    try {
      this.requireOuterReportContentTransaction();
      const value = this.normalizeInput(input);
      const report = this.requireWritableReportVersion(value.report_version_id);
      this.validateEvidenceReferences(value);
      this.validateSupersession(value, new Map());
      return this.insertValidated(value, report);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment persistence operation failed.",
      );
    }
  }

  insertCommitmentBatch(inputs: readonly unknown[]): readonly RepositoryWriteResult<Commitment>[] {
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
          "Commitment batch must belong to exactly one ReportVersion.",
        );
      }

      const report = this.requireWritableReportVersion(reportVersionId);
      for (const value of values) {
        this.validateEvidenceReferences(value);
      }

      const ordered = this.orderAndValidateSupersession(values);
      const resultsById = new Map<string, RepositoryWriteResult<Commitment>>();
      for (const value of ordered) {
        resultsById.set(value.commitment_id, this.insertValidated(value, report));
      }

      return values.map((value) => {
        const result = resultsById.get(value.commitment_id);
        if (result === undefined) {
          throw new PersistenceError(
            "PERSISTENCE_INTEGRITY_ERROR",
            "Commitment batch result reconstruction failed.",
          );
        }
        return result;
      });
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment batch persistence operation failed.",
      );
    }
  }

  getCommitmentById(commitmentId: string): Commitment {
    try {
      const row = this.connection.db
        .select()
        .from(commitments)
        .where(eq(commitments.commitmentId, commitmentId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Commitment was not found.");
      }

      return commitmentRowToDomain(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment read operation failed.",
      );
    }
  }

  getCommitmentsByReportVersion(reportVersionId: string): readonly Commitment[] {
    try {
      this.requireReportVersion(reportVersionId);
      return this.connection.db
        .select()
        .from(commitments)
        .where(eq(commitments.reportVersionId, reportVersionId))
        .orderBy(asc(commitments.commitmentId))
        .all()
        .map((row) => commitmentRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment-by-report read failed.",
      );
    }
  }

  private normalizeInput(input: unknown): Commitment {
    const parsed = CommitmentSchema.safeParse(input);
    if (!parsed.success) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "Commitment input does not satisfy the frozen Domain contract.",
      );
    }
    return parsed.data;
  }

  private requireOuterReportContentTransaction(): void {
    if (this.connection.sqlite.inTransaction !== true) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment writes require an outer Report Content transaction.",
      );
    }
  }

  private requireWritableReportVersion(reportVersionId: string): ReportVersion {
    const report = this.requireReportVersion(reportVersionId);
    if (!WRITABLE_REPORT_STATUSES.has(report.status)) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ReportVersion lifecycle does not permit Commitment writes.",
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

  private validateEvidenceReferences(value: Commitment): void {
    this.requireSameReportEvidence(value.evidence_ids, value.report_version_id);
    this.requireSameReportEvidence(value.status_evidence_ids, value.report_version_id);
  }

  private requireSameReportEvidence(evidenceIds: readonly string[], reportVersionId: string): void {
    for (const evidenceId of evidenceIds) {
      const row = this.connection.db
        .select({ reportVersionId: evidence.reportVersionId })
        .from(evidence)
        .where(eq(evidence.evidenceId, evidenceId))
        .get();

      if (row === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_NOT_FOUND",
          "Commitment references Evidence that does not exist.",
        );
      }

      if (row.reportVersionId !== reportVersionId) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Commitment Evidence reference belongs to a different ReportVersion.",
        );
      }
    }
  }

  private orderAndValidateSupersession(values: readonly Commitment[]): Commitment[] {
    const pending = new Map<string, Commitment>();
    for (const value of values) {
      const prior = pending.get(value.commitment_id);
      if (prior !== undefined && !semanticEqual(prior, value)) {
        throw new PersistenceError(
          "IMMUTABILITY_VIOLATION",
          "Commitment batch repeats an identity with different immutable content.",
        );
      }
      pending.set(value.commitment_id, value);
    }

    const visitState = new Map<string, "VISITING" | "DONE">();
    const ordered: Commitment[] = [];

    const visit = (value: Commitment): void => {
      const state = visitState.get(value.commitment_id);
      if (state === "DONE") {
        return;
      }
      if (state === "VISITING") {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Commitment supersession chain contains a cycle.",
        );
      }

      visitState.set(value.commitment_id, "VISITING");
      const targetId = value.supersedes_commitment_id;
      if (targetId !== null) {
        if (targetId === value.commitment_id) {
          throw new PersistenceError(
            "PERSISTENCE_INTEGRITY_ERROR",
            "Commitment cannot supersede itself.",
          );
        }

        const pendingTarget = pending.get(targetId);
        if (pendingTarget !== undefined) {
          visit(pendingTarget);
        } else {
          this.validateSupersession(value, pending);
        }
      }

      visitState.set(value.commitment_id, "DONE");
      ordered.push(value);
    };

    for (const value of values) {
      visit(value);
    }

    return ordered;
  }

  private validateSupersession(value: Commitment, pending: PendingCommitmentMap): void {
    const targetId = value.supersedes_commitment_id;
    if (targetId === null) {
      return;
    }
    if (targetId === value.commitment_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment cannot supersede itself.",
      );
    }

    const pendingTarget = pending.get(targetId);
    if (pendingTarget !== undefined) {
      this.requireSameOrAncestorReport(value.report_version_id, pendingTarget.report_version_id);
      return;
    }

    let currentId: string | null = targetId;
    let currentSourceReportVersionId = value.report_version_id;
    const visited = new Set<string>();
    while (currentId !== null) {
      if (currentId === value.commitment_id || visited.has(currentId)) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Commitment supersession chain contains a cycle.",
        );
      }
      visited.add(currentId);

      const row = this.connection.db
        .select()
        .from(commitments)
        .where(eq(commitments.commitmentId, currentId))
        .get();

      if (row === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_NOT_FOUND",
          "Superseded Commitment was not found.",
        );
      }

      const target = commitmentRowToDomain(row);
      this.requireSameOrAncestorReport(currentSourceReportVersionId, target.report_version_id);
      currentSourceReportVersionId = target.report_version_id;
      currentId = target.supersedes_commitment_id;
    }
  }

  private requireSameOrAncestorReport(
    sourceReportVersionId: string,
    targetReportVersionId: string,
  ): void {
    const sourceReport = this.requireReportVersion(sourceReportVersionId);
    const targetReport = this.requireReportVersion(targetReportVersionId);

    if (targetReport.audit_id !== sourceReport.audit_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment supersession cannot cross Audit boundaries.",
      );
    }

    if (targetReport.report_version_id === sourceReport.report_version_id) {
      return;
    }

    const visitedReportVersionIds = new Set<string>([sourceReport.report_version_id]);
    let currentId = sourceReport.parent_report_version_id;

    while (currentId !== null) {
      if (visitedReportVersionIds.has(currentId)) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion lineage contains a cycle.",
        );
      }
      visitedReportVersionIds.add(currentId);

      const currentReport = this.requireReportVersion(currentId);
      if (currentReport.audit_id !== sourceReport.audit_id) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ReportVersion lineage crosses Audit boundaries.",
        );
      }

      if (currentReport.report_version_id === targetReport.report_version_id) {
        return;
      }

      currentId = currentReport.parent_report_version_id;
    }

    throw new PersistenceError(
      "PERSISTENCE_INTEGRITY_ERROR",
      "Superseded Commitment belongs to an incompatible ReportVersion lineage.",
    );
  }

  private insertValidated(
    value: Commitment,
    knownReport: ReportVersion,
  ): RepositoryWriteResult<Commitment> {
    if (knownReport.report_version_id !== value.report_version_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment ReportVersion does not match the validated batch context.",
      );
    }

    const existing = this.connection.db
      .select()
      .from(commitments)
      .where(eq(commitments.commitmentId, value.commitment_id))
      .get();

    if (existing !== undefined) {
      const existingDomain = commitmentRowToDomain(existing);
      if (!semanticEqual(existingDomain, value)) {
        throw new PersistenceError(
          "IMMUTABILITY_VIOLATION",
          "Commitment identity already exists with different immutable content.",
        );
      }
      return { outcome: "IDEMPOTENT_EXISTING", value: existingDomain };
    }

    this.connection.db.insert(commitments).values(commitmentToRow(value)).run();

    const inserted = this.connection.db
      .select()
      .from(commitments)
      .where(eq(commitments.commitmentId, value.commitment_id))
      .get();

    if (inserted === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Commitment insert completed without a readable persisted row.",
      );
    }

    return { outcome: "INSERTED", value: commitmentRowToDomain(inserted) };
  }
}
