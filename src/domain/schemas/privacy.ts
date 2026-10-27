import { z } from "zod";

import {
  AuditIdSchema,
  MappablePrivacyEntityTypeSchema,
  PrivacyEntityTypeSchema,
  PrivacyRevisionIdSchema,
  RecordIdSchema,
} from "./base.js";

const OriginalSpanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
  text: z.string().min(1),
}).strict().superRefine((value, context) => {
  if (value.end <= value.start) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["end"],
      message: "Privacy entity span end must be greater than start.",
    });
  }
});

/** Local-trust-zone schema only. It intentionally contains original text. */
export const PrivacyEntitySchema = z.object({
  privacy_entity_id: z.string().min(1).max(128),
  entity_type: PrivacyEntityTypeSchema,
  record_id: RecordIdSchema,
  original_span: OriginalSpanSchema,
  placeholder: z.string().min(1).max(128),
  detection_source: z.enum([
    "DETERMINISTIC_RULE",
    "LOCAL_HEURISTIC",
    "LOCAL_MODEL",
    "USER",
  ]),
  detection_confidence: z.enum(["HIGH", "MEDIUM", "LOW", "NOT_APPLICABLE"]),
  user_review_state: z.enum([
    "UNREVIEWED",
    "ACCEPTED",
    "MODIFIED",
    "REJECTED_AS_FALSE_POSITIVE",
    "LOCKED_REDACTION",
  ]),
}).strict();

/**
 * High-sensitivity local-only object. Never serialize this schema into a remote
 * provider payload. SECRET is structurally excluded from reversible mappings.
 */
export const PrivacyMappingSchema = z.object({
  mapping_id: z.string().startsWith("map_"),
  audit_id: AuditIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  entity_type: MappablePrivacyEntityTypeSchema,
  placeholder: z.string().min(1).max(128),
  original_value: z.string().min(1),
  normalized_key: z.string().min(1),
  aliases: z.array(z.string().min(1)).default([]),
  active: z.boolean(),
}).strict();

export const ConfirmedPrivacyRevisionSchema = z.object({
  privacy_revision_id: PrivacyRevisionIdSchema,
  audit_id: AuditIdSchema,
  confirmation_state: z.literal("CONFIRMED"),
  algorithm: z.literal("privacy-revision-v1"),
  confirmed_at: z.string().datetime({ offset: true }),
  record_count: z.number().int().positive(),
  mapping_count: z.number().int().nonnegative(),
}).strict();

export type PrivacyEntity = z.infer<typeof PrivacyEntitySchema>;
export type PrivacyMapping = z.infer<typeof PrivacyMappingSchema>;
export type ConfirmedPrivacyRevision = z.infer<typeof ConfirmedPrivacyRevisionSchema>;
