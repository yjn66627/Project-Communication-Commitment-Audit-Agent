import type { CanonicalRecordDraft } from "../../domain/schemas/canonical.js";
import type { ResolvedPrivacyDetection, SourceNamePolicyResult } from "../detection/types.js";
import { createSemanticEntityId } from "../pseudonymization/semantic-identity.js";
import { normalizeSeedMappings } from "../pseudonymization/seed-mappings.js";
import { DEFAULT_REPLACEMENT_POLICY, type ReviewMember, type ReviewSemanticEntity, type SeedPrivacyMapping } from "../pseudonymization/types.js";
import type { DetectionDecision, ReviewSession } from "./types.js";

function rawSurface(record: CanonicalRecordDraft, detection: ResolvedPrivacyDetection): string {
  if (detection.surface === "CONTENT") return record.content;
  if (detection.surface === "AUTHOR") return record.author ?? "";
  return record.source_name;
}

export function createDetectedReviewSession(input: Readonly<{
  auditId: string;
  records: readonly CanonicalRecordDraft[];
  detections: readonly ResolvedPrivacyDetection[];
  sourceNamePolicies?: Readonly<Record<string, SourceNamePolicyResult>>;
  seedMappings?: readonly SeedPrivacyMapping[];
}>): ReviewSession {
  const records: Record<string, CanonicalRecordDraft> = {};
  for (const record of input.records) {
    if (records[record.record_id]) throw new TypeError("Duplicate review record identity.");
    records[record.record_id] = record;
  }
  const detections: Record<string, ResolvedPrivacyDetection> = {};
  const members: Record<string, ReviewMember> = {};
  const decisions: Record<string, DetectionDecision> = {};
  const entities: Record<string, ReviewSemanticEntity> = {};

  for (const detection of input.detections) {
    const record = records[detection.record_id];
    if (!record) throw new TypeError("Review detection references an unknown record.");
    if (detections[detection.detection_id]) throw new TypeError("Duplicate detection identity.");
    detections[detection.detection_id] = detection;
    const raw = rawSurface(record, detection);
    if (detection.effective_start < 0 || detection.effective_end > raw.length || detection.effective_end <= detection.effective_start) {
      throw new RangeError("Resolved detection envelope is invalid for raw surface.");
    }
    const member: ReviewMember = Object.freeze({
      detection_id: detection.detection_id,
      record_id: detection.record_id,
      record_sequence: record.sequence,
      surface: detection.surface,
      effective_start: detection.effective_start,
      effective_end: detection.effective_end,
      entity_type: detection.entity_type,
      normalized_key: detection.normalized_key,
      raw_value: raw.slice(detection.effective_start, detection.effective_end),
    });
    members[detection.detection_id] = member;

    if (detection.entity_type === "SECRET") {
      decisions[detection.detection_id] = Object.freeze({
        detection_id: detection.detection_id,
        semantic_entity_id: null,
        state: "LOCKED_REDACTION",
        replacement_policy: "LOCKED_REDACTION",
        url_visibility: null,
        does_not_disable_future_egress_secret_scan: true,
      });
      continue;
    }

    const semanticId = createSemanticEntityId({
      auditId: input.auditId,
      entityType: detection.entity_type,
      detectionIds: [detection.detection_id],
    });
    entities[semanticId] = Object.freeze({
      semantic_entity_id: semanticId,
      audit_id: input.auditId,
      entity_type: detection.entity_type,
      member_detection_ids: Object.freeze([detection.detection_id]),
      state: "ACTIVE",
      merged_into: null,
      placeholder: null,
      seed_placeholder: null,
      seed_backed: false,
    });
    decisions[detection.detection_id] = Object.freeze({
      detection_id: detection.detection_id,
      semantic_entity_id: semanticId,
      state: "PENDING_REVIEW",
      replacement_policy: DEFAULT_REPLACEMENT_POLICY[detection.entity_type],
      url_visibility: detection.entity_type === "URL" ? "HIDDEN" : null,
      does_not_disable_future_egress_secret_scan: false,
    });
  }

  return Object.freeze({
    audit_id: input.auditId,
    stage: "DETECTED",
    records: Object.freeze(records),
    detections: Object.freeze(detections),
    members: Object.freeze(members),
    decisions: Object.freeze(decisions),
    entities: Object.freeze(entities),
    source_name_policies: Object.freeze({ ...(input.sourceNamePolicies ?? {}) }),
    seed_mappings: normalizeSeedMappings(input.auditId, input.seedMappings ?? []),
    retired_mappings: Object.freeze([]),
    counters: Object.freeze({ merge_count: 0, split_count: 0, false_positive_count: 0 }),
  });
}

export function beginReview(session: ReviewSession): ReviewSession {
  if (session.stage !== "DETECTED") return session;
  return Object.freeze({ ...session, stage: "REVIEW_REQUIRED" });
}

export function createReviewSession(input: Parameters<typeof createDetectedReviewSession>[0]): ReviewSession {
  return beginReview(createDetectedReviewSession(input));
}
