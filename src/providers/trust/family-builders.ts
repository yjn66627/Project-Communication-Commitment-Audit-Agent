import { z } from "zod";

import { CandidateChangeSchema, type RequirementDecisionChange } from "../../domain/schemas/change.js";
import { CandidateCommitmentSchema, type Commitment } from "../../domain/schemas/commitment.js";
import { PotentialConflictSchema, type PotentialConflict } from "../../domain/schemas/conflict.js";
import {
  CommitmentChangeResponseSchema,
  ConflictReviewResponseSchema,
  ReportSummaryResponseSchema,
} from "../../domain/schemas/provider-responses.js";
import { AuditReportSchema, type AuditReport } from "../../domain/schemas/report.js";
import {
  createChangeId,
  createCommitmentId,
  createConflictId,
} from "../../shared/ids/index.js";
import type { FamilyEgressSafePayload } from "../../privacy/egress/contracts.js";
import type {
  ProviderReferenceAuthorityPort,
  ProviderTrustContext,
  ValidatedProviderAssertion,
} from "../contracts.js";
import { validateEvidenceReferences } from "./reference-validation.js";

type CommitmentChangeAssertion = z.infer<typeof CommitmentChangeResponseSchema>;
type ConflictReviewAssertion = z.infer<typeof ConflictReviewResponseSchema>;
type ReportSummaryAssertion = z.infer<typeof ReportSummaryResponseSchema>;
type CandidateCommitment = z.infer<typeof CandidateCommitmentSchema>;
type CandidateChange = z.infer<typeof CandidateChangeSchema>;

export type FamilyTrustErrorCode =
  | "AUTHORITY_UPGRADE_FORBIDDEN"
  | "RELATION_INVALID"
  | "REPORT_RECONCILIATION_INVALID"
  | "DOMAIN_CANDIDATE_INVALID";

export class FamilyTrustError extends Error {
  readonly code: FamilyTrustErrorCode;

  constructor(code: FamilyTrustErrorCode) {
    super("Provider family assertion failed local authority validation.");
    this.name = "FamilyTrustError";
    this.code = code;
  }
}

function assertAssertionOnly<T>(assertion: ValidatedProviderAssertion<T>): T {
  if (
    assertion.kind !== "VALIDATED_PROVIDER_ASSERTION" ||
    assertion.provider_assertion_only !== true ||
    assertion.final_authority !== false
  ) {
    throw new FamilyTrustError("DOMAIN_CANDIDATE_INVALID");
  }
  return assertion.value;
}

function freezeTree<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) freezeTree(item);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) freezeTree(item);
    }
    Object.freeze(value);
  }
  return value;
}

export type LocalCommitmentChangeCandidates = Readonly<{
  kind: "LOCAL_COMMITMENT_CHANGE_CANDIDATES";
  commitments: readonly CandidateCommitment[];
  changes: readonly CandidateChange[];
  provider_assertion_only: true;
  final_authority: false;
}>;

export async function buildLocalCommitmentChangeCandidates(input: Readonly<{
  assertion: ValidatedProviderAssertion<CommitmentChangeAssertion>;
  context: ProviderTrustContext;
  authority: ProviderReferenceAuthorityPort;
}>): Promise<LocalCommitmentChangeCandidates> {
  const value = assertAssertionOnly(input.assertion);
  const commitments: CandidateCommitment[] = [];
  const changes: CandidateChange[] = [];

  for (const proposal of value.commitments) {
    if (proposal.classification !== "CANDIDATE") {
      throw new FamilyTrustError("AUTHORITY_UPGRADE_FORBIDDEN");
    }
    await validateEvidenceReferences(proposal.evidence_ids, input.context, input.authority);
    const parsed = CandidateCommitmentSchema.safeParse({
      ...proposal,
      commitment_id: createCommitmentId(),
      report_version_id: input.context.report_version_id,
      actor: null,
      lifecycle_status: "UNKNOWN",
      supersedes_commitment_id: null,
      status_evidence_ids: [],
    });
    if (!parsed.success) throw new FamilyTrustError("DOMAIN_CANDIDATE_INVALID");
    commitments.push(freezeTree(parsed.data));
  }

  for (const proposal of value.changes) {
    if (proposal.classification !== "CANDIDATE") {
      throw new FamilyTrustError("AUTHORITY_UPGRADE_FORBIDDEN");
    }
    await validateEvidenceReferences(proposal.evidence_ids, input.context, input.authority);
    const parsed = CandidateChangeSchema.safeParse({
      ...proposal,
      change_id: createChangeId(),
      report_version_id: input.context.report_version_id,
      timestamp: null,
    });
    if (!parsed.success) throw new FamilyTrustError("DOMAIN_CANDIDATE_INVALID");
    changes.push(freezeTree(parsed.data));
  }

  return Object.freeze({
    kind: "LOCAL_COMMITMENT_CHANGE_CANDIDATES" as const,
    commitments: Object.freeze(commitments),
    changes: Object.freeze(changes),
    provider_assertion_only: true as const,
    final_authority: false as const,
  });
}

export type LocalConflictCandidates = Readonly<{
  kind: "LOCAL_CONFLICT_CANDIDATES";
  conflicts: readonly PotentialConflict[];
  provider_assertion_only: true;
  final_authority: false;
}>;

export async function buildLocalConflictCandidates(input: Readonly<{
  assertion: ValidatedProviderAssertion<ConflictReviewAssertion>;
  context: ProviderTrustContext;
  authority: ProviderReferenceAuthorityPort;
}>): Promise<LocalConflictCandidates> {
  const value = assertAssertionOnly(input.assertion);
  const conflicts: PotentialConflict[] = [];

  for (const proposal of value.potential_conflicts) {
    await validateEvidenceReferences(proposal.claim_a.evidence_ids, input.context, input.authority);
    await validateEvidenceReferences(proposal.claim_b.evidence_ids, input.context, input.authority);
    await validateEvidenceReferences(proposal.counter_evidence_ids, input.context, input.authority);
    if (
      proposal.claim_a.text.trim() === proposal.claim_b.text.trim() ||
      proposal.claim_a.evidence_ids.some((id) => proposal.claim_b.evidence_ids.includes(id))
    ) {
      throw new FamilyTrustError("RELATION_INVALID");
    }

    const parsed = PotentialConflictSchema.safeParse({
      ...proposal,
      conflict_id: createConflictId(),
      report_version_id: input.context.report_version_id,
      conflict_type: "POTENTIAL_CONFLICT",
      conflicted: true,
    });
    if (!parsed.success) throw new FamilyTrustError("DOMAIN_CANDIDATE_INVALID");
    conflicts.push(freezeTree(parsed.data));
  }

  return Object.freeze({
    kind: "LOCAL_CONFLICT_CANDIDATES" as const,
    conflicts: Object.freeze(conflicts),
    provider_assertion_only: true as const,
    final_authority: false as const,
  });
}

function multiset(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = multiset(left);
  for (const [key, count] of multiset(right)) {
    if (expected.get(key) !== count) return false;
  }
  return true;
}

function summaryItemBinding(item: AuditReport["audit_summary"]["items"][number]): string {
  return JSON.stringify({
    epistemic_status: item.epistemic_status,
    conflicted: item.conflicted,
    evidence_ids: [...item.evidence_ids].sort(),
    domain_ids: [...item.domain_ids].sort(),
  });
}

export type LocalReportPresentationProposal = Readonly<{
  kind: "LOCAL_REPORT_PRESENTATION_PROPOSAL";
  /** The existing, unmodified local report remains the canonical value. */
  local_report: AuditReport;
  /** Untrusted wording/ordering for a later local or human presentation decision. */
  summary_wording_proposal: ReportSummaryAssertion["summary"];
  changes_summary_wording_proposal: string | null;
  provider_assertion_only: true;
  final_authority: false;
}>;

export function buildLocalReportPresentationProposal(input: Readonly<{
  assertion: ValidatedProviderAssertion<ReportSummaryAssertion>;
  payload: Extract<FamilyEgressSafePayload, { operation: "REPORT_FINALIZE" }>;
  local_report: AuditReport;
}>): LocalReportPresentationProposal {
  const value = assertAssertionOnly(input.assertion);
  const parsed = AuditReportSchema.safeParse(input.local_report);
  if (!parsed.success) throw new FamilyTrustError("REPORT_RECONCILIATION_INVALID");
  const local = parsed.data;

  if (
    input.payload.operation !== "REPORT_FINALIZE" ||
    local.report_version.report_version_id !== input.payload.report_version_id ||
    local.report_version.audit_id !== input.payload.audit_id ||
    local.report_version.privacy_revision_id !== input.payload.privacy_revision_id ||
    local.report_version.status !== "RUNNING" ||
    JSON.stringify(local.audit_summary) !== JSON.stringify(input.payload.local_summary) ||
    JSON.stringify(local.timeline) !== JSON.stringify(input.payload.timeline) ||
    JSON.stringify(local.missing_evidence_and_uncertainty) !== JSON.stringify(input.payload.missing_evidence) ||
    !sameMultiset(local.evidence_ledger, input.payload.evidence.map((item) => item.evidence_id)) ||
    !sameMultiset(local.commitment_ledger, input.payload.commitments.map((item) => item.commitment_id)) ||
    !sameMultiset(local.requirement_decision_change_log, input.payload.changes.map((item) => item.change_id)) ||
    !sameMultiset(local.conflict_counter_evidence_review, input.payload.conflicts.map((item) => item.conflict_id))
  ) {
    throw new FamilyTrustError("REPORT_RECONCILIATION_INVALID");
  }

  const localBindings = local.audit_summary.items.map(summaryItemBinding);
  const proposalBindings = value.summary.items.map(summaryItemBinding);
  if (
    !sameMultiset(localBindings, proposalBindings) ||
    !sameMultiset(local.audit_summary.unresolved_items, value.summary.unresolved_items)
  ) {
    throw new FamilyTrustError("REPORT_RECONCILIATION_INVALID");
  }

  return Object.freeze({
    kind: "LOCAL_REPORT_PRESENTATION_PROPOSAL" as const,
    local_report: freezeTree(local),
    summary_wording_proposal: value.summary,
    changes_summary_wording_proposal: value.changes_summary,
    provider_assertion_only: true as const,
    final_authority: false as const,
  });
}

/** Useful for type-level callers: final Domain records remain separate from proposals. */
export type LocalCandidateDomainValue = Commitment | RequirementDecisionChange | PotentialConflict;
