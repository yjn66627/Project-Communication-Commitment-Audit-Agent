import { createHash } from "node:crypto";

import { compareUnicodeCodePoints, stableCanonicalSerialize } from "../../shared/ids/stable-serialization.js";
import type { RevisionMappingSnapshot } from "../../shared/ids/types.js";
import type { LocalPrivacyMappingDraft, PseudonymMappingPlan } from "../pseudonymization/types.js";
import type {
  CandidateFingerprintComponents,
  CandidateFreshnessContext,
  CandidateSemanticStateInput,
  FinalizedReviewCandidate,
} from "./types.js";

function hashStable(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(stableCanonicalSerialize(value), "utf8")
    .digest("hex");
}

function sortedRawRecords(input: CandidateSemanticStateInput) {
  return [...input.raw_records]
    .sort((a, b) => a.sequence - b.sequence || compareUnicodeCodePoints(a.record_id, b.record_id))
    .map((record) => ({
      record_id: record.record_id,
      source_type: record.source_type,
      source_name: record.source_name,
      author: record.author,
      timestamp: record.timestamp,
      content: record.content,
      sequence: record.sequence,
      metadata_present: Object.prototype.hasOwnProperty.call(record, "metadata"),
      metadata: record.metadata ?? null,
    }));
}

function mappingPlanProjection(plan: PseudonymMappingPlan) {
  const mappings = [...plan.mappings]
    .sort((a, b) =>
      compareUnicodeCodePoints(a.entity_type, b.entity_type) ||
      compareUnicodeCodePoints(a.placeholder, b.placeholder) ||
      compareUnicodeCodePoints(a.semantic_entity_id, b.semantic_entity_id),
    )
    .map((mapping) => ({
      semantic_entity_id: mapping.semantic_entity_id,
      entity_type: mapping.entity_type,
      placeholder: mapping.placeholder,
      original_value: mapping.original_value,
      normalized_key: mapping.normalized_key,
      aliases: [...mapping.aliases].sort(compareUnicodeCodePoints),
      active: mapping.active,
      provenance: mapping.provenance,
      seed_revision_id: mapping.seed_revision_id,
    }));
  const entities = [...plan.semantic_entities]
    .sort((a, b) => compareUnicodeCodePoints(a.semantic_entity_id, b.semantic_entity_id))
    .map((entity) => ({
      semantic_entity_id: entity.semantic_entity_id,
      audit_id: entity.audit_id,
      entity_type: entity.entity_type,
      member_detection_ids: [...entity.member_detection_ids].sort(compareUnicodeCodePoints),
      state: entity.state,
      merged_into: entity.merged_into,
      placeholder: entity.placeholder,
      seed_placeholder: entity.seed_placeholder,
      seed_backed: entity.seed_backed,
    }));
  return {
    audit_id: plan.audit_id,
    mappings,
    entities,
    reserved_placeholders: [...plan.reserved_placeholders].sort(compareUnicodeCodePoints),
  };
}

export function buildCandidateFingerprintComponents(
  input: CandidateSemanticStateInput,
): CandidateFingerprintComponents {
  const rawRecords = sortedRawRecords(input);
  const recordIds = rawRecords.map((record) => record.record_id).sort(compareUnicodeCodePoints);
  const recordSequences = [...rawRecords]
    .sort((a, b) => compareUnicodeCodePoints(a.record_id, b.record_id))
    .map((record) => [record.record_id, record.sequence] as const);
  const detections = [...input.resolved_detections]
    .sort((a, b) => compareUnicodeCodePoints(a.detection_id, b.detection_id));
  const decisions = [...input.review_decisions]
    .sort((a, b) => compareUnicodeCodePoints(a.detection_id, b.detection_id));
  const preview = [...input.sanitized_preview_records]
    .sort((a, b) => a.sequence - b.sequence || compareUnicodeCodePoints(a.record_id, b.record_id));

  return Object.freeze({
    record_set_fingerprint: hashStable("review-record-set-v1", recordIds),
    record_sequence_fingerprint: hashStable("review-record-sequence-v1", recordSequences),
    raw_input_fingerprint: hashStable("review-raw-input-v1", rawRecords),
    resolved_detection_fingerprint: hashStable("review-resolved-detection-v1", detections),
    review_decision_fingerprint: hashStable("review-decision-v1", decisions),
    mapping_plan_fingerprint: hashStable("review-mapping-plan-v1", mappingPlanProjection(input.mapping_plan)),
    sanitized_preview_fingerprint: hashStable("review-sanitized-preview-v1", preview),
  });
}

export function createCandidateFreshnessContext(
  input: CandidateSemanticStateInput,
): CandidateFreshnessContext {
  return Object.freeze({ audit_id: input.audit_id, ...buildCandidateFingerprintComponents(input) });
}

export function finalizeReviewCandidate(input: CandidateSemanticStateInput & Readonly<{
  revision_mapping_snapshot: readonly RevisionMappingSnapshot[];
  local_mapping_vault: readonly LocalPrivacyMappingDraft[];
}>): FinalizedReviewCandidate {
  const components = buildCandidateFingerprintComponents(input);
  const reviewCandidateId = `rcand_${hashStable("review-candidate-v1", {
    audit_id: input.audit_id,
    ...components,
  })}`;
  return Object.freeze({
    audit_id: input.audit_id,
    review_candidate_id: reviewCandidateId,
    ...components,
    sanitized_preview_records: Object.freeze([...input.sanitized_preview_records]),
    revision_mapping_snapshot: Object.freeze([...input.revision_mapping_snapshot]),
    local_mapping_vault: Object.freeze([...input.local_mapping_vault]),
    mapping_plan: input.mapping_plan,
  });
}
