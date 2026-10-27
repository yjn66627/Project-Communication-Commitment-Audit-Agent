import { z } from "zod";
import type { PersistenceConnection } from "../../db/connection.js";
import { normalizePersistenceError, PersistenceError } from "../../db/persistence-errors.js";
import { ChangeRepository } from "../../db/repositories/change-repository.js";
import { CommitmentRepository } from "../../db/repositories/commitment-repository.js";
import { ConflictRepository } from "../../db/repositories/conflict-repository.js";
import { EvidenceRepository } from "../../db/repositories/evidence-repository.js";
import { PrivacyRevisionReadAdapter } from "../../db/repositories/privacy-revision-read-adapter.js";
import { ReportAcceptanceRepository } from "../../db/repositories/report-acceptance-repository.js";
import { ReportVersionRepository } from "../../db/repositories/report-version-repository.js";
import { AuditIdSchema, ReportVersionIdSchema } from "../../domain/schemas/base.js";
import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";
import { buildCanonicalReport, CanonicalDigestSchema, deepFreeze } from "./canonical-report-builder.js";
import { CanonicalReportReadAdapter } from "./canonical-report-read-adapter.js";

const PreviewCommandSchema = z.object({ auditId: AuditIdSchema, reportVersionId: ReportVersionIdSchema }).strict();
const AcceptanceCommandSchema = PreviewCommandSchema.extend({ expectedCanonicalDigest: CanonicalDigestSchema }).strict();
export type ReportAcceptanceCommand = z.infer<typeof AcceptanceCommandSchema>;

export class ReportAcceptanceService {
  private readonly acceptances: ReportAcceptanceRepository;
  private readonly reads: CanonicalReportReadAdapter;
  constructor(private readonly connection: PersistenceConnection, private readonly now: () => string = () => new Date().toISOString(), private readonly ensureOpen: () => void = () => {}) {
    this.acceptances = new ReportAcceptanceRepository(connection);
    this.reads = new CanonicalReportReadAdapter(connection, ensureOpen);
  }

  private buildCurrent(auditId: string, reportVersionId: string) {
    if (!this.connection.sqlite.inTransaction) throw new PersistenceError("TRANSACTION_FAILED", "Canonical authority reads require the acceptance transaction.");
    const versions = new ReportVersionRepository(this.connection);
    const commitments = new CommitmentRepository(this.connection);
    const report = versions.getReportVersionById(reportVersionId);
    const history = versions.getReportVersionsByAudit(auditId);
    const latest = [...history].sort((a, b) => b.version_number - a.version_number || compareUnicodeCodePoints(a.report_version_id, b.report_version_id))[0];
    const privacy = new PrivacyRevisionReadAdapter(this.connection, this.ensureOpen).getLatestSafe(auditId);
    if (report.audit_id !== auditId || latest?.report_version_id !== reportVersionId || report.status !== "COMPLETED" || privacy === undefined || privacy.revision.audit_id !== auditId || privacy.revision.privacy_revision_id !== report.privacy_revision_id) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Report or confirmed privacy authority is stale or not eligible for first acceptance.");
    return buildCanonicalReport({
      reportVersion: report,
      records: [...privacy.records],
      evidence: [...new EvidenceRepository(this.connection).getEvidenceByReportVersion(reportVersionId)],
      commitments: [...commitments.getCommitmentsByReportVersion(reportVersionId)],
      changes: [...new ChangeRepository(this.connection).getChangesByReportVersion(reportVersionId)],
      conflicts: [...new ConflictRepository(this.connection).getConflictsByReportVersion(reportVersionId)],
      reportVersions: [...history],
      historicalCommitments: history.filter((r) => r.report_version_id !== reportVersionId).flatMap((r) => [...commitments.getCommitmentsByReportVersion(r.report_version_id)]),
    });
  }

  preview(input: unknown) {
    try {
      this.ensureOpen();
      const command = PreviewCommandSchema.safeParse(input);
      if (!command.success) throw new PersistenceError("DOMAIN_VALIDATION_ERROR", "Canonical preview command is invalid.");
      return this.connection.transaction(() => this.buildCurrent(command.data.auditId, command.data.reportVersionId));
    } catch (error) {
      throw normalizePersistenceError(error, "PERSISTENCE_INTEGRITY_ERROR", "Canonical preview validation failed.");
    }
  }

  accept(input: unknown) {
    try {
      this.ensureOpen();
      const command = AcceptanceCommandSchema.safeParse(input);
      if (!command.success) throw new PersistenceError("DOMAIN_VALIDATION_ERROR", "Explicit acceptance command is invalid.");
      if (this.connection.sqlite.inTransaction) throw new PersistenceError("TRANSACTION_FAILED", "Acceptance service must own its transaction boundary.");
      const c = command.data;
      // BEGIN IMMEDIATE serializes competing first accepts before READ -> VALIDATE -> BUILD -> INSERT.
      return this.connection.sqlite.transaction(() => {
        const existing = this.reads.getAcceptedSafe(c.auditId, c.reportVersionId);
        if (existing !== undefined) {
          if (existing.canonical_digest !== c.expectedCanonicalDigest) throw new PersistenceError("IMMUTABILITY_VIOLATION", "Accepted report digest differs from the explicit command.");
          // Historical same-digest retries intentionally do not check current latest report/privacy.
          return deepFreeze({ outcome: "IDEMPOTENT_EXISTING" as const, acceptance: existing });
        }
        const built = this.buildCurrent(c.auditId, c.reportVersionId);
        if (built.canonical_digest !== c.expectedCanonicalDigest) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Explicit acceptance refers to a stale or tampered canonical digest.");
        this.acceptances.insertImmutable({ reportVersionId: c.reportVersionId, auditId: c.auditId, privacyRevisionId: built.canonical_snapshot.binding.privacy_revision_id, canonicalFormatVersion: 1, canonicalDigest: built.canonical_digest, canonicalJson: built.canonical_json, acceptedAt: this.now() });
        const acceptance = this.reads.getAcceptedSafe(c.auditId, c.reportVersionId);
        if (acceptance === undefined) throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Inserted acceptance could not be read from persistence.");
        return deepFreeze({ outcome: "INSERTED" as const, acceptance });
      }).immediate();
    } catch (error) {
      throw normalizePersistenceError(error, "TRANSACTION_FAILED", "Explicit report acceptance transaction failed.");
    }
  }
}
