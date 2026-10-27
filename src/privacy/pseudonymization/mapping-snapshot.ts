import { compareUnicodeCodePoints, stableCanonicalSerialize } from "../../shared/ids/stable-serialization.js";
import type { RevisionMappingSnapshot } from "../../shared/ids/types.js";

import type { PseudonymMappingPlan } from "./types.js";

export function buildRevisionMappingSnapshot(plan: PseudonymMappingPlan): readonly RevisionMappingSnapshot[] {
  const snapshot = plan.mappings.map((mapping) => Object.freeze({
    entity_type: mapping.entity_type,
    placeholder: mapping.placeholder,
    normalized_original_value: mapping.normalized_key,
    aliases: Object.freeze([...new Set(mapping.aliases)].sort(compareUnicodeCodePoints)),
    active: mapping.active,
  } satisfies RevisionMappingSnapshot));
  snapshot.sort((a, b) => compareUnicodeCodePoints(a.entity_type, b.entity_type) || compareUnicodeCodePoints(a.placeholder, b.placeholder));
  return Object.freeze(snapshot);
}

export function serializeRevisionMappingSnapshot(snapshot: readonly RevisionMappingSnapshot[]): string {
  const tuples = snapshot.map((mapping) => [
    mapping.entity_type,
    mapping.placeholder,
    mapping.normalized_original_value,
    [...mapping.aliases],
    mapping.active,
  ]);
  return stableCanonicalSerialize(tuples);
}
