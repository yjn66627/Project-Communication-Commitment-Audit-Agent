import { z } from "zod";

import {
  ChangeIdSchema,
  ChangeTypeSchema,
  EvidenceIdSchema,
  ReportVersionIdSchema,
} from "./base.js";

const ChangeBaseShape = {
  change_id: ChangeIdSchema,
  report_version_id: ReportVersionIdSchema,
  change_type: ChangeTypeSchema,
  subject: z.string().min(1),
  before_summary: z.string().min(1).nullable(),
  after_summary: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema).min(1),
  timestamp: z.string().max(128).nullable(),
} as const;

export const ConfirmedChangeSchema = z.object({
  ...ChangeBaseShape,
  classification: z.literal("CONFIRMED"),
  epistemic_status: z.literal("FACT"),
}).strict();

export const CandidateChangeSchema = z.object({
  ...ChangeBaseShape,
  classification: z.literal("CANDIDATE"),
  epistemic_status: z.enum(["INFERENCE", "UNKNOWN"]),
}).strict();

export const ChangeSchema = z.discriminatedUnion("classification", [
  ConfirmedChangeSchema,
  CandidateChangeSchema,
]);

export type RequirementDecisionChange = z.infer<typeof ChangeSchema>;
