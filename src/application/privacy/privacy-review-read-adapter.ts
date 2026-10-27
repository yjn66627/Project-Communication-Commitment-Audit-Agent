import type { ReviewSession } from "../../privacy/review/types.js";
import type { PrivacyReviewService } from "./privacy-review-service.js";

export type PrivacyReviewReadDTO = Readonly<{
  stage: ReviewSession["stage"];
  detections: readonly Readonly<{
    itemId: string;
    category: string;
    surface: string;
    sanitizedPreview: string;
    decision: string;
    replacementPolicy: string;
    urlVisibility: string | null;
    candidateToken: string | null;
  }>[];
  entities: readonly Readonly<{ candidateToken: string; category: string; state: string; placeholder: string | null; itemTokens: readonly string[] }>[];
  seedPlaceholders: readonly string[];
  counters: Readonly<{ mergeCount: number; splitCount: number; falsePositiveCount: number }>;
}>;

/** Projects C1's local review state without exposing raw inputs, normalized keys, or mapping vault data. */
export class PrivacyReviewReadAdapter {
  constructor(private readonly reviews: PrivacyReviewService) {}

  getSafe(auditId: string): PrivacyReviewReadDTO {
    const session = this.reviews.getSessionLocal(auditId);
    const detections = Object.values(session.detections).sort((a, b) => a.detection_id.localeCompare(b.detection_id)).map((detection) => {
      const decision = session.decisions[detection.detection_id];
      const entity = decision?.semantic_entity_id ? session.entities[decision.semantic_entity_id] : undefined;
      return Object.freeze({
        itemId: detection.detection_id,
        category: detection.entity_type,
        surface: detection.surface,
        sanitizedPreview: "[Sensitive value withheld during review.]",
        decision: decision?.state ?? detection.review_state,
        replacementPolicy: decision?.replacement_policy ?? detection.replacement_policy,
        urlVisibility: decision?.url_visibility ?? null,
        candidateToken: entity?.state !== "MERGED_INTO" ? entity?.semantic_entity_id ?? null : null,
      });
    });
    const entities = Object.values(session.entities).filter((entity) => entity.state !== "MERGED_INTO").sort((a, b) => a.semantic_entity_id.localeCompare(b.semantic_entity_id)).map((entity) => Object.freeze({
      candidateToken: entity.semantic_entity_id,
      category: entity.entity_type,
      state: entity.state,
      placeholder: entity.placeholder,
      itemTokens: Object.freeze([...entity.member_detection_ids]),
    }));
    return Object.freeze({
      stage: session.stage,
      detections: Object.freeze(detections),
      entities: Object.freeze(entities),
      seedPlaceholders: Object.freeze(session.seed_mappings.map((mapping) => mapping.placeholder).sort()),
      counters: Object.freeze({ mergeCount: session.counters.merge_count, splitCount: session.counters.split_count, falsePositiveCount: session.counters.false_positive_count }),
    });
  }
}
