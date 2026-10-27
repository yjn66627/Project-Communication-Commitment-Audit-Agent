import { assertPlaceholderForType } from "../pseudonymization/placeholder-allocator.js";
import { createSeedSemanticEntityId } from "../pseudonymization/semantic-identity.js";
import { findSeedByPlaceholder } from "../pseudonymization/seed-mappings.js";
import type { LocalPrivacyMappingDraft, ReviewSemanticEntity } from "../pseudonymization/types.js";
import { createSplitEntityId, chooseMergeSurvivor, validateSplitPartitions } from "./merge-split.js";
import { ReviewRuntimeError, type DetectionDecision, type ReviewCommand, type ReviewSession } from "./types.js";

function cloneSession(session: ReviewSession): {
  decisions: Record<string, DetectionDecision>;
  entities: Record<string, ReviewSemanticEntity>;
  retired: LocalPrivacyMappingDraft[];
} {
  return {
    decisions: { ...session.decisions },
    entities: { ...session.entities },
    retired: [...session.retired_mappings],
  };
}

function requireDecision(session: ReviewSession, detectionId: string): DetectionDecision {
  const decision = session.decisions[detectionId];
  if (!decision) throw new ReviewRuntimeError("REVIEW_DETECTION_NOT_FOUND", "Review detection was not found.");
  return decision;
}

function requireEntity(session: ReviewSession, semanticEntityId: string): ReviewSemanticEntity {
  const entity = session.entities[semanticEntityId];
  if (!entity || entity.state === "MERGED_INTO") throw new ReviewRuntimeError("REVIEW_ENTITY_NOT_FOUND", "Review entity was not found.");
  return entity;
}

function safeRetiredMapping(session: ReviewSession, entity: ReviewSemanticEntity, placeholder: string): LocalPrivacyMappingDraft | null {
  const seed = session.seed_mappings.find((item) => item.entity_type === entity.entity_type && item.placeholder === placeholder);
  if (seed) return null;
  const member = entity.member_detection_ids.map((id) => session.members[id]).find(Boolean);
  if (!member) return null;
  return Object.freeze({
    local_high_sensitivity: true,
    semantic_entity_id: entity.semantic_entity_id,
    entity_type: entity.entity_type,
    placeholder,
    original_value: member.raw_value,
    normalized_key: member.normalized_key ?? member.raw_value.normalize("NFKC").trim(),
    aliases: Object.freeze([]),
    active: false,
    provenance: "RETIRED",
    seed_revision_id: null,
  });
}

function withChanges(
  session: ReviewSession,
  changes: ReturnType<typeof cloneSession>,
  extras?: Partial<Pick<ReviewSession, "stage" | "counters">>,
): ReviewSession {
  return Object.freeze({
    ...session,
    ...extras,
    decisions: Object.freeze(changes.decisions),
    entities: Object.freeze(changes.entities),
    retired_mappings: Object.freeze(changes.retired),
  });
}

function placeholderInUse(session: ReviewSession, placeholder: string, ownerId: string): boolean {
  if (session.seed_mappings.some((seed) => seed.placeholder === placeholder)) {
    const owner = session.entities[ownerId];
    if (!owner || owner.seed_placeholder !== placeholder) return true;
  }
  if (session.retired_mappings.some((mapping) => mapping.placeholder === placeholder && mapping.semantic_entity_id !== ownerId)) return true;
  return Object.values(session.entities).some((entity) => entity.semantic_entity_id !== ownerId && entity.state !== "MERGED_INTO" && entity.placeholder === placeholder);
}

export function applyReviewCommand(session: ReviewSession, command: ReviewCommand): ReviewSession {
  const changes = cloneSession(session);

  switch (command.type) {
    case "ACCEPT_DETECTION": {
      const decision = requireDecision(session, command.detection_id);
      if (decision.state === "LOCKED_REDACTION") return session;
      let entity = decision.semantic_entity_id ? requireEntity(session, decision.semantic_entity_id) : null;
      if (!entity) throw new ReviewRuntimeError("REVIEW_ENTITY_NOT_FOUND", "Review entity was not found.");
      if (command.seed_placeholder) {
        const seed = findSeedByPlaceholder(session.seed_mappings, entity.entity_type, command.seed_placeholder);
        if (!seed) throw new ReviewRuntimeError("REVIEW_SEED_NOT_FOUND", "Requested seed mapping was not found.");
        const bound = Object.values(session.entities).find((item) => item.state !== "MERGED_INTO" && item.semantic_entity_id !== entity!.semantic_entity_id && item.seed_placeholder === seed.placeholder);
        if (bound) throw new ReviewRuntimeError("REVIEW_SEED_ALREADY_BOUND", "Seed mapping is already bound to another review entity.");
        const newId = createSeedSemanticEntityId({ auditId: session.audit_id, entityType: entity.entity_type, placeholder: seed.placeholder, seedRevisionId: seed.seed_revision_id });
        delete changes.entities[entity.semantic_entity_id];
        entity = Object.freeze({ ...entity, semantic_entity_id: newId, placeholder: seed.placeholder, seed_placeholder: seed.placeholder, seed_backed: true });
        changes.entities[newId] = entity;
        for (const detectionId of entity.member_detection_ids) {
          const item = changes.decisions[detectionId];
          if (item) changes.decisions[detectionId] = Object.freeze({ ...item, semantic_entity_id: newId });
        }
      }
      changes.decisions[command.detection_id] = Object.freeze({ ...changes.decisions[command.detection_id]!, state: "ACCEPTED" });
      return withChanges(session, changes);
    }

    case "MARK_FALSE_POSITIVE": {
      const decision = requireDecision(session, command.detection_id);
      changes.decisions[command.detection_id] = Object.freeze({
        ...decision,
        state: "FALSE_POSITIVE",
        does_not_disable_future_egress_secret_scan: session.detections[command.detection_id]?.entity_type === "SECRET",
      });
      return withChanges(session, changes, { counters: Object.freeze({ ...session.counters, false_positive_count: session.counters.false_positive_count + 1 }) });
    }

    case "SET_REPLACEMENT_POLICY": {
      const decision = requireDecision(session, command.detection_id);
      const detection = session.detections[command.detection_id];
      if (!detection || detection.entity_type === "SECRET") throw new ReviewRuntimeError("REVIEW_SECRET_POLICY_FORBIDDEN", "SECRET replacement policy cannot be changed.");
      changes.decisions[command.detection_id] = Object.freeze({ ...decision, replacement_policy: command.policy });
      return withChanges(session, changes);
    }

    case "SET_URL_VISIBILITY": {
      const decision = requireDecision(session, command.detection_id);
      const detection = session.detections[command.detection_id];
      if (!detection || detection.entity_type !== "URL") throw new ReviewRuntimeError("REVIEW_URL_COMMAND_INVALID", "URL visibility command requires a URL detection.");
      changes.decisions[command.detection_id] = Object.freeze({ ...decision, url_visibility: command.visibility });
      return withChanges(session, changes);
    }

    case "MERGE_ENTITIES": {
      const entities = command.semantic_entity_ids.map((id) => requireEntity(session, id));
      const survivor = chooseMergeSurvivor(session, entities, command.survivor_placeholder);
      const mergedMemberIds = [...new Set(entities.flatMap((entity) => entity.member_detection_ids))].sort();
      const seedPlaceholders = [...new Set(entities.map((entity) => entity.seed_placeholder).filter((value): value is string => Boolean(value)))];
      const survivorPlaceholder = command.survivor_placeholder ?? survivor.placeholder ?? (seedPlaceholders.length === 1 ? seedPlaceholders[0]! : null);
      changes.entities[survivor.semantic_entity_id] = Object.freeze({
        ...survivor,
        member_detection_ids: Object.freeze(mergedMemberIds),
        placeholder: survivorPlaceholder,
        seed_placeholder: seedPlaceholders.includes(survivorPlaceholder ?? "") ? survivorPlaceholder : survivor.seed_placeholder,
        seed_backed: seedPlaceholders.length > 0,
      });
      for (const entity of entities) {
        if (entity.semantic_entity_id === survivor.semantic_entity_id) continue;
        if (entity.placeholder) {
          const retired = safeRetiredMapping(session, entity, entity.placeholder);
          if (retired) changes.retired.push(retired);
        }
        changes.entities[entity.semantic_entity_id] = Object.freeze({ ...entity, state: "MERGED_INTO", merged_into: survivor.semantic_entity_id });
      }
      for (const detectionId of mergedMemberIds) {
        const decision = changes.decisions[detectionId];
        if (decision) changes.decisions[detectionId] = Object.freeze({ ...decision, semantic_entity_id: survivor.semantic_entity_id });
      }
      return withChanges(session, changes, { counters: Object.freeze({ ...session.counters, merge_count: session.counters.merge_count + 1 }) });
    }

    case "SPLIT_ENTITY": {
      const entity = requireEntity(session, command.semantic_entity_id);
      validateSplitPartitions(entity, command.partitions, command.retained_partition_index);
      const retained = [...command.partitions[command.retained_partition_index]!].sort();
      changes.entities[entity.semantic_entity_id] = Object.freeze({ ...entity, member_detection_ids: Object.freeze(retained) });
      for (let index = 0; index < command.partitions.length; index += 1) {
        const partition = [...command.partitions[index]!].sort();
        if (index === command.retained_partition_index) continue;
        const newId = createSplitEntityId(session, entity, partition);
        changes.entities[newId] = Object.freeze({
          semantic_entity_id: newId,
          audit_id: session.audit_id,
          entity_type: entity.entity_type,
          member_detection_ids: Object.freeze(partition),
          state: "SPLIT_DERIVED",
          merged_into: null,
          placeholder: null,
          seed_placeholder: null,
          seed_backed: false,
        });
        for (const detectionId of partition) {
          const decision = changes.decisions[detectionId];
          if (decision) changes.decisions[detectionId] = Object.freeze({ ...decision, semantic_entity_id: newId });
        }
      }
      for (const detectionId of retained) {
        const decision = changes.decisions[detectionId];
        if (decision) changes.decisions[detectionId] = Object.freeze({ ...decision, semantic_entity_id: entity.semantic_entity_id });
      }
      return withChanges(session, changes, { counters: Object.freeze({ ...session.counters, split_count: session.counters.split_count + 1 }) });
    }

    case "SET_PLACEHOLDER": {
      const entity = requireEntity(session, command.semantic_entity_id);
      assertPlaceholderForType(entity.entity_type, command.placeholder);
      if (placeholderInUse(session, command.placeholder, entity.semantic_entity_id)) throw new ReviewRuntimeError("REVIEW_PLACEHOLDER_RESERVED", "Requested placeholder is reserved.");
      if (entity.placeholder && entity.placeholder !== command.placeholder) {
        const retired = safeRetiredMapping(session, entity, entity.placeholder);
        if (retired) changes.retired.push(retired);
      }
      changes.entities[entity.semantic_entity_id] = Object.freeze({ ...entity, placeholder: command.placeholder });
      return withChanges(session, changes);
    }

    case "FINALIZE_REVIEW_CANDIDATE": {
      const pending = Object.values(session.decisions).some((decision) => decision.state === "PENDING_REVIEW");
      if (pending) throw new ReviewRuntimeError("REVIEW_PENDING_DECISIONS", "Review candidate still has unresolved decisions.");
      return Object.freeze({ ...session, stage: "REVIEW_COMPLETE" });
    }
  }
}
