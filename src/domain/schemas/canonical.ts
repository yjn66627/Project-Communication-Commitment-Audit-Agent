import { z } from "zod";

import {
  AuditIdSchema,
  MetadataValueSchema,
  PrivacyRevisionIdSchema,
  RecordIdSchema,
  RecordRevisionIdSchema,
  SourceTypeSchema,
} from "./base.js";

/** Raw/local-trust-zone record. Never pass this object to GraphState or Provider payloads. */
export const CanonicalRecordDraftSchema = z.object({
  record_id: RecordIdSchema,
  source_type: SourceTypeSchema,
  source_name: z.string().min(1).max(512),
  author: z.string().min(1).max(256).nullable(),
  timestamp: z.string().max(128).nullable(),
  content: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  metadata: z.record(MetadataValueSchema).optional(),
}).strict();

/**
 * DEV-02 starts with an intentionally empty metadata allowlist for sanitized
 * records. Future keys must be added explicitly; arbitrary raw metadata cannot pass.
 */
export const SanitizedRecordMetadataSchema = z.object({}).strict();

export const SanitizedCanonicalRecordRevisionSchema = z.object({
  record_revision_id: RecordRevisionIdSchema,
  audit_id: AuditIdSchema,
  record_id: RecordIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  source_type: SourceTypeSchema,
  source_name: z.string().min(1).max(512),
  author: z.string().min(1).max(256).nullable(),
  timestamp: z.string().max(128).nullable(),
  sanitized_content: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  metadata: SanitizedRecordMetadataSchema.optional(),
}).strict();

export type CanonicalRecordDraft = z.infer<typeof CanonicalRecordDraftSchema>;
export type SanitizedCanonicalRecordRevision = z.infer<
  typeof SanitizedCanonicalRecordRevisionSchema
>;
