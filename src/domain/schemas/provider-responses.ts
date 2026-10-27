import { z } from "zod";

import {
  ChangeTypeSchema,
  EvidenceIdSchema,
  EvidenceTypeSchema,
  RecordRevisionIdSchema,
} from "./base.js";
import {
  AlternativeExplanationSchema,
  ComparableContextSchema,
  ConflictClaimSchema,
} from "./conflict.js";
import { AuditSummarySchema } from "./report.js";

export const EvidenceCandidateSchema = z.object({
  record_revision_id: RecordRevisionIdSchema,
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().positive(),
  excerpt: z.string().min(1),
  actor: z.string().min(1).nullable(),
  timestamp: z.string().max(128).nullable(),
  evidence_type: EvidenceTypeSchema,
}).strict().superRefine((value, context) => {
  if (value.char_end <= value.char_start) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["char_end"],
      message: "char_end must be greater than char_start.",
    });
  }
});

export const EvidenceExtractionResponseSchema = z.object({
  candidates: z.array(EvidenceCandidateSchema),
}).strict();

const ProviderCommitmentConfirmedSchema = z.object({
  classification: z.literal("CONFIRMED"),
  actor: z.string().min(1),
  action_or_deliverable: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema).min(1),
  deadline: z.string().max(128).nullable(),
  condition: z.string().min(1).nullable(),
  recipient: z.string().min(1).nullable(),
  epistemic_status: z.literal("FACT"),
}).strict();

const ProviderCommitmentCandidateSchema = z.object({
  classification: z.literal("CANDIDATE"),
  actor: z.string().min(1).nullable(),
  action_or_deliverable: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema).min(1),
  deadline: z.string().max(128).nullable(),
  condition: z.string().min(1).nullable(),
  recipient: z.string().min(1).nullable(),
  epistemic_status: z.enum(["INFERENCE", "UNKNOWN"]),
}).strict();

const ProviderChangeConfirmedSchema = z.object({
  classification: z.literal("CONFIRMED"),
  change_type: ChangeTypeSchema,
  subject: z.string().min(1),
  before_summary: z.string().min(1).nullable(),
  after_summary: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema).min(1),
  timestamp: z.string().max(128).nullable(),
  epistemic_status: z.literal("FACT"),
}).strict();

const ProviderChangeCandidateSchema = z.object({
  classification: z.literal("CANDIDATE"),
  change_type: ChangeTypeSchema,
  subject: z.string().min(1),
  before_summary: z.string().min(1).nullable(),
  after_summary: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema).min(1),
  timestamp: z.string().max(128).nullable(),
  epistemic_status: z.enum(["INFERENCE", "UNKNOWN"]),
}).strict();

export const CommitmentChangeResponseSchema = z.object({
  commitments: z.array(z.discriminatedUnion("classification", [
    ProviderCommitmentConfirmedSchema,
    ProviderCommitmentCandidateSchema,
  ])),
  changes: z.array(z.discriminatedUnion("classification", [
    ProviderChangeConfirmedSchema,
    ProviderChangeCandidateSchema,
  ])),
}).strict();

export const ConflictReviewResponseSchema = z.object({
  potential_conflicts: z.array(z.object({
    claim_a: ConflictClaimSchema,
    claim_b: ConflictClaimSchema,
    comparable_context: ComparableContextSchema,
    conflict_reason: z.string().min(1),
    counter_evidence_ids: z.array(EvidenceIdSchema),
    alternative_explanations: z.array(AlternativeExplanationSchema),
    epistemic_status: z.enum(["INFERENCE", "UNKNOWN"]),
    missing_evidence: z.array(z.string().min(1)),
  }).strict()),
}).strict();

export const ReportSummaryResponseSchema = z.object({
  summary: AuditSummarySchema,
  changes_summary: z.string().min(1).nullable(),
}).strict();
