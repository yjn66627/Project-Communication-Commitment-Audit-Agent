import { z, type ZodType } from "zod";

import { EvidenceIdSchema } from "../../domain/schemas/base.js";
import {
  AlternativeExplanationSchema,
} from "../../domain/schemas/conflict.js";
import { SanitizedRecordMetadataSchema } from "../../domain/schemas/canonical.js";
import {
  PersistenceBoundaryError,
  ProviderOutputCountsSchema,
  type ProviderOutputCounts,
} from "./persistence-types.js";

const EvidenceIdsNonEmptySchema = z.array(EvidenceIdSchema).min(1);
const EvidenceIdsSchema = z.array(EvidenceIdSchema);
const AliasesSchema = z.array(z.string().min(1));
const AlternativeExplanationsSchema = z.array(AlternativeExplanationSchema);
const MissingEvidenceSchema = z.array(z.string().min(1));

type Codec<T> = Readonly<{
  encode(value: unknown): string;
  decode(text: string): T;
}>;

function encodeValidatedJson<T>(field: string, schema: ZodType<T>, value: unknown): string {
  const validated = schema.safeParse(value);
  if (!validated.success) {
    throw new PersistenceBoundaryError(
      "DOMAIN_VALIDATION_ERROR",
      field,
      `JSON field validation failed before persistence: ${field}`,
    );
  }

  try {
    const encoded = JSON.stringify(validated.data);
    if (typeof encoded !== "string") {
      throw new PersistenceBoundaryError(
        "JSON_CODEC_ERROR",
        field,
        `JSON serialization did not produce text: ${field}`,
      );
    }
    return encoded;
  } catch (error: unknown) {
    if (error instanceof PersistenceBoundaryError) {
      throw error;
    }
    throw new PersistenceBoundaryError(
      "JSON_CODEC_ERROR",
      field,
      `JSON serialization failed: ${field}`,
    );
  }
}

function decodeValidatedJson<T>(field: string, schema: ZodType<T>, text: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new PersistenceBoundaryError(
      "JSON_CODEC_ERROR",
      field,
      `Stored JSON is syntactically invalid: ${field}`,
    );
  }

  const validated = schema.safeParse(parsed);
  if (!validated.success) {
    throw new PersistenceBoundaryError(
      "PERSISTENCE_INTEGRITY_ERROR",
      field,
      `Stored JSON violates the frozen persistence contract: ${field}`,
    );
  }
  return validated.data;
}

function makeCodec<T>(field: string, schema: ZodType<T>): Codec<T> {
  return Object.freeze({
    encode: (value: unknown) => encodeValidatedJson(field, schema, value),
    decode: (text: string) => decodeValidatedJson(field, schema, text),
  });
}

/** Exactly the 11 CP-1C JSON TEXT fields. Generic helpers are intentionally not exported. */
export const jsonFieldCodecs = Object.freeze({
  canonicalMetadata: makeCodec(
    "canonical_records.metadata_json",
    SanitizedRecordMetadataSchema,
  ),
  privacyMappingAliases: makeCodec(
    "privacy_mappings.aliases_json",
    AliasesSchema,
  ),
  commitmentEvidenceIds: makeCodec(
    "commitments.evidence_ids_json",
    EvidenceIdsNonEmptySchema,
  ),
  commitmentStatusEvidenceIds: makeCodec(
    "commitments.status_evidence_ids_json",
    EvidenceIdsSchema,
  ),
  changeEvidenceIds: makeCodec(
    "changes.evidence_ids_json",
    EvidenceIdsNonEmptySchema,
  ),
  conflictClaimAEvidenceIds: makeCodec(
    "conflicts.claim_a_evidence_ids_json",
    EvidenceIdsNonEmptySchema,
  ),
  conflictClaimBEvidenceIds: makeCodec(
    "conflicts.claim_b_evidence_ids_json",
    EvidenceIdsNonEmptySchema,
  ),
  conflictCounterEvidenceIds: makeCodec(
    "conflicts.counter_evidence_ids_json",
    EvidenceIdsSchema,
  ),
  conflictAlternativeExplanations: makeCodec(
    "conflicts.alternative_explanations_json",
    AlternativeExplanationsSchema,
  ),
  conflictMissingEvidence: makeCodec(
    "conflicts.missing_evidence_json",
    MissingEvidenceSchema,
  ),
  providerOutputCounts: makeCodec<ProviderOutputCounts>(
    "provider_calls.output_counts_json",
    ProviderOutputCountsSchema,
  ),
});

export type JsonFieldCodecName = keyof typeof jsonFieldCodecs;
