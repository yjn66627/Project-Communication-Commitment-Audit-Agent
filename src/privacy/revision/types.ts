import type { CanonicalRecordDraft, SanitizedCanonicalRecordRevision } from "../../domain/schemas/canonical.js";
import type { PrivacyMapping } from "../../domain/schemas/privacy.js";
import type { ResolvedPrivacyDetection } from "../detection/types.js";
import type { SanitizedPreviewRecordCandidate } from "../preview/types.js";
import type { LocalPrivacyMappingDraft, PseudonymMappingPlan } from "../pseudonymization/types.js";
import type { DetectionDecision } from "../review/types.js";
import type { RevisionMappingSnapshot } from "../../shared/ids/types.js";
import type {
  ConfirmedPrivacyAggregateInput,
  LocalConfirmedPrivacyAggregate,
  SafeConfirmedPrivacyAggregate,
} from "../../db/repositories/privacy-repository.js";
import type { RepositoryWriteResult } from "../../db/repositories/repository-utils.js";

export const REVIEW_CANDIDATE_FINGERPRINT_VERSION = "review-candidate-v1" as const;
export const UNCONFIRMED_CANDIDATE_RESTART_RECOVERY = "NOT_GUARANTEED" as const;
export const CROSS_PROCESS_LOCK_GUARANTEE = false as const;
export const AUTOMATIC_CONFIRMATION_RETRY = "NONE" as const;

export interface CandidateFingerprintComponents {
  readonly record_set_fingerprint: string;
  readonly record_sequence_fingerprint: string;
  readonly raw_input_fingerprint: string;
  readonly resolved_detection_fingerprint: string;
  readonly review_decision_fingerprint: string;
  readonly mapping_plan_fingerprint: string;
  readonly sanitized_preview_fingerprint: string;
}

export interface CandidateSemanticStateInput {
  readonly audit_id: string;
  readonly raw_records: readonly CanonicalRecordDraft[];
  readonly resolved_detections: readonly ResolvedPrivacyDetection[];
  readonly review_decisions: readonly DetectionDecision[];
  readonly mapping_plan: PseudonymMappingPlan;
  readonly sanitized_preview_records: readonly SanitizedPreviewRecordCandidate[];
}

/** Runtime-only. This is not a Domain object and is never a database identity. */
export interface FinalizedReviewCandidate extends CandidateFingerprintComponents {
  readonly audit_id: string;
  readonly review_candidate_id: string;
  readonly sanitized_preview_records: readonly SanitizedPreviewRecordCandidate[];
  readonly revision_mapping_snapshot: readonly RevisionMappingSnapshot[];
  readonly local_mapping_vault: readonly LocalPrivacyMappingDraft[];
  readonly mapping_plan: PseudonymMappingPlan;
}

export interface CandidateFreshnessContext extends CandidateFingerprintComponents {
  readonly audit_id: string;
}

export type SafeInvalidationReason =
  | "AUDIT_MISMATCH"
  | "RAW_INPUT_CHANGED"
  | "RECORD_SET_CHANGED"
  | "RECORD_SEQUENCE_CHANGED"
  | "DETECTION_CHANGED"
  | "REVIEW_DECISION_CHANGED"
  | "MAPPING_PLAN_CHANGED"
  | "PREVIEW_CHANGED"
  | "CANDIDATE_STATE_UNAVAILABLE";

export type CandidateFreshnessResult =
  | Readonly<{ status: "FRESH" }>
  | Readonly<{ status: "STALE"; reason: SafeInvalidationReason }>;

export interface ConfirmedPrivacyAggregateDraft {
  readonly audit_id: string;
  readonly privacy_revision_id: `prv_${string}`;
  readonly records: readonly SanitizedCanonicalRecordRevision[];
  readonly mappings: readonly PrivacyMapping[];
  readonly record_count: number;
  readonly mapping_count: number;
}

export interface SafeConfirmationResult {
  readonly audit_id: string;
  readonly privacy_revision_id: string;
  readonly record_count: number;
  readonly mapping_count: number;
  readonly confirmed_at: string;
  readonly idempotent: boolean;
}

export interface LatestConfirmedRevisionMetadata {
  readonly audit_id: string;
  readonly privacy_revision_id: string;
  readonly confirmed_at: string | null;
}

export type MaybePromise<T> = T | Promise<T>;

/** Structural subset of the frozen DEV-03 PrivacyRepository. */
export interface ConfirmationRepositoryPort {
  getConfirmedPrivacyAggregateLocal(
    privacyRevisionId: string,
  ): MaybePromise<LocalConfirmedPrivacyAggregate>;
  saveConfirmedPrivacyAggregate(
    input: ConfirmedPrivacyAggregateInput,
  ): MaybePromise<RepositoryWriteResult<SafeConfirmedPrivacyAggregate>>;
}

export type ConfirmationClock = () => string;
export type CandidateContextProvider = () => MaybePromise<CandidateFreshnessContext | null>;
