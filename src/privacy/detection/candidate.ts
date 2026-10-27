import { createHash } from "node:crypto";

import {
  PRIVACY_DETECTOR_RULESET_VERSION,
  type PrivacyDetectionCandidate,
  type PrivacyDetectionConfidence,
  type PrivacyDetectionReviewState,
  type PrivacyDetectionSource,
  type PrivacyDetectionSurface,
  type PrivacyEntityType,
  type PrivacyReplacementPolicy,
  type SecretFamily,
} from "./types.js";

export const ENTITY_PRIORITY: Readonly<Record<PrivacyEntityType, number>> = Object.freeze({
  SECRET: 1000,
  ID_CARD: 900,
  URL: 800,
  EMAIL: 750,
  PHONE: 700,
  IP: 650,
  PERSON: 500,
  ORG: 500,
  PROJECT: 500,
});

const DEFAULT_POLICY: Readonly<Record<PrivacyEntityType, PrivacyReplacementPolicy>> = Object.freeze({
  SECRET: "LOCKED_REDACTION",
  ID_CARD: "REDACT",
  URL: "REDACT",
  EMAIL: "PSEUDONYMIZE",
  PHONE: "PSEUDONYMIZE",
  IP: "PSEUDONYMIZE",
  PERSON: "PSEUDONYMIZE",
  ORG: "PSEUDONYMIZE",
  PROJECT: "PSEUDONYMIZE",
});

function createDetectionId(input: Readonly<{
  recordId: string;
  surface: PrivacyDetectionSurface;
  start: number;
  end: number;
  entityType: PrivacyEntityType;
  detectorId: string;
  secretFamily?: SecretFamily;
}>): string {
  const hash = createHash("sha256");
  for (const part of [
    PRIVACY_DETECTOR_RULESET_VERSION,
    input.recordId,
    input.surface,
    String(input.start),
    String(input.end),
    input.entityType,
    input.detectorId,
    input.secretFamily ?? "",
  ]) {
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return `pdet_${hash.digest("hex").slice(0, 32)}`;
}

export function makeCandidate(input: Readonly<{
  recordId: string;
  surface: PrivacyDetectionSurface;
  start: number;
  end: number;
  entityType: PrivacyEntityType;
  normalizedKey: string | null;
  detectorId: string;
  detectionSource?: PrivacyDetectionSource;
  confidence: PrivacyDetectionConfidence;
  reviewState?: PrivacyDetectionReviewState;
  replacementPolicy?: PrivacyReplacementPolicy;
  secretFamily?: SecretFamily;
}>): PrivacyDetectionCandidate {
  if (!Number.isInteger(input.start) || !Number.isInteger(input.end) || input.start < 0 || input.end <= input.start) {
    throw new RangeError("Privacy detection span is invalid.");
  }
  if (input.entityType === "SECRET" && input.normalizedKey !== null) {
    throw new TypeError("SECRET detections cannot expose normalized secret material.");
  }
  const policy = input.replacementPolicy ?? DEFAULT_POLICY[input.entityType];
  const reviewState = input.reviewState ?? (input.entityType === "SECRET" ? "LOCKED_REDACTION" : "UNREVIEWED");
  return Object.freeze({
    detection_id: createDetectionId({
      recordId: input.recordId,
      surface: input.surface,
      start: input.start,
      end: input.end,
      entityType: input.entityType,
      detectorId: input.detectorId,
      ...(input.secretFamily ? { secretFamily: input.secretFamily } : {}),
    }),
    record_id: input.recordId,
    surface: input.surface,
    char_start: input.start,
    char_end: input.end,
    entity_type: input.entityType,
    priority: ENTITY_PRIORITY[input.entityType],
    normalized_key: input.entityType === "SECRET" ? null : input.normalizedKey,
    detector_id: input.detectorId,
    detection_source: input.detectionSource ?? "DETERMINISTIC_RULE",
    confidence: input.confidence,
    review_state: reviewState,
    replacement_policy: policy,
    ruleset_version: PRIVACY_DETECTOR_RULESET_VERSION,
    ...(input.secretFamily ? { secret_family: input.secretFamily } : {}),
  });
}
