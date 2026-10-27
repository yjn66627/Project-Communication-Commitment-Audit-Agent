import { z } from "zod";

import {
  CommitmentIdSchema,
  CommitmentLifecycleStatusSchema,
  EvidenceIdSchema,
  ReportVersionIdSchema,
} from "./base.js";

const CommitmentBaseShape = {
  commitment_id: CommitmentIdSchema,
  report_version_id: ReportVersionIdSchema,
  action_or_deliverable: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema).min(1),
  deadline: z.string().max(128).nullable(),
  condition: z.string().min(1).nullable(),
  recipient: z.string().min(1).nullable(),
  lifecycle_status: CommitmentLifecycleStatusSchema,
  supersedes_commitment_id: CommitmentIdSchema.nullable(),
  status_evidence_ids: z.array(EvidenceIdSchema),
} as const;

export const ConfirmedCommitmentSchema = z.object({
  ...CommitmentBaseShape,
  classification: z.literal("CONFIRMED"),
  actor: z.string().min(1),
  epistemic_status: z.literal("FACT"),
}).strict();

export const CandidateCommitmentSchema = z.object({
  ...CommitmentBaseShape,
  classification: z.literal("CANDIDATE"),
  actor: z.string().min(1).nullable(),
  epistemic_status: z.enum(["INFERENCE", "UNKNOWN"]),
}).strict();

export const CommitmentSchema = z.discriminatedUnion("classification", [
  ConfirmedCommitmentSchema,
  CandidateCommitmentSchema,
]).superRefine((value, context) => {
  if (value.lifecycle_status === "FULFILLED" && value.status_evidence_ids.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status_evidence_ids"],
      message: "FULFILLED commitment requires completion/status Evidence.",
    });
  }
});

export type Commitment = z.infer<typeof CommitmentSchema>;
