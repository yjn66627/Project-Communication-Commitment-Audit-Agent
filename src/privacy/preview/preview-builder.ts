import { buildMappingPlan } from "../pseudonymization/mapping-plan.js";
import { createSafeSourceLabel } from "../pseudonymization/source-label.js";
import type { PseudonymMappingPlan } from "../pseudonymization/types.js";
import type { ReviewSession } from "../review/types.js";
import { applyResolvedReplacements } from "./replacement.js";
import type { SanitizedPreviewRecordCandidate } from "./types.js";

export interface FinalizedReviewCandidate {
  readonly preview_records: readonly SanitizedPreviewRecordCandidate[];
  readonly mapping_plan: PseudonymMappingPlan;
}

export function buildSanitizedPreview(session: ReviewSession): FinalizedReviewCandidate {
  if (session.stage !== "REVIEW_COMPLETE") throw new TypeError("Review candidate is not finalized.");
  const mappingPlan = buildMappingPlan(session);
  const records = Object.values(session.records).sort((a, b) => a.sequence - b.sequence || (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
  const preview = records.map((record): SanitizedPreviewRecordCandidate => {
    const sourcePolicy = session.source_name_policies[record.record_id];
    const sanitizedSourceName = sourcePolicy?.policy === "SAFE_LABEL_REQUIRED"
      ? createSafeSourceLabel(session.audit_id, record.record_id)
      : applyResolvedReplacements({ raw: record.source_name, recordId: record.record_id, surface: "SOURCE_NAME", session, mappingPlan });
    const sanitizedAuthor = record.author === null
      ? null
      : applyResolvedReplacements({ raw: record.author, recordId: record.record_id, surface: "AUTHOR", session, mappingPlan });
    const sanitizedContent = applyResolvedReplacements({ raw: record.content, recordId: record.record_id, surface: "CONTENT", session, mappingPlan });
    return Object.freeze({
      record_id: record.record_id,
      source_type: record.source_type,
      sanitized_source_name: sanitizedSourceName,
      sanitized_author: sanitizedAuthor,
      timestamp: record.timestamp,
      sanitized_content: sanitizedContent,
      sequence: record.sequence,
    });
  });
  return Object.freeze({ preview_records: Object.freeze(preview), mapping_plan: mappingPlan });
}
