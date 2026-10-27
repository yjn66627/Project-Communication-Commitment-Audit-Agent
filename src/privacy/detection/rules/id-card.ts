import { normalizeAndValidatePrcResidentId } from "../../normalization/id-card.js";
import { makeCandidate } from "../candidate.js";
import type { PrivacyDetectionCandidate, PrivacyDetectionSurface } from "../types.js";

const ID_PATTERN = /[0-9０-９]{17}[0-9０-９XxＸｘ]/gu;
const ID_NEIGHBOR = /[0-9０-９A-Za-zＡ-Ｚａ-ｚ]/u;

export function detectIdCards(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  for (const match of raw.matchAll(ID_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if ((start > 0 && ID_NEIGHBOR.test(raw[start - 1]!)) || (end < raw.length && ID_NEIGHBOR.test(raw[end]!))) continue;
    const normalized = normalizeAndValidatePrcResidentId(raw.slice(start, end));
    if (!normalized) continue;
    results.push(makeCandidate({
      recordId,
      surface,
      start,
      end,
      entityType: "ID_CARD",
      normalizedKey: normalized,
      detectorId: "id-card.prc-resident-18.v1",
      confidence: "HIGH",
    }));
  }
  return results;
}
