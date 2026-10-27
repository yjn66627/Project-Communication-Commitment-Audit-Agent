import type { PrivacyDetectionSurface, ResolvedPrivacyDetection } from "../detection/types.js";
import type { PseudonymMappingPlan } from "../pseudonymization/types.js";
import type { DetectionDecision, ReviewSession } from "../review/types.js";

interface ReplacementOperation {
  readonly detection_id: string;
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function mappingPlaceholder(plan: PseudonymMappingPlan, semanticEntityId: string | null): string | null {
  if (!semanticEntityId) return null;
  const entity = plan.semantic_entities.find((item) => item.semantic_entity_id === semanticEntityId);
  return entity?.placeholder ?? null;
}

function renderReplacement(
  detection: ResolvedPrivacyDetection,
  decision: DetectionDecision,
  plan: PseudonymMappingPlan,
): string | null {
  if (decision.state === "FALSE_POSITIVE") return null;
  if (detection.entity_type === "URL" && decision.url_visibility === "RESTORED") return null;
  if (detection.entity_type === "SECRET" || decision.replacement_policy === "LOCKED_REDACTION") return "[SECRET_REDACTED]";
  if (decision.state !== "ACCEPTED") return null;
  if (decision.replacement_policy === "REDACT") return `[${detection.entity_type}_REDACTED]`;
  if (decision.replacement_policy === "PSEUDONYMIZE") {
    const placeholder = mappingPlaceholder(plan, decision.semantic_entity_id);
    if (!placeholder) throw new TypeError("Accepted pseudonymized detection has no mapping placeholder.");
    return placeholder;
  }
  return null;
}

export function applyResolvedReplacements(input: Readonly<{
  raw: string;
  recordId: string;
  surface: PrivacyDetectionSurface;
  session: ReviewSession;
  mappingPlan: PseudonymMappingPlan;
}>): string {
  const operations: ReplacementOperation[] = [];
  for (const detection of Object.values(input.session.detections)) {
    if (detection.record_id !== input.recordId || detection.surface !== input.surface) continue;
    const decision = input.session.decisions[detection.detection_id];
    if (!decision) continue;
    const replacement = renderReplacement(detection, decision, input.mappingPlan);
    if (replacement === null) continue;
    operations.push({
      detection_id: detection.detection_id,
      start: detection.effective_start,
      end: detection.effective_end,
      replacement,
    });
  }
  operations.sort((a, b) => b.start - a.start || b.end - a.end || (a.detection_id < b.detection_id ? -1 : a.detection_id > b.detection_id ? 1 : 0));
  let previousStart = input.raw.length + 1;
  let output = input.raw;
  for (const operation of operations) {
    if (operation.start < 0 || operation.end > input.raw.length || operation.end <= operation.start) throw new RangeError("Replacement envelope is invalid.");
    if (operation.end > previousStart) throw new TypeError("Resolved replacement envelopes overlap unexpectedly.");
    output = output.slice(0, operation.start) + operation.replacement + output.slice(operation.end);
    previousStart = operation.start;
  }
  return output;
}
