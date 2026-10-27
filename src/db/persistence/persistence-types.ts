import { z } from "zod";

import {
  AuditIdSchema,
  ProviderCallIdSchema,
  ReportVersionIdSchema,
} from "../../domain/schemas/base.js";

export const PersistenceErrorCodeSchema = z.enum([
  "JSON_CODEC_ERROR",
  "PERSISTENCE_INTEGRITY_ERROR",
  "DOMAIN_VALIDATION_ERROR",
]);

export type PersistenceErrorCode = z.infer<typeof PersistenceErrorCodeSchema>;

/**
 * Safe persistence-boundary error. It deliberately carries no source value,
 * JSON payload, revision_salt, original_value, provider body, or credential.
 */
export class PersistenceBoundaryError extends Error {
  readonly code: PersistenceErrorCode;
  readonly field: string;

  constructor(code: PersistenceErrorCode, field: string, message: string) {
    super(message);
    this.name = "PersistenceBoundaryError";
    this.code = code;
    this.field = field;
  }
}

export const IsoUtcTextSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => value.endsWith("Z"), "Persistence timestamp must be UTC (Z)." );

export const RevisionSaltTextSchema = z.string().superRefine((value, context) => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "revision_salt must be base64url." });
    return;
  }

  try {
    const decoded = Buffer.from(value, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "revision_salt must be canonical base64url for exactly 32 bytes.",
      });
    }
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "revision_salt must be base64url." });
  }
});

export const AuditPersistenceInputSchema = z.object({
  audit_id: AuditIdSchema,
  revision_salt: RevisionSaltTextSchema,
  created_at: IsoUtcTextSchema,
}).strict();

export const SafeAuditViewSchema = z.object({
  audit_id: AuditIdSchema,
  created_at: IsoUtcTextSchema,
}).strict();

export type AuditPersistenceInput = z.infer<typeof AuditPersistenceInputSchema>;
export type SafeAuditView = z.infer<typeof SafeAuditViewSchema>;

/** Frozen observability counts-summary only; never a provider response body. */
export const ProviderOutputCountsSchema = z.object({
  evidence: z.number().int().nonnegative().optional(),
  commitments: z.number().int().nonnegative().optional(),
  changes: z.number().int().nonnegative().optional(),
  conflicts: z.number().int().nonnegative().optional(),
  unknown: z.number().int().nonnegative().optional(),
}).strict();

export type ProviderOutputCounts = z.infer<typeof ProviderOutputCountsSchema>;

export const ProviderCallPersistenceSchema = z.object({
  provider_call_id: ProviderCallIdSchema,
  audit_id: AuditIdSchema,
  report_version_id: ReportVersionIdSchema.nullable(),
  stage: z.string().min(1),
  provider_name: z.string().min(1),
  model_name: z.string().min(1),
  started_at: z.string().datetime({ offset: true }),
  completed_at: z.string().datetime({ offset: true }).nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
  status: z.string().min(1),
  input_record_count: z.number().int().nonnegative().nullable(),
  input_size_chars: z.number().int().nonnegative().nullable(),
  input_tokens: z.number().int().nonnegative().nullable(),
  output_tokens: z.number().int().nonnegative().nullable(),
  total_tokens: z.number().int().nonnegative().nullable(),
  cost_amount_micros: z.number().int().nonnegative().nullable(),
  cost_currency: z.string().min(1).nullable(),
  retry_count: z.number().int().nonnegative(),
  schema_valid: z.boolean().nullable(),
  error_category: z.string().min(1).nullable(),
  output_counts: ProviderOutputCountsSchema.nullable(),
}).strict();

export type ProviderCallPersistence = z.infer<typeof ProviderCallPersistenceSchema>;
