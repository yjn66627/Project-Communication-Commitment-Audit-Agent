import { Buffer } from "node:buffer";

import { makeCandidate } from "../candidate.js";
import type { PrivacyDetectionCandidate, PrivacyDetectionSurface, SecretFamily } from "../types.js";

interface SecretRule {
  readonly detectorId: string;
  readonly family: SecretFamily;
  readonly pattern: RegExp;
  readonly validate?: (value: string) => boolean;
}

const SIMPLE_RULES: readonly SecretRule[] = [
  { detectorId: "secret.auth-bearer.v1", family: "AUTH_BEARER", pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu },
  { detectorId: "secret.auth-basic.v1", family: "AUTH_BASIC", pattern: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]{8,}={0,2}/giu },
  { detectorId: "secret.sk-style.v1", family: "API_KEY_SK_STYLE", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/gu },
  { detectorId: "secret.github-style.v1", family: "GITHUB_TOKEN_STYLE", pattern: /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu },
  { detectorId: "secret.aws-access-key.v1", family: "AWS_ACCESS_KEY_STYLE", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu },
];

function decodeBase64UrlJson(segment: string): unknown {
  try {
    const text = Buffer.from(segment, "base64url").toString("utf8");
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isAuthoritativeJwt(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length < 2 || !/^[A-Za-z0-9_-]+$/u.test(part))) return false;
  const header = decodeBase64UrlJson(parts[0]!);
  if (typeof header !== "object" || header === null || Array.isArray(header)) return false;
  const record = header as Record<string, unknown>;
  return typeof record.alg === "string" || typeof record.typ === "string";
}

function addMatches(results: PrivacyDetectionCandidate[], recordId: string, surface: PrivacyDetectionSurface, raw: string, rule: SecretRule): void {
  rule.pattern.lastIndex = 0;
  for (const match of raw.matchAll(rule.pattern)) {
    if (rule.validate && !rule.validate(match[0])) continue;
    results.push(makeCandidate({
      recordId,
      surface,
      start: match.index,
      end: match.index + match[0].length,
      entityType: "SECRET",
      normalizedKey: null,
      detectorId: rule.detectorId,
      confidence: "HIGH",
      secretFamily: rule.family,
    }));
  }
}

function detectPrivateKeyBlocks(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  const beginPattern = /-----BEGIN ((?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY)-----/gu;
  for (const begin of raw.matchAll(beginPattern)) {
    const label = begin[1]!;
    const endMarker = `-----END ${label}-----`;
    const markerIndex = raw.indexOf(endMarker, begin.index + begin[0].length);
    const end = markerIndex === -1 ? raw.length : markerIndex + endMarker.length;
    results.push(makeCandidate({
      recordId,
      surface,
      start: begin.index,
      end,
      entityType: "SECRET",
      normalizedKey: null,
      detectorId: "secret.private-key-pem.v1",
      confidence: "HIGH",
      secretFamily: "PRIVATE_KEY_PEM",
    }));
  }
  return results;
}

function detectJwt(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  const pattern = /\b[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{2,}\b/gu;
  for (const match of raw.matchAll(pattern)) {
    if (!isAuthoritativeJwt(match[0])) continue;
    results.push(makeCandidate({ recordId, surface, start: match.index, end: match.index + match[0].length, entityType: "SECRET", normalizedKey: null, detectorId: "secret.jwt-structured.v1", confidence: "HIGH", secretFamily: "JWT_STRUCTURED" }));
  }
  return results;
}

function detectNamedAssignments(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  const strongPattern = /\b(api_key|apikey|secret|access_token|client_secret|password)\b\s*[:=]\s*(?:["'][^"'\r\n]{1,256}["']|[^\s,;\r\n]{1,256})/giu;
  for (const match of raw.matchAll(strongPattern)) {
    results.push(makeCandidate({ recordId, surface, start: match.index, end: match.index + match[0].length, entityType: "SECRET", normalizedKey: null, detectorId: "secret.named-assignment.v1", confidence: "HIGH", secretFamily: "NAMED_SECRET_ASSIGNMENT" }));
  }
  const tokenPattern = /\btoken\b\s*[:=]\s*(?:["']([^"'\r\n]{1,256})["']|([^\s,;\r\n]{1,256}))/giu;
  for (const match of raw.matchAll(tokenPattern)) {
    const value = match[1] ?? match[2] ?? "";
    const complexEnough = value.length >= 16 && /[A-Za-z]/u.test(value) && /[0-9_-]/u.test(value);
    if (!complexEnough) continue;
    results.push(makeCandidate({ recordId, surface, start: match.index, end: match.index + match[0].length, entityType: "SECRET", normalizedKey: null, detectorId: "secret.named-token.v1", confidence: "MEDIUM", secretFamily: "NAMED_SECRET_ASSIGNMENT" }));
  }
  return results;
}

export function detectSecrets(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const results: PrivacyDetectionCandidate[] = [];
  for (const rule of SIMPLE_RULES) addMatches(results, recordId, surface, raw, rule);
  results.push(...detectPrivateKeyBlocks(recordId, surface, raw));
  results.push(...detectJwt(recordId, surface, raw));
  results.push(...detectNamedAssignments(recordId, surface, raw));
  return results;
}
