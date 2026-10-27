import type { SanitizedCanonicalRecordRevision } from "../../domain/schemas/canonical.js";
import type { RequirementDecisionChange } from "../../domain/schemas/change.js";
import type { Commitment } from "../../domain/schemas/commitment.js";
import type { PotentialConflict } from "../../domain/schemas/conflict.js";
import type { Evidence } from "../../domain/schemas/evidence.js";
import type { AuditReport, AuditSummary, ReportVersion } from "../../domain/schemas/report.js";
import type { SafeConfirmedPrivacyAggregate } from "../../db/repositories/privacy-repository.js";

export const FOUR_FAMILY_RUN_STAGES = [
  "EVIDENCE_EXTRACTION",
  "COMMITMENT_CHANGE",
  "CONFLICT_REVIEW",
  "REPORT_FINALIZE",
] as const;

export type FourFamilyRunStage = (typeof FOUR_FAMILY_RUN_STAGES)[number];

export type SafeRunFailureCategory =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "EGRESS_DENIED"
  | "WIRE_SCHEMA_FAILURE"
  | "TRUST_FAILURE"
  | "REFERENCE_FAILURE"
  | "PROVIDER_TRANSPORT_FAILURE"
  | "PROVIDER_STAGE_FAILURE"
  | "STALE_PRIVACY"
  | "LIFECYCLE_DRIFT"
  | "LOCAL_AUTHORITY_FAILURE"
  | "PERSISTENCE_FAILURE"
  | "NO_VALID_EVIDENCE";

export class RunAuthorityError extends Error {
  constructor(readonly category: SafeRunFailureCategory) {
    super("Run authority validation failed.");
    this.name = "RunAuthorityError";
  }
}

export type RunContext = Readonly<{
  auditId: string;
  privacyRevisionId: string;
  reportVersionId: string;
}>;

export type ProviderCallMetadata = Readonly<{
  provider_call_id: string;
  stage: FourFamilyRunStage;
  provider_name: string;
  model_name: string;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  status: "SUCCEEDED" | "FAILED";
  input_record_count: number | null;
  input_size_chars: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  cost_amount_micros: null;
  cost_currency: null;
  retry_count: 0;
  schema_valid: boolean | null;
  error_category: SafeRunFailureCategory | null;
  output_counts: Readonly<{
    evidence?: number;
    commitments?: number;
    changes?: number;
    conflicts?: number;
    unknown?: number;
  }> | null;
}>;

export type ProviderStageOutcome<T> =
  | Readonly<{ ok: true; value: T; providerCall: ProviderCallMetadata }>
  | Readonly<{ ok: false; failureCategory: SafeRunFailureCategory; providerCall: ProviderCallMetadata }>;

export type CommitmentChangeRunCandidates = Readonly<{
  kind: "LOCAL_COMMITMENT_CHANGE_CANDIDATES";
  commitments: readonly Commitment[];
  changes: readonly RequirementDecisionChange[];
  provider_assertion_only: true;
  final_authority: false;
}>;

export type ConflictRunCandidates = Readonly<{
  kind: "LOCAL_CONFLICT_CANDIDATES";
  conflicts: readonly PotentialConflict[];
  provider_assertion_only: true;
  final_authority: false;
}>;

export type PresentationRunProposal = Readonly<{
  kind: "LOCAL_REPORT_PRESENTATION_PROPOSAL";
  local_report: AuditReport;
  summary_wording_proposal: AuditSummary;
  changes_summary_wording_proposal: string | null;
  provider_assertion_only: true;
  final_authority: false;
}>;

export type RunProviderAuthorityPort = Readonly<{
  assertProviderCallOutsideTransaction(): void;
  getConfirmedPrivacyAggregateSafe(privacyRevisionId: string): SafeConfirmedPrivacyAggregate;
  getReportVersionById(reportVersionId: string): ReportVersion;
  getEvidenceById(evidenceId: string): Evidence;
  getEvidenceByReportVersion(reportVersionId: string): readonly Evidence[];
  getCommitmentById(commitmentId: string): Commitment;
  getCommitmentsByReportVersion(reportVersionId: string): readonly Commitment[];
  getChangeById(changeId: string): RequirementDecisionChange;
  getChangesByReportVersion(reportVersionId: string): readonly RequirementDecisionChange[];
  getConflictById(conflictId: string): PotentialConflict;
  getConflictsByReportVersion(reportVersionId: string): readonly PotentialConflict[];
  getLocalReportByVersionId(reportVersionId: string): AuditReport;
  resolveRecordRevision(recordRevisionId: string, context: RunContext): SanitizedCanonicalRecordRevision | null;
  resolveEvidenceReference(evidenceId: string, context: RunContext): Readonly<{ audit_id: string; report_version_id: string }> | null;
  resolveDomainReference(domainId: string, context: RunContext): Readonly<{
    audit_id: string;
    report_version_id: string;
    kind: "COMMITMENT" | "CHANGE" | "CONFLICT";
  }> | null;
}>;

export interface FourFamilyProviderPort {
  extractEvidence(context: RunContext): Promise<ProviderStageOutcome<readonly Evidence[]>>;
  commitmentChange(context: RunContext): Promise<ProviderStageOutcome<CommitmentChangeRunCandidates>>;
  conflictCounterEvidence(context: RunContext): Promise<ProviderStageOutcome<ConflictRunCandidates>>;
  proposeReportPresentation(context: RunContext): Promise<ProviderStageOutcome<PresentationRunProposal>>;
}

export type FourFamilyProviderPortFactory = (authority: RunProviderAuthorityPort) => FourFamilyProviderPort;

export type ReportRunPersistencePort = RunProviderAuthorityPort & Readonly<{
  startRun(auditId: string): RunContext;
  assertRunAuthority(context: RunContext): ReportVersion;
  persistEvidenceStage(context: RunContext, evidence: readonly Evidence[], providerCall: ProviderCallMetadata): void;
  persistCommitmentChangeStage(
    context: RunContext,
    candidates: CommitmentChangeRunCandidates,
    providerCall: ProviderCallMetadata,
  ): void;
  persistConflictStage(context: RunContext, candidates: ConflictRunCandidates, providerCall: ProviderCallMetadata): void;
  completeRun(context: RunContext, providerCall: ProviderCallMetadata): void;
  failRun(context: RunContext, category: SafeRunFailureCategory, providerCall?: ProviderCallMetadata): void;
}>;

export type FourFamilyRunResult = Readonly<{
  context: RunContext;
  status: "COMPLETED" | "FAILED";
  failureCategory: SafeRunFailureCategory | null;
}>;
