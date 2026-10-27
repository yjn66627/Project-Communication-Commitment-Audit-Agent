import type { PrivacyDetectionCandidate, PrivacyDetectionConfidence, PrivacyDetectionSurface, ResolvedPrivacyDetection } from "./types.js";

const CONFIDENCE_RANK: Readonly<Record<PrivacyDetectionConfidence, number>> = Object.freeze({ HIGH: 4, MEDIUM: 3, LOW: 2, NOT_APPLICABLE: 1 });
const SURFACE_RANK: Readonly<Record<PrivacyDetectionSurface, number>> = Object.freeze({ CONTENT: 1, AUTHOR: 2, SOURCE_NAME: 3 });

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareWinner(a: PrivacyDetectionCandidate, b: PrivacyDetectionCandidate): number {
  return b.priority - a.priority
    || CONFIDENCE_RANK[b.confidence] - CONFIDENCE_RANK[a.confidence]
    || (b.char_end - b.char_start) - (a.char_end - a.char_start)
    || a.char_start - b.char_start
    || compareText(a.detector_id, b.detector_id)
    || compareText(a.entity_type, b.entity_type);
}

function overlaps(a: PrivacyDetectionCandidate, b: PrivacyDetectionCandidate): boolean {
  return a.char_start < b.char_end && b.char_start < a.char_end;
}

export function resolvePrivacyDetections(candidates: readonly PrivacyDetectionCandidate[]): ResolvedPrivacyDetection[] {
  const groups = new Map<string, PrivacyDetectionCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.record_id}\0${candidate.surface}`;
    const group = groups.get(key);
    if (group) group.push(candidate); else groups.set(key, [candidate]);
  }
  const resolved: ResolvedPrivacyDetection[] = [];
  for (const group of groups.values()) {
    const sorted = [...group].sort((a, b) => a.char_start - b.char_start || a.char_end - b.char_end || compareText(a.detector_id, b.detector_id));
    let cluster: PrivacyDetectionCandidate[] = [];
    let clusterEnd = -1;
    const flush = () => {
      if (cluster.length === 0) return;
      const winner = [...cluster].sort(compareWinner)[0]!;
      const effectiveStart = Math.min(...cluster.map((item) => item.char_start));
      const effectiveEnd = Math.max(...cluster.map((item) => item.char_end));
      const hasSecret = cluster.some((item) => item.entity_type === "SECRET");
      const secretWinner = hasSecret ? [...cluster].filter((item) => item.entity_type === "SECRET").sort(compareWinner)[0]! : winner;
      resolved.push(Object.freeze({
        ...secretWinner,
        replacement_policy: hasSecret ? "LOCKED_REDACTION" : secretWinner.replacement_policy,
        review_state: hasSecret ? "LOCKED_REDACTION" : secretWinner.review_state,
        effective_start: effectiveStart,
        effective_end: effectiveEnd,
        overlap_member_count: cluster.length,
      }));
      cluster = [];
      clusterEnd = -1;
    };
    for (const candidate of sorted) {
      if (cluster.length === 0) {
        cluster = [candidate];
        clusterEnd = candidate.char_end;
      } else if (candidate.char_start < clusterEnd && cluster.some((member) => overlaps(member, candidate))) {
        cluster.push(candidate);
        clusterEnd = Math.max(clusterEnd, candidate.char_end);
      } else {
        flush();
        cluster = [candidate];
        clusterEnd = candidate.char_end;
      }
    }
    flush();
  }
  return resolved.sort((a, b) => SURFACE_RANK[a.surface] - SURFACE_RANK[b.surface]
    || a.effective_start - b.effective_start
    || a.effective_end - b.effective_end
    || b.priority - a.priority
    || compareText(a.detector_id, b.detector_id));
}
