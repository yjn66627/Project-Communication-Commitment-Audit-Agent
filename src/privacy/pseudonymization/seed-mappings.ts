import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";

import { createSeedSemanticEntityId } from "./semantic-identity.js";
import type { LocalPrivacyMappingDraft, SeedPrivacyMapping } from "./types.js";

export function normalizeSeedMappings(auditId: string, seeds: readonly SeedPrivacyMapping[]): readonly SeedPrivacyMapping[] {
  const seen = new Set<string>();
  const normalized = seeds.map((seed) => {
    if (seed.audit_id !== auditId) throw new TypeError("Seed mapping belongs to a different audit.");
    if (seed.entity_type === ("SECRET" as never)) throw new TypeError("SECRET cannot be a seed mapping.");
    const key = `${seed.entity_type}\0${seed.placeholder}`;
    if (seen.has(key)) throw new TypeError("Duplicate seed placeholder identity.");
    seen.add(key);
    return Object.freeze({
      ...seed,
      aliases: Object.freeze([...new Set(seed.aliases)].sort(compareUnicodeCodePoints)),
    });
  });
  return Object.freeze(normalized.sort((a, b) => compareUnicodeCodePoints(a.entity_type, b.entity_type) || compareUnicodeCodePoints(a.placeholder, b.placeholder)));
}

export function seedToInactiveDraft(seed: SeedPrivacyMapping): LocalPrivacyMappingDraft {
  return Object.freeze({
    local_high_sensitivity: true,
    semantic_entity_id: createSeedSemanticEntityId({
      auditId: seed.audit_id,
      entityType: seed.entity_type,
      placeholder: seed.placeholder,
      seedRevisionId: seed.seed_revision_id,
    }),
    entity_type: seed.entity_type,
    placeholder: seed.placeholder,
    original_value: seed.original_value,
    normalized_key: seed.normalized_key,
    aliases: Object.freeze([...seed.aliases]),
    active: false,
    provenance: "SEED",
    seed_revision_id: seed.seed_revision_id ?? null,
  });
}

export function findSeedByPlaceholder(
  seeds: readonly SeedPrivacyMapping[],
  entityType: SeedPrivacyMapping["entity_type"],
  placeholder: string,
): SeedPrivacyMapping | undefined {
  return seeds.find((seed) => seed.entity_type === entityType && seed.placeholder === placeholder);
}
