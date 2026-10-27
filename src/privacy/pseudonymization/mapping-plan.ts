import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";

import { allocateEntityPlaceholders, compareMembers } from "./placeholder-allocator.js";
import { seedToInactiveDraft } from "./seed-mappings.js";
import type {
  LocalPrivacyMappingDraft,
  PseudonymMappingPlan,
  ReviewMember,
  ReviewSemanticEntity,
} from "./types.js";
import type { ReviewSession } from "../review/types.js";

function acceptedMemberIds(session: ReviewSession, entity: ReviewSemanticEntity): string[] {
  return entity.member_detection_ids.filter((id) => {
    const decision = session.decisions[id];
    return decision?.state === "ACCEPTED";
  });
}

function buildActiveDraft(
  session: ReviewSession,
  entity: ReviewSemanticEntity,
  placeholder: string,
): LocalPrivacyMappingDraft | null {
  const acceptedIds = acceptedMemberIds(session, entity);
  if (acceptedIds.length === 0) return null;
  const members = acceptedIds.map((id) => session.members[id]).filter((value): value is ReviewMember => Boolean(value)).sort(compareMembers);
  if (members.length === 0) return null;

  const reusedSeed = entity.seed_placeholder
    ? session.seed_mappings.find((seed) => seed.entity_type === entity.entity_type && seed.placeholder === entity.seed_placeholder)
    : undefined;

  if (reusedSeed && placeholder === reusedSeed.placeholder) {
    const aliases = [...new Set([...reusedSeed.aliases, ...members.map((member) => member.raw_value).filter((value) => value !== reusedSeed.original_value)])].sort(compareUnicodeCodePoints);
    return Object.freeze({
      local_high_sensitivity: true,
      semantic_entity_id: entity.semantic_entity_id,
      entity_type: entity.entity_type,
      placeholder,
      original_value: reusedSeed.original_value,
      normalized_key: reusedSeed.normalized_key,
      aliases: Object.freeze(aliases),
      active: true,
      provenance: "SEED",
      seed_revision_id: reusedSeed.seed_revision_id ?? null,
    });
  }

  const first = members[0]!;
  const normalized = first.normalized_key ?? first.raw_value.normalize("NFKC").trim();
  const aliases = [...new Set(members.slice(1).map((member) => member.raw_value).filter((value) => value !== first.raw_value))].sort(compareUnicodeCodePoints);
  return Object.freeze({
    local_high_sensitivity: true,
    semantic_entity_id: entity.semantic_entity_id,
    entity_type: entity.entity_type,
    placeholder,
    original_value: first.raw_value,
    normalized_key: normalized,
    aliases: Object.freeze(aliases),
    active: true,
    provenance: "CURRENT",
    seed_revision_id: null,
  });
}

export function buildMappingPlan(session: ReviewSession): PseudonymMappingPlan {
  if (session.stage !== "REVIEW_COMPLETE") throw new TypeError("Review candidate is not finalized.");
  const entities = Object.values(session.entities).filter((entity) => entity.state !== "MERGED_INTO");
  const membersById = new Map(Object.values(session.members).map((member) => [member.detection_id, member]));
  const allocated = allocateEntityPlaceholders({
    entities,
    membersById,
    seeds: session.seed_mappings,
    retired: session.retired_mappings,
  });

  const activeDrafts: LocalPrivacyMappingDraft[] = [];
  const activeKeys = new Set<string>();
  for (const entity of entities) {
    const placeholder = allocated.get(entity.semantic_entity_id);
    if (!placeholder) continue;
    const draft = buildActiveDraft(session, entity, placeholder);
    if (!draft) continue;
    activeDrafts.push(draft);
    activeKeys.add(`${draft.entity_type}\0${draft.placeholder}`);
  }

  const inactiveSeeds = session.seed_mappings
    .filter((seed) => !activeKeys.has(`${seed.entity_type}\0${seed.placeholder}`))
    .map(seedToInactiveDraft);
  const retired = session.retired_mappings.filter((mapping) => !activeKeys.has(`${mapping.entity_type}\0${mapping.placeholder}`));

  const all = [...inactiveSeeds, ...retired, ...activeDrafts];
  const deduped = new Map<string, LocalPrivacyMappingDraft>();
  for (const mapping of all) {
    const key = `${mapping.entity_type}\0${mapping.placeholder}`;
    const previous = deduped.get(key);
    if (!previous || mapping.active || (!previous.active && mapping.provenance === "RETIRED")) deduped.set(key, mapping);
  }
  const mappings = [...deduped.values()].sort((a, b) => compareUnicodeCodePoints(a.entity_type, b.entity_type) || compareUnicodeCodePoints(a.placeholder, b.placeholder));
  return Object.freeze({
    audit_id: session.audit_id,
    mappings: Object.freeze(mappings),
    semantic_entities: Object.freeze(entities.map((entity) => Object.freeze({ ...entity, placeholder: allocated.get(entity.semantic_entity_id) ?? entity.placeholder }))),
    reserved_placeholders: Object.freeze(mappings.map((mapping) => mapping.placeholder).sort(compareUnicodeCodePoints)),
  });
}
