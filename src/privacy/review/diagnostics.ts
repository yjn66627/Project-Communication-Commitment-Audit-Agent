import type { PseudonymMappingPlan } from "../pseudonymization/types.js";
import type { LocalReviewDTO, ReviewSession, SafeReviewDiagnosticDTO } from "./types.js";

export function buildLocalReviewDTO(session: ReviewSession): LocalReviewDTO {
  return Object.freeze({
    audit_id: session.audit_id,
    stage: session.stage,
    detections: Object.freeze(Object.values(session.members).map((member) => Object.freeze({
      detection_id: member.detection_id,
      entity_type: member.entity_type,
      surface: member.surface,
      raw_value: member.raw_value,
      normalized_key: member.normalized_key,
      state: session.decisions[member.detection_id]!.state,
    }))),
  });
}

export function buildSafeReviewDiagnosticDTO(input: Readonly<{
  session: ReviewSession;
  mappingPlan?: PseudonymMappingPlan;
  durationMs?: number;
  safeErrorCategory?: string | null;
}>): SafeReviewDiagnosticDTO {
  const entityCounts: Record<string, number> = {};
  for (const detection of Object.values(input.session.detections)) entityCounts[detection.entity_type] = (entityCounts[detection.entity_type] ?? 0) + 1;
  const placeholderCounts: Record<string, number> = {};
  for (const mapping of input.mappingPlan?.mappings ?? []) if (mapping.active) placeholderCounts[mapping.entity_type] = (placeholderCounts[mapping.entity_type] ?? 0) + 1;
  return Object.freeze({
    stage: input.session.stage,
    entity_type_counts: Object.freeze(entityCounts),
    placeholder_count_by_type: Object.freeze(placeholderCounts),
    merge_count: input.session.counters.merge_count,
    split_count: input.session.counters.split_count,
    false_positive_count: input.session.counters.false_positive_count,
    duration_ms: Math.max(0, input.durationMs ?? 0),
    safe_error_category: input.safeErrorCategory ?? null,
  });
}
