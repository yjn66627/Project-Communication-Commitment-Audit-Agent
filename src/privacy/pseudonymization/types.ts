import type {
  PrivacyDetectionSurface,
  PrivacyEntityType,
  PrivacyReplacementPolicy,
} from "../detection/types.js";

export type MappablePrivacyEntityType = Exclude<PrivacyEntityType, "SECRET">;
export type SemanticEntityState = "ACTIVE" | "MERGED_INTO" | "SPLIT_DERIVED";
export type MappingProvenance = "SEED" | "CURRENT" | "RETIRED";

export interface SeedPrivacyMapping {
  readonly audit_id: string;
  readonly entity_type: MappablePrivacyEntityType;
  readonly placeholder: string;
  readonly original_value: string;
  readonly normalized_key: string;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly seed_revision_id?: string | null;
}

export interface ReviewMember {
  readonly detection_id: string;
  readonly record_id: string;
  readonly record_sequence: number;
  readonly surface: PrivacyDetectionSurface;
  readonly effective_start: number;
  readonly effective_end: number;
  readonly entity_type: PrivacyEntityType;
  readonly normalized_key: string | null;
  readonly raw_value: string;
}

export interface ReviewSemanticEntity {
  readonly semantic_entity_id: string;
  readonly audit_id: string;
  readonly entity_type: MappablePrivacyEntityType;
  readonly member_detection_ids: readonly string[];
  readonly state: SemanticEntityState;
  readonly merged_into: string | null;
  readonly placeholder: string | null;
  readonly seed_placeholder: string | null;
  readonly seed_backed: boolean;
}

export interface LocalPrivacyMappingDraft {
  readonly local_high_sensitivity: true;
  readonly semantic_entity_id: string;
  readonly entity_type: MappablePrivacyEntityType;
  readonly placeholder: string;
  readonly original_value: string;
  readonly normalized_key: string;
  readonly aliases: readonly string[];
  readonly active: boolean;
  readonly provenance: MappingProvenance;
  readonly seed_revision_id: string | null;
}

export interface PseudonymMappingPlan {
  readonly audit_id: string;
  readonly mappings: readonly LocalPrivacyMappingDraft[];
  readonly semantic_entities: readonly ReviewSemanticEntity[];
  readonly reserved_placeholders: readonly string[];
}

export interface EntityAllocationAnchor {
  readonly record_sequence: number;
  readonly record_id: string;
  readonly surface: PrivacyDetectionSurface;
  readonly effective_start: number;
  readonly effective_end: number;
  readonly entity_type: MappablePrivacyEntityType;
  readonly normalized_key: string | null;
  readonly semantic_entity_id: string;
}

export const DEFAULT_REPLACEMENT_POLICY: Readonly<Record<PrivacyEntityType, PrivacyReplacementPolicy>> = Object.freeze({
  PERSON: "PSEUDONYMIZE",
  ORG: "PSEUDONYMIZE",
  PROJECT: "PSEUDONYMIZE",
  PHONE: "PSEUDONYMIZE",
  EMAIL: "PSEUDONYMIZE",
  ID_CARD: "REDACT",
  IP: "PSEUDONYMIZE",
  URL: "REDACT",
  SECRET: "LOCKED_REDACTION",
});
