import { normalizeUrlCandidate, trimUrlTrailingProse, urlContainsCredentialUserinfo } from "../../normalization/url.js";
import { makeCandidate } from "../candidate.js";
import type { PrivacyDetectionCandidate, PrivacyDetectionSurface } from "../types.js";

const EXPLICIT_URL = /(?:https?|ftp|file):\/\/[^\s<>"']+/giu;
const WWW_URL = /\bwww\.[^\s<>"']+/giu;

export interface UrlDetectionResult {
  readonly urls: readonly PrivacyDetectionCandidate[];
  readonly credentialSecrets: readonly PrivacyDetectionCandidate[];
}

export function detectUrls(recordId: string, surface: PrivacyDetectionSurface, raw: string): UrlDetectionResult {
  const urls: PrivacyDetectionCandidate[] = [];
  const credentialSecrets: PrivacyDetectionCandidate[] = [];
  for (const [detectorId, pattern, confidence] of [
    ["url.explicit-scheme.v1", EXPLICIT_URL, "HIGH"],
    ["url.www.v1", WWW_URL, "MEDIUM"],
  ] as const) {
    pattern.lastIndex = 0;
    for (const match of raw.matchAll(pattern)) {
      const start = match.index;
      const trimmed = trimUrlTrailingProse(match[0]);
      const end = start + trimmed.length;
      const normalized = normalizeUrlCandidate(raw.slice(start, end));
      if (!normalized) continue;
      urls.push(makeCandidate({ recordId, surface, start, end, entityType: "URL", normalizedKey: normalized, detectorId, confidence }));
      if (urlContainsCredentialUserinfo(raw.slice(start, end))) {
        credentialSecrets.push(makeCandidate({
          recordId,
          surface,
          start,
          end,
          entityType: "SECRET",
          normalizedKey: null,
          detectorId: "secret.url-userinfo.v1",
          confidence: "HIGH",
          secretFamily: "URL_USERINFO_CREDENTIAL",
        }));
      }
    }
  }
  return { urls, credentialSecrets };
}
