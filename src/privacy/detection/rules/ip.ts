import { isIP } from "node:net";

import { normalizeIpCandidate } from "../../normalization/ip.js";
import { makeCandidate } from "../candidate.js";
import type { PrivacyDetectionCandidate, PrivacyDetectionSurface } from "../types.js";

const IPV4_PATTERN = /\d{1,3}(?:\.\d{1,3}){3}/gu;
const IPV6_TOKEN_PATTERN = /[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]+/gu;

function tokenBoundarySafe(raw: string, start: number, end: number): boolean {
  const before = start > 0 ? raw[start - 1]! : "";
  const after = end < raw.length ? raw[end]! : "";
  return !/[0-9A-Fa-f:.%]/u.test(before) && !/[0-9A-Fa-f:.%]/u.test(after);
}

export function detectIps(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  for (const match of raw.matchAll(IPV4_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (!tokenBoundarySafe(raw, start, end) || isIP(match[0]) !== 4) continue;
    results.push(makeCandidate({ recordId, surface, start, end, entityType: "IP", normalizedKey: normalizeIpCandidate(match[0]), detectorId: "ip.ipv4.v1", confidence: "HIGH" }));
  }
  for (const match of raw.matchAll(IPV6_TOKEN_PATTERN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (raw.slice(end, end + 1) === "%" || !tokenBoundarySafe(raw, start, end) || isIP(match[0]) !== 6) continue;
    const normalized = normalizeIpCandidate(match[0]);
    if (!normalized) continue;
    results.push(makeCandidate({ recordId, surface, start, end, entityType: "IP", normalizedKey: normalized, detectorId: "ip.ipv6.v1", confidence: "HIGH" }));
  }
  return results;
}
