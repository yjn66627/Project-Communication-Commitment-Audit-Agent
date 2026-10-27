import { compareEntitiesForAllocation } from "../pseudonymization/placeholder-allocator.js";
import { createSemanticEntityId } from "../pseudonymization/semantic-identity.js";
import type { ReviewMember, ReviewSemanticEntity } from "../pseudonymization/types.js";
import { ReviewRuntimeError, type ReviewSession } from "./types.js";

function membersMap(session: ReviewSession): ReadonlyMap<string, ReviewMember> {
  return new Map(Object.values(session.members).map((member) => [member.detection_id, member]));
}

export function chooseMergeSurvivor(
  session: ReviewSession,
  entities: readonly ReviewSemanticEntity[],
  explicitPlaceholder?: string,
): ReviewSemanticEntity {
  if (entities.length < 2) throw new ReviewRuntimeError("REVIEW_MERGE_INVALID", "Merge requires at least two entities.");
  const entityType = entities[0]!.entity_type;
  if (entities.some((entity) => entity.audit_id !== session.audit_id || entity.entity_type !== entityType || entity.state === "MERGED_INTO")) {
    throw new ReviewRuntimeError("REVIEW_MERGE_INVALID", "Merge entities must share one audit and entity type.");
  }
  const historical = [...new Set(entities.map((entity) => entity.seed_placeholder).filter((value): value is string => Boolean(value)))];
  if (historical.length > 1) {
    if (!explicitPlaceholder) throw new ReviewRuntimeError("REVIEW_MERGE_SURVIVOR_REQUIRED", "Historical placeholder conflict requires an explicit survivor.");
    const survivor = entities.find((entity) => entity.seed_placeholder === explicitPlaceholder);
    if (!survivor) throw new ReviewRuntimeError("REVIEW_MERGE_INVALID", "Explicit merge survivor is not a valid historical placeholder.");
    return survivor;
  }
  if (historical.length === 1) return entities.find((entity) => entity.seed_placeholder === historical[0])!;
  return [...entities].sort((a, b) => compareEntitiesForAllocation(a, b, membersMap(session)))[0]!;
}

export function validateSplitPartitions(entity: ReviewSemanticEntity, partitions: readonly (readonly string[])[], retainedIndex: number): void {
  if (partitions.length < 2 || !Number.isInteger(retainedIndex) || retainedIndex < 0 || retainedIndex >= partitions.length) {
    throw new ReviewRuntimeError("REVIEW_SPLIT_INVALID", "Split requires multiple partitions and a valid retained partition.");
  }
  if (partitions.some((partition) => partition.length === 0)) throw new ReviewRuntimeError("REVIEW_SPLIT_INVALID", "Split partitions must be non-empty.");
  const flattened = partitions.flat();
  const expected = [...entity.member_detection_ids].sort();
  const actual = [...flattened].sort();
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]) || new Set(flattened).size !== flattened.length) {
    throw new ReviewRuntimeError("REVIEW_SPLIT_INVALID", "Split partitions must cover entity members exactly once.");
  }
}

export function createSplitEntityId(session: ReviewSession, entity: ReviewSemanticEntity, partition: readonly string[]): string {
  return createSemanticEntityId({ auditId: session.audit_id, entityType: entity.entity_type, detectionIds: partition });
}
