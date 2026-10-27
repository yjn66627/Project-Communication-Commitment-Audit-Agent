import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";
import type { PrivacyDetectionSurface } from "../detection/types.js";
import type {
  EntityAllocationAnchor,
  LocalPrivacyMappingDraft,
  MappablePrivacyEntityType,
  ReviewMember,
  ReviewSemanticEntity,
  SeedPrivacyMapping,
} from "./types.js";

const SURFACE_RANK: Readonly<Record<PrivacyDetectionSurface, number>> = Object.freeze({ CONTENT: 1, AUTHOR: 2, SOURCE_NAME: 3 });
const PLACEHOLDER_RE = /^(PERSON|ORG|PROJECT|PHONE|EMAIL|ID_CARD|IP|URL)_(\d+)$/u;

export function parsePlaceholder(placeholder: string): { entityType: MappablePrivacyEntityType; ordinal: number } | null {
  const match = PLACEHOLDER_RE.exec(placeholder);
  if (!match) return null;
  const ordinal = Number(match[2]);
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) return null;
  return { entityType: match[1] as MappablePrivacyEntityType, ordinal };
}

export function assertPlaceholderForType(entityType: MappablePrivacyEntityType, placeholder: string): void {
  const parsed = parsePlaceholder(placeholder);
  if (!parsed || parsed.entityType !== entityType) throw new TypeError("Placeholder is invalid for entity type.");
}

export function formatPlaceholder(entityType: MappablePrivacyEntityType, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) throw new RangeError("Placeholder ordinal must be positive.");
  return `${entityType}_${String(ordinal).padStart(3, "0")}`;
}

export function allocationAnchor(entity: ReviewSemanticEntity, membersById: ReadonlyMap<string, ReviewMember>): EntityAllocationAnchor {
  const members = entity.member_detection_ids.map((id) => membersById.get(id)).filter((value): value is ReviewMember => Boolean(value));
  if (members.length === 0) throw new TypeError("Semantic entity has no allocation member.");
  const first = [...members].sort(compareMembers)[0]!;
  return {
    record_sequence: first.record_sequence,
    record_id: first.record_id,
    surface: first.surface,
    effective_start: first.effective_start,
    effective_end: first.effective_end,
    entity_type: entity.entity_type,
    normalized_key: first.normalized_key,
    semantic_entity_id: entity.semantic_entity_id,
  };
}

export function compareMembers(a: ReviewMember, b: ReviewMember): number {
  return a.record_sequence - b.record_sequence
    || compareUnicodeCodePoints(a.record_id, b.record_id)
    || SURFACE_RANK[a.surface] - SURFACE_RANK[b.surface]
    || a.effective_start - b.effective_start
    || a.effective_end - b.effective_end
    || compareUnicodeCodePoints(a.entity_type, b.entity_type)
    || compareNullableText(a.normalized_key, b.normalized_key)
    || compareUnicodeCodePoints(a.detection_id, b.detection_id);
}

export function compareEntitiesForAllocation(
  a: ReviewSemanticEntity,
  b: ReviewSemanticEntity,
  membersById: ReadonlyMap<string, ReviewMember>,
): number {
  const aa = allocationAnchor(a, membersById);
  const bb = allocationAnchor(b, membersById);
  return aa.record_sequence - bb.record_sequence
    || compareUnicodeCodePoints(aa.record_id, bb.record_id)
    || SURFACE_RANK[aa.surface] - SURFACE_RANK[bb.surface]
    || aa.effective_start - bb.effective_start
    || aa.effective_end - bb.effective_end
    || compareUnicodeCodePoints(aa.entity_type, bb.entity_type)
    || compareNullableText(aa.normalized_key, bb.normalized_key)
    || compareUnicodeCodePoints(aa.semantic_entity_id, bb.semantic_entity_id);
}

function compareNullableText(a: string | null, b: string | null): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compareUnicodeCodePoints(a, b);
}

export function collectReservedPlaceholders(
  seeds: readonly SeedPrivacyMapping[],
  retired: readonly LocalPrivacyMappingDraft[],
  entities: readonly ReviewSemanticEntity[],
): Set<string> {
  const reserved = new Set<string>();
  for (const seed of seeds) reserved.add(seed.placeholder);
  for (const mapping of retired) reserved.add(mapping.placeholder);
  for (const entity of entities) if (entity.placeholder) reserved.add(entity.placeholder);
  return reserved;
}

export function allocateEntityPlaceholders(input: Readonly<{
  entities: readonly ReviewSemanticEntity[];
  membersById: ReadonlyMap<string, ReviewMember>;
  seeds: readonly SeedPrivacyMapping[];
  retired: readonly LocalPrivacyMappingDraft[];
}>): ReadonlyMap<string, string> {
  const activeEntities = input.entities.filter((entity) => entity.state !== "MERGED_INTO");
  const reserved = collectReservedPlaceholders(input.seeds, input.retired, activeEntities);
  const result = new Map<string, string>();
  for (const entity of activeEntities) if (entity.placeholder) result.set(entity.semantic_entity_id, entity.placeholder);

  const unassigned = activeEntities.filter((entity) => !entity.placeholder).sort((a, b) => compareEntitiesForAllocation(a, b, input.membersById));
  for (const entity of unassigned) {
    let ordinal = 1;
    let candidate = formatPlaceholder(entity.entity_type, ordinal);
    while (reserved.has(candidate)) {
      ordinal += 1;
      candidate = formatPlaceholder(entity.entity_type, ordinal);
    }
    reserved.add(candidate);
    result.set(entity.semantic_entity_id, candidate);
  }
  return result;
}
