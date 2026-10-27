import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import type { Commitment } from "../../domain/schemas/commitment.js";
import type { PotentialConflict } from "../../domain/schemas/conflict.js";
import type { Evidence } from "../../domain/schemas/evidence.js";
import type { RequirementDecisionChange } from "../../domain/schemas/change.js";
import type { ReportVersion } from "../../domain/schemas/report.js";
import { CommitmentRepository } from "./commitment-repository.js";
import { ConflictRepository } from "./conflict-repository.js";
import { EvidenceRepository } from "./evidence-repository.js";
import { ChangeRepository } from "./change-repository.js";
import { ReportVersionRepository } from "./report-version-repository.js";
import {
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

const WRITABLE_REPORT_STATUSES = new Set<ReportVersion["status"]>(["DRAFT", "RUNNING"]);

type ReportScopedInput = Readonly<Record<string, unknown>>;

export type ReportContentPersistenceInput = Readonly<{
  report_version_id: string;
  evidence: readonly unknown[];
  commitments: readonly unknown[];
  changes: readonly unknown[];
  conflicts: readonly unknown[];
  completeReport?: boolean;
  completionTimestamp?: string;
}>;

export type ReportContentPersistenceResult = Readonly<{
  report: ReportVersion;
  evidence: readonly RepositoryWriteResult<Evidence>[];
  commitments: readonly RepositoryWriteResult<Commitment>[];
  changes: readonly RepositoryWriteResult<RequirementDecisionChange>[];
  conflicts: readonly RepositoryWriteResult<PotentialConflict>[];
}>;

/**
 * Owns the single Report Content Persistence Transaction.
 *
 * Child repositories must remain transaction-bound helpers: Evidence first,
 * then Commitment, Change, and Conflict. Optional completion is the final
 * operation in the same transaction so a COMPLETED report can never expose a
 * partially persisted semantic snapshot.
 */
export class ReportContentRepository {
  private readonly reports: ReportVersionRepository;
  private readonly evidence: EvidenceRepository;
  private readonly commitments: CommitmentRepository;
  private readonly changes: ChangeRepository;
  private readonly conflicts: ConflictRepository;

  constructor(private readonly connection: PersistenceConnection) {
    this.reports = new ReportVersionRepository(connection);
    this.evidence = new EvidenceRepository(connection);
    this.commitments = new CommitmentRepository(connection);
    this.changes = new ChangeRepository(connection);
    this.conflicts = new ConflictRepository(connection);
  }

  persistReportContent(input: ReportContentPersistenceInput): ReportContentPersistenceResult {
    this.validateCommandShape(input);

    try {
      return this.connection.transaction(() => {
        const report = this.reports.getReportVersionById(input.report_version_id);
        if (!WRITABLE_REPORT_STATUSES.has(report.status)) {
          throw new PersistenceError(
            "PERSISTENCE_INTEGRITY_ERROR",
            "ReportVersion lifecycle does not permit semantic content persistence.",
          );
        }

        this.assertReportScope(input.evidence, input.report_version_id, "Evidence");
        this.assertReportScope(input.commitments, input.report_version_id, "Commitment");
        this.assertReportScope(input.changes, input.report_version_id, "Change");
        this.assertReportScope(input.conflicts, input.report_version_id, "Conflict");

        // Frozen order: Evidence -> Commitment -> Change -> Conflict.
        const evidence = this.evidence.insertEvidenceBatch(input.evidence);
        const commitments = this.commitments.insertCommitmentBatch(input.commitments);
        const changes = this.changes.insertChangeBatch(input.changes);
        const conflicts = this.conflicts.insertConflictBatch(input.conflicts);

        let finalReport = report;
        if (input.completeReport === true) {
          if (input.completionTimestamp === undefined) {
            throw new PersistenceError(
              "DOMAIN_VALIDATION_ERROR",
              "Completing a ReportVersion requires a completion timestamp.",
            );
          }
          finalReport = this.reports.transitionLifecycle(
            input.report_version_id,
            "COMPLETED",
            input.completionTimestamp,
          );
        }

        return {
          report: finalReport,
          evidence,
          commitments,
          changes,
          conflicts,
        };
      });
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "TRANSACTION_FAILED",
        "Report Content persistence transaction failed.",
      );
    }
  }

  private validateCommandShape(input: ReportContentPersistenceInput): void {
    if (
      typeof input !== "object" ||
      input === null ||
      typeof input.report_version_id !== "string" ||
      !Array.isArray(input.evidence) ||
      !Array.isArray(input.commitments) ||
      !Array.isArray(input.changes) ||
      !Array.isArray(input.conflicts) ||
      (input.completeReport !== undefined && typeof input.completeReport !== "boolean") ||
      (input.completionTimestamp !== undefined && typeof input.completionTimestamp !== "string")
    ) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "Report Content command shape is invalid.",
      );
    }
  }

  private assertReportScope(
    values: readonly unknown[],
    reportVersionId: string,
    objectName: string,
  ): void {
    for (const value of values) {
      if (typeof value !== "object" || value === null) {
        continue;
      }

      const reportScoped = value as ReportScopedInput;
      const candidateReportVersionId = reportScoped.report_version_id;
      if (
        typeof candidateReportVersionId === "string" &&
        candidateReportVersionId !== reportVersionId
      ) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          `${objectName} belongs to a different ReportVersion.`,
        );
      }
    }
  }
}
