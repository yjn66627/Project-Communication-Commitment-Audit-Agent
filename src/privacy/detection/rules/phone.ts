import { normalizePhoneCandidate } from "../../normalization/phone.js";
import { makeCandidate } from "../candidate.js";
import type { PrivacyDetectionCandidate, PrivacyDetectionSurface } from "../types.js";

const PRC_PATTERN = /(?:\+86[\s\-()]*)?1[3-9](?:[\s\-()]*\d){9}/gu;
const INTERNATIONAL_PATTERN = /\+(?:[\s\-()]*\d){8,15}/gu;

function trimTrailingSeparators(raw: string, start: number, value: string): { value: string; end: number } {
  const trimmed = value.replace(/[\s\-()]+$/gu, "");
  return { value: trimmed, end: start + trimmed.length };
}

function boundaryIsSafe(raw: string, start: number, end: number): boolean {
  const before = start > 0 ? raw[start - 1]! : "";
  const after = end < raw.length ? raw[end]! : "";
  return !/[A-Za-z0-9]/u.test(before) && !/[A-Za-z0-9]/u.test(after);
}

export function detectPhones(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  const seen = new Set<string>();
  for (const [detectorId, pattern] of [["phone.prc-mobile.v1", PRC_PATTERN], ["phone.explicit-intl.v1", INTERNATIONAL_PATTERN]] as const) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      const start = match.index;
      const trimmed = trimTrailingSeparators(raw, start, match[0]);
      if (!boundaryIsSafe(raw, start, trimmed.end)) continue;
      const normalized = normalizePhoneCandidate(trimmed.value);
      if (!normalized) continue;
      if (detectorId === "phone.explicit-intl.v1" && normalized.startsWith("+86") && normalized.length === 14) continue;
      const key = `${start}:${trimmed.end}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(makeCandidate({
        recordId,
        surface,
        start,
        end: trimmed.end,
        entityType: "PHONE",
        normalizedKey: normalized,
        detectorId,
        confidence: "HIGH",
      }));
    }
  }
  return results;
}
