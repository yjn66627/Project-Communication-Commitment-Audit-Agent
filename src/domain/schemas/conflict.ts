import { z } from "zod";

import { ConflictIdSchema, EvidenceIdSchema, ReportVersionIdSchema } from "./base.js";

export const ConflictClaimSchema = z.object({
  text: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema).min(1),
}).strict();

export const AlternativeExplanationSchema = z.object({
  text: z.string().min(1),
  epistemic_status: z.literal("INFERENCE"),
}).strict();

export const ComparableContextSchema = z.object({
  subject: z.string().min(1),
  time_context: z.string().min(1).nullable(),
  version_context: z.string().min(1).nullable(),
  condition_context: z.string().min(1).nullable(),
}).strict();

export const PotentialConflictSchema = z.object({
  conflict_id: ConflictIdSchema,
  report_version_id: ReportVersionIdSchema,
  conflict_type: z.literal("POTENTIAL_CONFLICT"),
  claim_a: ConflictClaimSchema,
  claim_b: ConflictClaimSchema,
  comparable_context: ComparableContextSchema,
  conflict_reason: z.string().min(1),
  counter_evidence_ids: z.array(EvidenceIdSchema),
  alternative_explanations: z.array(AlternativeExplanationSchema),
  missing_evidence: z.array(z.string().min(1)),
  epistemic_status: z.enum(["INFERENCE", "UNKNOWN"]),
  conflicted: z.literal(true),
}).strict();

export type PotentialConflict = z.infer<typeof PotentialConflictSchema>;
