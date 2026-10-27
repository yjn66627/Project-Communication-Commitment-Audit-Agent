import type { CanonicalRecordDraft } from "../../domain/schemas/canonical.js";

import { makeCandidate } from "./candidate.js";
import { detectKnownEntities } from "./known-entities.js";
import { resolvePrivacyDetections } from "./overlap.js";
import { detectEmails } from "./rules/email.js";
import { detectIdCards } from "./rules/id-card.js";
import { detectIps } from "./rules/ip.js";
import { detectPhones } from "./rules/phone.js";
import { detectSecrets } from "./rules/secret.js";
import { detectUrls } from "./rules/url.js";
import { evaluateSourceNamePolicy } from "./source-name-policy.js";
import {
  PRIVACY_DETECTOR_RULESET_VERSION,
  type KnownEntityDictionary,
  type PrivacyDetectionCandidate,
  type PrivacyDetectionDiagnostics,
  type PrivacyDetectionSurface,
  type ResolvedPrivacyDetection,
  type SourceNamePolicyResult,
} from "./types.js";

export interface PrivacyDetectionResult {
  readonly candidates: readonly PrivacyDetectionCandidate[];
  readonly resolved: readonly ResolvedPrivacyDetection[];
  readonly source_name_policy: SourceNamePolicyResult;
  readonly diagnostics: PrivacyDetectionDiagnostics;
}

function detectStructured(recordId: string, surface: PrivacyDetectionSurface, raw: string): PrivacyDetectionCandidate[] {
  const urlResult = detectUrls(recordId, surface, raw);
  return [
    ...detectSecrets(recordId, surface, raw),
    ...urlResult.credentialSecrets,
    ...detectIdCards(recordId, surface, raw),
    ...urlResult.urls,
    ...detectEmails(recordId, surface, raw),
    ...detectPhones(recordId, surface, raw),
    ...detectIps(recordId, surface, raw),
  ];
}

function detectSurface(recordId: string, surface: PrivacyDetectionSurface, raw: string, dictionary: KnownEntityDictionary | undefined): PrivacyDetectionCandidate[] {
  return [...detectStructured(recordId, surface, raw), ...detectKnownEntities(recordId, surface, raw, dictionary)];
}

function countBy<T extends string>(values: readonly T[]): Partial<Record<T, number>> {
  const result: Partial<Record<T, number>> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

export function detectPrivacy(record: CanonicalRecordDraft, dictionary?: KnownEntityDictionary): PrivacyDetectionResult {
  const started = performance.now();
  const content = detectSurface(record.record_id, "CONTENT", record.content, dictionary);
  const author = record.author ? detectSurface(record.record_id, "AUTHOR", record.author, dictionary) : [];
  if (record.author && record.author.length > 0 && author.length === 0) {
    author.push(makeCandidate({
      recordId: record.record_id,
      surface: "AUTHOR",
      start: 0,
      end: record.author.length,
      entityType: "PERSON",
      normalizedKey: record.author.normalize("NFKC").trim().replace(/\s+/gu, " "),
      detectorId: "author.whole-field-person.v1",
      detectionSource: "LOCAL_HEURISTIC",
      confidence: "MEDIUM",
      reviewState: "REVIEW_REQUIRED",
      replacementPolicy: "REVIEW_REQUIRED",
    }));
  }
  const sourceName = detectSurface(record.record_id, "SOURCE_NAME", record.source_name, dictionary);
  const candidates = [...content, ...author, ...sourceName];
  const resolved = resolvePrivacyDetections(candidates);
  const sourceNamePolicy = evaluateSourceNamePolicy(record.source_name, sourceName);
  const durationMs = Math.max(0, performance.now() - started);
  return Object.freeze({
    candidates: Object.freeze(candidates),
    resolved: Object.freeze(resolved),
    source_name_policy: sourceNamePolicy,
    diagnostics: Object.freeze({
      ruleset_version: PRIVACY_DETECTOR_RULESET_VERSION,
      stage: "PRIVACY_DETECTION",
      entity_type_counts: Object.freeze(countBy(resolved.map((item) => item.entity_type))),
      surface_counts: Object.freeze(countBy(resolved.map((item) => item.surface))),
      duration_ms: durationMs,
      failure_category: null,
    }),
  });
}
