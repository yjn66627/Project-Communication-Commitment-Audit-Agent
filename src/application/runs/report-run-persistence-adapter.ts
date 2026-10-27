import { randomUUID } from "node:crypto";
import type { PersistenceConnection } from "../../db/connection.js";
import { PersistenceError } from "../../db/persistence-errors.js";
import { AuditRepository } from "../../db/repositories/audit-repository.js";
import { ChangeRepository } from "../../db/repositories/change-repository.js";
import { CommitmentRepository } from "../../db/repositories/commitment-repository.js";
import { ConflictRepository } from "../../db/repositories/conflict-repository.js";
import { EvidenceRepository } from "../../db/repositories/evidence-repository.js";
import { PrivacyRepository } from "../../db/repositories/privacy-repository.js";
import { PrivacyRevisionReadAdapter } from "../../db/repositories/privacy-revision-read-adapter.js";
import { ProviderCallRepository } from "../../db/repositories/provider-call-repository.js";
import { ReportVersionRepository } from "../../db/repositories/report-version-repository.js";
import type { Evidence } from "../../domain/schemas/evidence.js";
import type { ReportVersion } from "../../domain/schemas/report.js";
import { ApplicationError } from "../errors.js";
import { projectLocalRunningReport } from "./local-running-report-projector.js";
import {
  FOUR_FAMILY_RUN_STAGES,
  RunAuthorityError,
  type CommitmentChangeRunCandidates,
  type ConflictRunCandidates,
  type FourFamilyRunStage,
  type PresentationRunProposal,
  type ProviderCallMetadata,
  type ReportRunPersistencePort,
  type RunContext,
  type SafeRunFailureCategory,
} from "./four-family-run-ports.js";

export class ReportRunPersistenceAdapter implements ReportRunPersistencePort {
  #connection: PersistenceConnection;
  #ensureAccess: () => void;
  #audits: AuditRepository;
  #privacy: PrivacyRepository;
  #privacyReads: PrivacyRevisionReadAdapter;
  #versions: ReportVersionRepository;
  #evidence: EvidenceRepository;
  #commitments: CommitmentRepository;
  #changes: ChangeRepository;
  #conflicts: ConflictRepository;
  #providerCalls: ProviderCallRepository;

  constructor(connection: PersistenceConnection, ensureAccess: () => void) {
    this.#connection = connection;
    this.#ensureAccess = ensureAccess;
    this.#audits = new AuditRepository(connection);
    this.#privacy = new PrivacyRepository(connection);
    this.#privacyReads = new PrivacyRevisionReadAdapter(connection, ensureAccess);
    this.#versions = new ReportVersionRepository(connection);
    this.#evidence = new EvidenceRepository(connection);
    this.#commitments = new CommitmentRepository(connection);
    this.#changes = new ChangeRepository(connection);
    this.#conflicts = new ConflictRepository(connection);
    this.#providerCalls = new ProviderCallRepository(connection);
  }

  startRun(auditId: string): RunContext {
    this.#ensureAccess();
    try { this.#audits.getAuditLocalIdentity(auditId); }
    catch { throw new ApplicationError("AUDIT_NOT_FOUND", "The local Audit is unavailable."); }
    const before = this.#privacyReads.getLatestSafe(auditId);
    if (!before) throw new ApplicationError("NO_CONFIRMED_PRIVACY", "A confirmed Privacy Revision is required.");

    try {
      const start = this.#connection.transaction(() => {
        this.#ensureAccess();
        this.#audits.getAuditLocalIdentity(auditId);
        const latest = this.#privacyReads.getLatestSafe(auditId);
        if (!latest || latest.revision.privacy_revision_id !== before.revision.privacy_revision_id) {
          throw new RunAuthorityError("STALE_PRIVACY");
        }

        const history = this.#versions.getReportVersionsByAudit(auditId);
        for (const prior of history) {
          if (prior.status === "RUNNING") {
            this.#versions.transitionLifecycle(prior.report_version_id, "FAILED", new Date().toISOString());
          }
        }

        return Object.freeze({
          latestPrivacyRevisionId: latest.revision.privacy_revision_id,
          latestReportVersion: history.at(-1) ?? null,
          versionNumber: (history.at(-1)?.version_number ?? 0) + 1,
        });
      });
      this.#ensureAccess();
      const latestNow = this.#privacyReads.getLatestSafe(auditId);
      if (!latestNow || latestNow.revision.privacy_revision_id !== start.latestPrivacyRevisionId) throw new RunAuthorityError("STALE_PRIVACY");
      const reportVersionId = `rpt_${randomUUID()}`;
      const now = new Date().toISOString();
      this.#versions.createReportVersion({
        report_version_id: reportVersionId,
        audit_id: auditId,
        privacy_revision_id: start.latestPrivacyRevisionId,
        parent_report_version_id: start.latestReportVersion?.report_version_id ?? null,
        version_number: start.versionNumber,
        status: "RUNNING",
        changes_summary: null,
        created_at: now,
        started_at: now,
        completed_at: null,
      });
      return Object.freeze({ auditId, privacyRevisionId: start.latestPrivacyRevisionId, reportVersionId });
    } catch (error) {
      if (error instanceof RunAuthorityError) throw new ApplicationError("STALE_PRIVACY", "Confirmed Privacy changed during Run startup.");
      throw new ApplicationError("RUN_START_FAILED", "A new local ReportVersion could not be started.");
    }
  }

  assertRunAuthority(context: RunContext): ReportVersion {
    this.#ensureAccess();
    return this.#assertAuthority(context, "RUNNING");
  }

  persistEvidenceStage(context: RunContext, evidence: readonly Evidence[], providerCall: ProviderCallMetadata): void {
    this.#writeStage(context, FOUR_FAMILY_RUN_STAGES[0], providerCall, () => {
      const aggregate = this.#assertAuthority(context, "RUNNING");
      const allowedRecords = new Set(this.#privacy.getCanonicalRecordsByPrivacyRevision(context.privacyRevisionId).map((item) => item.record_revision_id));
      for (const item of evidence) {
        if (item.report_version_id !== aggregate.report_version_id || item.privacy_revision_id !== context.privacyRevisionId || !allowedRecords.has(item.record_revision_id)) {
          throw new RunAuthorityError("REFERENCE_FAILURE");
        }
      }
      this.#evidence.insertEvidenceBatch(evidence);
    });
  }

  persistCommitmentChangeStage(context: RunContext, candidates: CommitmentChangeRunCandidates, providerCall: ProviderCallMetadata): void {
    this.#writeStage(context, FOUR_FAMILY_RUN_STAGES[1], providerCall, () => {
      this.#assertAuthority(context, "RUNNING");
      const evidence = this.#requiredLocalEvidence(context);
      const allowed = new Set(evidence.map((item) => item.evidence_id));
      const references = [...candidates.commitments.flatMap((item) => [...item.evidence_ids, ...item.status_evidence_ids]), ...candidates.changes.flatMap((item) => item.evidence_ids)];
      if (references.some((id) => !allowed.has(id))) throw new RunAuthorityError("REFERENCE_FAILURE");
      this.#commitments.insertCommitmentBatch(candidates.commitments);
      this.#changes.insertChangeBatch(candidates.changes);
    });
  }

  persistConflictStage(context: RunContext, candidates: ConflictRunCandidates, providerCall: ProviderCallMetadata): void {
    this.#writeStage(context, FOUR_FAMILY_RUN_STAGES[2], providerCall, () => {
      this.#assertAuthority(context, "RUNNING");
      const evidence = this.#requiredLocalEvidence(context);
      const allowed = new Set(evidence.map((item) => item.evidence_id));
      const references = candidates.conflicts.flatMap((item) => [...item.claim_a.evidence_ids, ...item.claim_b.evidence_ids, ...item.counter_evidence_ids]);
      if (references.some((id) => !allowed.has(id))) throw new RunAuthorityError("REFERENCE_FAILURE");
      this.#conflicts.insertConflictBatch(candidates.conflicts);
    });
  }

  completeRun(context: RunContext, providerCall: ProviderCallMetadata): void {
    this.#writeStage(context, FOUR_FAMILY_RUN_STAGES[3], providerCall, () => {
      this.#assertAuthority(context, "RUNNING");
      this.#requiredLocalEvidence(context);
      const local = this.getLocalReportByVersionId(context.reportVersionId);
      if (local.report_version.audit_id !== context.auditId || local.report_version.privacy_revision_id !== context.privacyRevisionId) {
        throw new RunAuthorityError("REFERENCE_FAILURE");
      }
      this.#versions.transitionLifecycle(context.reportVersionId, "COMPLETED", new Date().toISOString());
    });
  }

  failRun(context: RunContext, category: SafeRunFailureCategory, providerCall?: ProviderCallMetadata): void {
    this.#ensureAccess();
    this.#connection.transaction(() => {
      this.#ensureAccess();
      let report: ReportVersion;
      try { report = this.#versions.getReportVersionById(context.reportVersionId); }
      catch { throw new RunAuthorityError("PERSISTENCE_FAILURE"); }
      if (report.audit_id !== context.auditId || report.privacy_revision_id !== context.privacyRevisionId) {
        throw new RunAuthorityError("LIFECYCLE_DRIFT");
      }
      if (report.status === "RUNNING") this.#versions.transitionLifecycle(context.reportVersionId, "FAILED", new Date().toISOString());
      else if (report.status !== "FAILED") throw new RunAuthorityError("LIFECYCLE_DRIFT");
      if (providerCall) {
        this.#providerCalls.insertProviderCall(this.#providerCallInput(context, providerCall, "FAILED", category));
      }
    });
  }

  assertProviderCallOutsideTransaction(): void {
    this.#ensureAccess();
    if (this.#connection.sqlite.inTransaction) throw new RunAuthorityError("LOCAL_AUTHORITY_FAILURE");
  }

  getConfirmedPrivacyAggregateSafe(privacyRevisionId: string) {
    this.#ensureAccess();
    return this.#privacy.getConfirmedPrivacyAggregateSafe(privacyRevisionId);
  }

  getReportVersionById(reportVersionId: string): ReportVersion {
    this.#ensureAccess();
    return this.#versions.getReportVersionById(reportVersionId);
  }

  getEvidenceById(evidenceId: string): Evidence {
    this.#ensureAccess();
    return this.#evidence.getEvidenceById(evidenceId);
  }

  getEvidenceByReportVersion(reportVersionId: string): readonly Evidence[] {
    this.#ensureAccess();
    return this.#evidence.getEvidenceByReportVersion(reportVersionId);
  }

  getCommitmentById(commitmentId: string) {
    this.#ensureAccess();
    return this.#commitments.getCommitmentById(commitmentId);
  }

  getCommitmentsByReportVersion(reportVersionId: string) {
    this.#ensureAccess();
    return this.#commitments.getCommitmentsByReportVersion(reportVersionId);
  }

  getChangeById(changeId: string) {
    this.#ensureAccess();
    return this.#changes.getChangeById(changeId);
  }

  getChangesByReportVersion(reportVersionId: string) {
    this.#ensureAccess();
    return this.#changes.getChangesByReportVersion(reportVersionId);
  }

  getConflictById(conflictId: string) {
    this.#ensureAccess();
    return this.#conflicts.getConflictById(conflictId);
  }

  getConflictsByReportVersion(reportVersionId: string) {
    this.#ensureAccess();
    return this.#conflicts.getConflictsByReportVersion(reportVersionId);
  }

  getLocalReportByVersionId(reportVersionId: string) {
    this.#ensureAccess();
    const reportVersion = this.#versions.getReportVersionById(reportVersionId);
    if (reportVersion.status !== "RUNNING") throw new RunAuthorityError("LIFECYCLE_DRIFT");
    const aggregate = this.#privacy.getConfirmedPrivacyAggregateSafe(reportVersion.privacy_revision_id);
    if (aggregate.revision.audit_id !== reportVersion.audit_id) throw new RunAuthorityError("REFERENCE_FAILURE");
    return projectLocalRunningReport({
      reportVersion,
      evidence: this.#evidence.getEvidenceByReportVersion(reportVersionId),
      commitments: this.#commitments.getCommitmentsByReportVersion(reportVersionId),
      changes: this.#changes.getChangesByReportVersion(reportVersionId),
      conflicts: this.#conflicts.getConflictsByReportVersion(reportVersionId),
    });
  }

  resolveRecordRevision(recordRevisionId: string, context: RunContext) {
    try {
      this.#ensureAccess();
      const report = this.#assertAuthority(context, "RUNNING");
      const aggregate = this.#privacy.getConfirmedPrivacyAggregateSafe(context.privacyRevisionId);
      if (aggregate.revision.audit_id !== report.audit_id || aggregate.revision.privacy_revision_id !== report.privacy_revision_id) return null;
      return aggregate.records.find((record) => record.record_revision_id === recordRevisionId) ?? null;
    } catch { return null; }
  }

  resolveEvidenceReference(evidenceId: string, context: RunContext) {
    try {
      this.#ensureAccess();
      const report = this.#assertAuthority(context, "RUNNING");
      const value = this.#evidence.getEvidenceById(evidenceId);
      if (value.report_version_id !== report.report_version_id || value.privacy_revision_id !== report.privacy_revision_id) return null;
      return Object.freeze({ audit_id: report.audit_id, report_version_id: report.report_version_id });
    } catch { return null; }
  }

  resolveDomainReference(domainId: string, context: RunContext) {
    try {
      this.#ensureAccess();
      const report = this.#assertAuthority(context, "RUNNING");
      for (const [kind, read] of [
        ["COMMITMENT", () => this.#commitments.getCommitmentById(domainId)],
        ["CHANGE", () => this.#changes.getChangeById(domainId)],
        ["CONFLICT", () => this.#conflicts.getConflictById(domainId)],
      ] as const) {
        try {
          const value = read();
          if (value.report_version_id === report.report_version_id) return Object.freeze({ audit_id: report.audit_id, report_version_id: report.report_version_id, kind });
        } catch { /* Try the next frozen repository family. */ }
      }
      return null;
    } catch { return null; }
  }

  #writeStage(context: RunContext, stage: FourFamilyRunStage, providerCall: ProviderCallMetadata, write: () => void): void {
    this.#ensureAccess();
    this.#connection.transaction(() => {
      this.#ensureAccess();
      this.#assertAuthority(context, "RUNNING");
      if (providerCall.stage !== stage) throw new RunAuthorityError("LOCAL_AUTHORITY_FAILURE");
      write();
      this.#providerCalls.insertProviderCall(this.#providerCallInput(context, providerCall, "SUCCEEDED", null));
    });
  }

  #assertAuthority(context: RunContext, expectedStatus: "RUNNING"): ReportVersion {
    let report: ReportVersion;
    try { report = this.#versions.getReportVersionById(context.reportVersionId); }
    catch { throw new RunAuthorityError("LIFECYCLE_DRIFT"); }
    if (report.audit_id !== context.auditId || report.privacy_revision_id !== context.privacyRevisionId || report.status !== expectedStatus) {
      throw new RunAuthorityError("LIFECYCLE_DRIFT");
    }
    try { this.#audits.getAuditLocalIdentity(context.auditId); }
    catch { throw new RunAuthorityError("LOCAL_AUTHORITY_FAILURE"); }
    const latest = this.#privacyReads.getLatestSafe(context.auditId);
    if (!latest || latest.revision.privacy_revision_id !== context.privacyRevisionId) throw new RunAuthorityError("STALE_PRIVACY");
    const exact = this.#privacy.getConfirmedPrivacyAggregateSafe(context.privacyRevisionId);
    if (exact.revision.audit_id !== context.auditId || exact.records.some((record) => record.audit_id !== context.auditId || record.privacy_revision_id !== context.privacyRevisionId)) {
      throw new RunAuthorityError("REFERENCE_FAILURE");
    }
    const evidence = this.#evidence.getEvidenceByReportVersion(context.reportVersionId);
    if (evidence.some((item) => item.privacy_revision_id !== context.privacyRevisionId || !exact.records.some((record) => record.record_revision_id === item.record_revision_id))) {
      throw new RunAuthorityError("REFERENCE_FAILURE");
    }
    const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
    const validEvidenceReferences = (ids: readonly string[]): boolean => ids.every((id) => evidenceIds.has(id));
    const commitments = this.#commitments.getCommitmentsByReportVersion(context.reportVersionId);
    if (commitments.some((item) => item.report_version_id !== context.reportVersionId || !validEvidenceReferences([...item.evidence_ids, ...item.status_evidence_ids]))) {
      throw new RunAuthorityError("REFERENCE_FAILURE");
    }
    const changes = this.#changes.getChangesByReportVersion(context.reportVersionId);
    if (changes.some((item) => item.report_version_id !== context.reportVersionId || !validEvidenceReferences(item.evidence_ids))) {
      throw new RunAuthorityError("REFERENCE_FAILURE");
    }
    const conflicts = this.#conflicts.getConflictsByReportVersion(context.reportVersionId);
    if (conflicts.some((item) => item.report_version_id !== context.reportVersionId || !validEvidenceReferences([
      ...item.claim_a.evidence_ids, ...item.claim_b.evidence_ids, ...item.counter_evidence_ids,
    ]))) {
      throw new RunAuthorityError("REFERENCE_FAILURE");
    }
    return report;
  }

  #requiredLocalEvidence(context: RunContext): readonly Evidence[] {
    const rows = this.#evidence.getEvidenceByReportVersion(context.reportVersionId);
    if (rows.length === 0) throw new RunAuthorityError("NO_VALID_EVIDENCE");
    if (rows.some((item) => item.privacy_revision_id !== context.privacyRevisionId)) throw new RunAuthorityError("REFERENCE_FAILURE");
    return rows;
  }

  #providerCallInput(
    context: RunContext,
    call: ProviderCallMetadata,
    status: "SUCCEEDED" | "FAILED",
    category: SafeRunFailureCategory | null,
  ) {
    if (!(FOUR_FAMILY_RUN_STAGES as readonly string[]).includes(call.stage)) throw new RunAuthorityError("LOCAL_AUTHORITY_FAILURE");
    return {
      provider_call_id: call.provider_call_id,
      audit_id: context.auditId,
      report_version_id: context.reportVersionId,
      stage: call.stage,
      provider_name: call.provider_name,
      model_name: call.model_name,
      started_at: call.started_at,
      completed_at: call.completed_at,
      latency_ms: call.latency_ms,
      status,
      input_record_count: call.input_record_count,
      input_size_chars: call.input_size_chars,
      input_tokens: call.input_tokens,
      output_tokens: call.output_tokens,
      total_tokens: call.total_tokens,
      cost_amount_micros: null,
      cost_currency: null,
      retry_count: 0,
      schema_valid: call.schema_valid,
      error_category: category,
      output_counts: call.output_counts,
    };
  }
}
