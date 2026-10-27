import type { CanonicalRecordDraft } from "../../domain/schemas/canonical.js";
import type {
  PrivacyReplacementPolicy,
  ResolvedPrivacyDetection,
  SourceNamePolicyResult,
} from "../detection/types.js";
import type {
  LocalPrivacyMappingDraft,
  ReviewMember,
  ReviewSemanticEntity,
  SeedPrivacyMapping,
} from "../pseudonymization/types.js";

export type ReviewStage = "DETECTED" | "REVIEW_REQUIRED" | "REVIEW_COMPLETE";
export type DetectionDecisionState = "PENDING_REVIEW" | "ACCEPTED" | "FALSE_POSITIVE" | "LOCKED_REDACTION";
export type UrlVisibility = "HIDDEN" | "RESTORED";

export interface DetectionDecision {
  readonly detection_id: string;
  readonly semantic_entity_id: string | null;
  readonly state: DetectionDecisionState;
  readonly replacement_policy: PrivacyReplacementPolicy;
  readonly url_visibility: UrlVisibility | null;
  readonly does_not_disable_future_egress_secret_scan: boolean;
}

export interface ReviewCounters {
  readonly merge_count: number;
  readonly split_count: number;
  readonly false_positive_count: number;
}

export interface ReviewSession {
  readonly audit_id: string;
  readonly stage: ReviewStage;
  readonly records: Readonly<Record<string, CanonicalRecordDraft>>;
  readonly detections: Readonly<Record<string, ResolvedPrivacyDetection>>;
  readonly members: Readonly<Record<string, ReviewMember>>;
  readonly decisions: Readonly<Record<string, DetectionDecision>>;
  readonly entities: Readonly<Record<string, ReviewSemanticEntity>>;
  readonly source_name_policies: Readonly<Record<string, SourceNamePolicyResult>>;
  readonly seed_mappings: readonly SeedPrivacyMapping[];
  readonly retired_mappings: readonly LocalPrivacyMappingDraft[];
  readonly counters: ReviewCounters;
}

export type ReviewCommand =
  | Readonly<{ type: "ACCEPT_DETECTION"; detection_id: string; seed_placeholder?: string }>
  | Readonly<{ type: "MARK_FALSE_POSITIVE"; detection_id: string }>
  | Readonly<{ type: "SET_REPLACEMENT_POLICY"; detection_id: string; policy: "PSEUDONYMIZE" | "REDACT" }>
  | Readonly<{ type: "MERGE_ENTITIES"; semantic_entity_ids: readonly string[]; survivor_placeholder?: string }>
  | Readonly<{ type: "SPLIT_ENTITY"; semantic_entity_id: string; partitions: readonly (readonly string[])[]; retained_partition_index: number }>
  | Readonly<{ type: "SET_PLACEHOLDER"; semantic_entity_id: string; placeholder: string }>
  | Readonly<{ type: "SET_URL_VISIBILITY"; detection_id: string; visibility: UrlVisibility }>
  | Readonly<{ type: "FINALIZE_REVIEW_CANDIDATE" }>;

export type ReviewErrorCode =
  | "REVIEW_DETECTION_NOT_FOUND"
  | "REVIEW_ENTITY_NOT_FOUND"
  | "REVIEW_SECRET_POLICY_FORBIDDEN"
  | "REVIEW_INVALID_ENTITY_TYPE"
  | "REVIEW_SEED_NOT_FOUND"
  | "REVIEW_SEED_ALREADY_BOUND"
  | "REVIEW_MERGE_INVALID"
  | "REVIEW_MERGE_SURVIVOR_REQUIRED"
  | "REVIEW_SPLIT_INVALID"
  | "REVIEW_PLACEHOLDER_INVALID"
  | "REVIEW_PLACEHOLDER_RESERVED"
  | "REVIEW_URL_COMMAND_INVALID"
  | "REVIEW_PENDING_DECISIONS";

export class ReviewRuntimeError extends Error {
  readonly code: ReviewErrorCode;
  constructor(code: ReviewErrorCode, message: string) {
    super(message);
    this.name = "ReviewRuntimeError";
    this.code = code;
  }
}

export interface LocalReviewDetectionDTO {
  readonly detection_id: string;
  readonly entity_type: ResolvedPrivacyDetection["entity_type"];
  readonly surface: ResolvedPrivacyDetection["surface"];
  readonly raw_value: string;
  readonly normalized_key: string | null;
  readonly state: DetectionDecisionState;
}

export interface LocalReviewDTO {
  readonly audit_id: string;
  readonly stage: ReviewStage;
  readonly detections: readonly LocalReviewDetectionDTO[];
}

export interface SafeReviewDiagnosticDTO {
  readonly stage: ReviewStage;
  readonly entity_type_counts: Readonly<Record<string, number>>;
  readonly placeholder_count_by_type: Readonly<Record<string, number>>;
  readonly merge_count: number;
  readonly split_count: number;
  readonly false_positive_count: number;
  readonly duration_ms: number;
  readonly safe_error_category: string | null;
}
