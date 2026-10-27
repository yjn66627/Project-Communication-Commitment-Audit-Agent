import { z } from "zod";
import { AuditIdSchema, ReportVersionIdSchema } from "../../domain/schemas/base.js";
import type { ApplicationAuditDTO } from "../../db/repositories/audit-list-read-adapter.js";
import type { SafeAcceptedReport } from "../../application/reports/canonical-report-read-adapter.js";
import type { AcceptedReportHistoryItem } from "../../application/reports/accepted-report-history-read-adapter.js";
import type { PrivacyReviewReadDTO } from "../../application/privacy/privacy-review-read-adapter.js";
import type { WorkflowState } from "../../application/workflow/workflow-state-read-adapter.js";
import type { ReportAcceptanceService } from "../../application/reports/report-acceptance-service.js";

export type HttpBoundaryCode = "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "METHOD_NOT_ALLOWED" | "LOCAL_ACCESS_REQUIRED";

export const CreateAuditRequestSchema = z.object({ displayName: z.string().trim().min(1).max(256) }).strict();
export const PasteRequestSchema = z.object({
  text: z.string().min(1).max(256 * 1024).refine((value) => Buffer.byteLength(value, "utf8") <= 256 * 1024),
  sourceName: z.string().min(1).max(512).optional(),
  author: z.string().min(1).max(256).nullable().optional(),
}).strict();

const DetectionCommand = z.object({ type: z.literal("ACCEPT_DETECTION"), detection_id: z.string().min(1).max(128), seed_placeholder: z.string().min(1).max(128).optional() }).strict();
const FalsePositiveCommand = z.object({ type: z.literal("MARK_FALSE_POSITIVE"), detection_id: z.string().min(1).max(128) }).strict();
const ReplacementPolicyCommand = z.object({ type: z.literal("SET_REPLACEMENT_POLICY"), detection_id: z.string().min(1).max(128), policy: z.enum(["PSEUDONYMIZE", "REDACT"]) }).strict();
const MergeCommand = z.object({ type: z.literal("MERGE_ENTITIES"), semantic_entity_ids: z.array(z.string().min(1).max(128)).min(2).max(256), survivor_placeholder: z.string().min(1).max(128).optional() }).strict();
const SplitCommand = z.object({ type: z.literal("SPLIT_ENTITY"), semantic_entity_id: z.string().min(1).max(128), partitions: z.array(z.array(z.string().min(1).max(128)).min(1).max(2048)).min(2).max(2048), retained_partition_index: z.number().int().nonnegative().max(2047) }).strict();
const PlaceholderCommand = z.object({ type: z.literal("SET_PLACEHOLDER"), semantic_entity_id: z.string().min(1).max(128), placeholder: z.string().min(1).max(128) }).strict();
const UrlVisibilityCommand = z.object({ type: z.literal("SET_URL_VISIBILITY"), detection_id: z.string().min(1).max(128), visibility: z.enum(["HIDDEN", "RESTORED"]) }).strict();
const FinalizeCommand = z.object({ type: z.literal("FINALIZE_REVIEW_CANDIDATE") }).strict();
export const ReviewCommandRequestSchema = z.discriminatedUnion("type", [DetectionCommand, FalsePositiveCommand, ReplacementPolicyCommand, MergeCommand, SplitCommand, PlaceholderCommand, UrlVisibilityCommand, FinalizeCommand]);

export const ConfirmPrivacyRequestSchema = z.object({ reviewCandidateId: z.string().regex(/^rcand_[0-9a-f]{64}$/u) }).strict();
export const EmptyRequestSchema = z.object({}).strict();
export const AcceptReportRequestSchema = z.object({ expectedCanonicalDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();
export const AuditPathSchema = z.object({ auditId: AuditIdSchema }).strict();
export const ReportPathSchema = z.object({ auditId: AuditIdSchema, reportVersionId: ReportVersionIdSchema }).strict();

export type CreateAuditRequest = z.infer<typeof CreateAuditRequestSchema>;
export type PasteRequest = z.infer<typeof PasteRequestSchema>;
export type ReviewCommandRequest = z.infer<typeof ReviewCommandRequestSchema>;
export type ConfirmPrivacyRequest = z.infer<typeof ConfirmPrivacyRequestSchema>;
export type AcceptReportRequest = z.infer<typeof AcceptReportRequestSchema>;

export type AuditResponseDTO = Readonly<{ auditId: string; displayName: string; createdAt: string }>;
export function toAuditResponseDTO(value: ApplicationAuditDTO): AuditResponseDTO {
  return Object.freeze({ auditId: value.auditId, displayName: value.displayName, createdAt: value.createdAt });
}

export type WorkflowStateResponseDTO = Readonly<{
  auditId: string;
  privacyConfirmed: boolean;
  privacyConfirmedAt: string | null;
  latestSettledReport: Readonly<{ reportVersionId: string; versionNumber: number; status: "COMPLETED" | "FAILED" }> | null;
}>;
export function toWorkflowStateResponseDTO(value: WorkflowState): WorkflowStateResponseDTO {
  const report = value.latestSettledReport;
  return Object.freeze({ auditId: value.auditId, privacyConfirmed: value.privacyConfirmed, privacyConfirmedAt: value.privacyConfirmedAt,
    latestSettledReport: report ? Object.freeze({ reportVersionId: report.reportVersionId, versionNumber: report.versionNumber, status: report.status }) : null });
}

export function toPrivacyReviewResponseDTO(value: PrivacyReviewReadDTO): PrivacyReviewReadDTO {
  return Object.freeze({ stage: value.stage, detections: Object.freeze(value.detections.map((item) => Object.freeze({ ...item }))), entities: Object.freeze(value.entities.map((item) => Object.freeze({ ...item }))), seedPlaceholders: Object.freeze([...value.seedPlaceholders]), counters: Object.freeze({ ...value.counters }) });
}

export function toAcceptedHistoryResponseDTO(values: readonly AcceptedReportHistoryItem[]) {
  return Object.freeze(values.map((item) => Object.freeze({ reportVersionId: item.reportVersionId, versionNumber: item.versionNumber, acceptedAt: item.acceptedAt })));
}

export function toAcceptedReportResponseDTO(value: SafeAcceptedReport) {
  return Object.freeze({
    reportVersionId: value.report_version_id,
    canonicalDigest: value.canonical_digest,
    acceptedAt: value.accepted_at,
    ...toSafeReportContent(value.canonical_snapshot),
  });
}

export function toReportPreviewResponseDTO(value: ReturnType<ReportAcceptanceService["preview"]>) {
  return Object.freeze({ reportVersionId: value.canonical_snapshot.binding.report_version_id, canonicalDigest: value.canonical_digest, accepted: false, ...toSafeReportContent(value.canonical_snapshot) });
}

function toSafeReportContent(snapshot: SafeAcceptedReport["canonical_snapshot"]) {
  const version = snapshot.report.report_version;
  return Object.freeze({
    versionNumber: version.version_number,
    completedAt: version.completed_at,
    summary: Object.freeze({
      items: Object.freeze(snapshot.report.audit_summary.items.map((item) => Object.freeze({ text: item.text, epistemicStatus: item.epistemic_status, conflicted: item.conflicted }))),
      unresolvedItems: Object.freeze([...snapshot.report.audit_summary.unresolved_items]),
    }),
    evidence: Object.freeze(snapshot.evidence.map((item) => Object.freeze({ sourceName: item.source_ref.source_name, excerpt: item.excerpt, timestamp: item.timestamp, evidenceType: item.evidence_type }))),
    commitments: Object.freeze(snapshot.commitments.map((item) => Object.freeze({ classification: item.classification, actor: item.actor, actionOrDeliverable: item.action_or_deliverable, deadline: item.deadline, condition: item.condition, recipient: item.recipient, lifecycleStatus: item.lifecycle_status, epistemicStatus: item.epistemic_status }))),
    changes: Object.freeze(snapshot.changes.map((item) => Object.freeze({ changeType: item.change_type, subject: item.subject, beforeSummary: item.before_summary, afterSummary: item.after_summary, timestamp: item.timestamp, classification: item.classification, epistemicStatus: item.epistemic_status }))),
    conflicts: Object.freeze(snapshot.conflicts.map((item) => Object.freeze({ claimA: item.claim_a.text, claimB: item.claim_b.text, subject: item.comparable_context.subject, timeContext: item.comparable_context.time_context, versionContext: item.comparable_context.version_context, conditionContext: item.comparable_context.condition_context, reason: item.conflict_reason, alternatives: Object.freeze(item.alternative_explanations.map((alternative) => Object.freeze({ text: alternative.text, epistemicStatus: alternative.epistemic_status }))), missingEvidence: Object.freeze([...item.missing_evidence]) }))),
  });
}
