import type {
  CandidateFreshnessContext,
  CandidateFreshnessResult,
  FinalizedReviewCandidate,
} from "./types.js";

export function validateCandidateFreshness(
  candidate: FinalizedReviewCandidate,
  currentContext: CandidateFreshnessContext | null | undefined,
): CandidateFreshnessResult {
  if (!currentContext) return Object.freeze({ status: "STALE", reason: "CANDIDATE_STATE_UNAVAILABLE" });
  if (currentContext.audit_id !== candidate.audit_id) return Object.freeze({ status: "STALE", reason: "AUDIT_MISMATCH" });
  if (currentContext.record_set_fingerprint !== candidate.record_set_fingerprint) return Object.freeze({ status: "STALE", reason: "RECORD_SET_CHANGED" });
  if (currentContext.record_sequence_fingerprint !== candidate.record_sequence_fingerprint) return Object.freeze({ status: "STALE", reason: "RECORD_SEQUENCE_CHANGED" });
  if (currentContext.raw_input_fingerprint !== candidate.raw_input_fingerprint) return Object.freeze({ status: "STALE", reason: "RAW_INPUT_CHANGED" });
  if (currentContext.resolved_detection_fingerprint !== candidate.resolved_detection_fingerprint) return Object.freeze({ status: "STALE", reason: "DETECTION_CHANGED" });
  if (currentContext.review_decision_fingerprint !== candidate.review_decision_fingerprint) return Object.freeze({ status: "STALE", reason: "REVIEW_DECISION_CHANGED" });
  if (currentContext.mapping_plan_fingerprint !== candidate.mapping_plan_fingerprint) return Object.freeze({ status: "STALE", reason: "MAPPING_PLAN_CHANGED" });
  if (currentContext.sanitized_preview_fingerprint !== candidate.sanitized_preview_fingerprint) return Object.freeze({ status: "STALE", reason: "PREVIEW_CHANGED" });
  return Object.freeze({ status: "FRESH" });
}
