import { z } from "zod";

import {
  AuditIdSchema,
  ChangeIdSchema,
  CommitmentIdSchema,
  ConflictIdSchema,
  EpistemicStatusSchema,
  EvidenceIdSchema,
  PrivacyRevisionIdSchema,
  ReportVersionIdSchema,
} from "./base.js";

export const MissingEvidenceSchema = z.object({
  item_id: z.string().min(1).max(128),
  subject: z.string().min(1),
  question: z.string().min(1),
  known_evidence_ids: z.array(EvidenceIdSchema),
  missing_information: z.string().min(1),
  epistemic_status: z.literal("UNKNOWN"),
}).strict();

export const DomainReferenceIdSchema = z.union([
  CommitmentIdSchema,
  ChangeIdSchema,
  ConflictIdSchema,
]);

export const AuditSummaryItemSchema = z.object({
  text: z.string().min(1),
  epistemic_status: EpistemicStatusSchema,
  evidence_ids: z.array(EvidenceIdSchema),
  domain_ids: z.array(DomainReferenceIdSchema),
  conflicted: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.epistemic_status === "FACT" && value.evidence_ids.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["evidence_ids"],
      message: "FACT summary item requires Evidence.",
    });
  }
});

export const AuditSummarySchema = z.object({
  items: z.array(AuditSummaryItemSchema),
  unresolved_items: z.array(z.string().min(1)),
}).strict();

export const ReportVersionStatusSchema = z.enum([
  "DRAFT",
  "RUNNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
]);

export const ReportVersionSchema = z.object({
  report_version_id: ReportVersionIdSchema,
  audit_id: AuditIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  parent_report_version_id: ReportVersionIdSchema.nullable(),
  version_number: z.number().int().positive(),
  status: ReportVersionStatusSchema,
  changes_summary: z.string().min(1).nullable(),
  created_at: z.string().datetime({ offset: true }),
  started_at: z.string().datetime({ offset: true }).nullable(),
  completed_at: z.string().datetime({ offset: true }).nullable(),
}).strict();

/** Timeline is a derived report view, not a new source of truth. */
export const TimelineEventSchema = z.object({
  event_type: z.enum(["EVIDENCE", "COMMITMENT", "CHANGE", "CONFLICT"]),
  occurred_at: z.string().max(128).nullable(),
  display_summary: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema),
  epistemic_status: EpistemicStatusSchema,
}).strict();

export const AuditReportSchema = z.object({
  report_version: ReportVersionSchema,
  audit_summary: AuditSummarySchema,
  evidence_ledger: z.array(EvidenceIdSchema),
  timeline: z.array(TimelineEventSchema),
  commitment_ledger: z.array(CommitmentIdSchema),
  requirement_decision_change_log: z.array(ChangeIdSchema),
  conflict_counter_evidence_review: z.array(ConflictIdSchema),
  missing_evidence_and_uncertainty: z.array(MissingEvidenceSchema),
}).strict();

export type MissingEvidence = z.infer<typeof MissingEvidenceSchema>;
export type AuditSummary = z.infer<typeof AuditSummarySchema>;
export type ReportVersion = z.infer<typeof ReportVersionSchema>;
export type AuditReport = z.infer<typeof AuditReportSchema>;
