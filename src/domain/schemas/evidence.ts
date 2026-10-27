import { z } from "zod";

import {
  EvidenceIdSchema,
  EvidenceTypeSchema,
  PrivacyRevisionIdSchema,
  RecordIdSchema,
  RecordRevisionIdSchema,
  ReportVersionIdSchema,
} from "./base.js";

export const SourceReferenceSchema = z.object({
  source_name: z.string().min(1).max(512),
  sequence: z.number().int().nonnegative(),
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if (value.char_end <= value.char_start) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["char_end"],
      message: "char_end must be greater than char_start.",
    });
  }
});

/**
 * FACT here means Source Fact only: the source material contains the cited
 * statement/record. It does not assert that the described real-world event is true.
 */
export const EvidenceSchema = z.object({
  evidence_id: EvidenceIdSchema,
  report_version_id: ReportVersionIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  record_revision_id: RecordRevisionIdSchema,
  record_id: RecordIdSchema,
  source_ref: SourceReferenceSchema,
  excerpt: z.string().min(1),
  actor: z.string().min(1).nullable(),
  timestamp: z.string().max(128).nullable(),
  evidence_type: EvidenceTypeSchema,
  epistemic_status: z.literal("FACT"),
  fact_scope: z.literal("SOURCE_FACT"),
}).strict();

export type Evidence = z.infer<typeof EvidenceSchema>;
