import { normalizeEmailCandidate } from "../../normalization/email.js";
import { makeCandidate } from "../candidate.js";
import type { PrivacyDetectionCandidate, PrivacyDetectionSurface } from "../types.js";

const EMAIL_PATTERN = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+/gu;
const ASCII_EMAIL_NEIGHBOR = /[A-Za-z0-9.!#$%&'*+/=?^_`{|}~@-]/u;

export function detectEmails(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  for (const match of raw.matchAll(EMAIL_PATTERN)) {
    const value = match[0];
    const start = match.index;
    const end = start + value.length;
    if ((start > 0 && ASCII_EMAIL_NEIGHBOR.test(raw[start - 1]!)) || (end < raw.length && ASCII_EMAIL_NEIGHBOR.test(raw[end]!))) continue;
    const normalized = normalizeEmailCandidate(value);
    if (!normalized) continue;
    results.push(makeCandidate({
      recordId,
      surface,
      start,
      end,
      entityType: "EMAIL",
      normalizedKey: normalized,
      detectorId: "email.ascii-dot-atom.v1",
      confidence: "HIGH",
    }));
  }
  return results;
}
