import { normalizeNamedEntity } from "../normalization/common.js";
import { makeCandidate } from "./candidate.js";
import type {
  KnownEntityAlias,
  KnownEntityDictionary,
  KnownEntityEntry,
  PrivacyDetectionCandidate,
  PrivacyDetectionSurface,
} from "./types.js";

function codePointBoundaries(value: string): number[] {
  const boundaries = [0];
  let offset = 0;
  for (const point of value) {
    offset += point.length;
    boundaries.push(offset);
  }
  return boundaries;
}

function findAllExact(raw: string, needle: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  if (!needle) return found;
  let from = 0;
  while (from <= raw.length - needle.length) {
    const index = raw.indexOf(needle, from);
    if (index < 0) break;
    found.push({ start: index, end: index + needle.length });
    from = index + Math.max(1, needle.length);
  }
  return found;
}

/**
 * NFKC never supplies indexes. We enumerate raw UTF-16 substring boundaries first,
 * then normalize only each raw slice for comparison.
 */
function findAllNormalized(raw: string, target: string): Array<{ start: number; end: number }> {
  const normalizedTarget = normalizeNamedEntity(target);
  if (!normalizedTarget) return [];
  const boundaries = codePointBoundaries(raw);
  const found: Array<{ start: number; end: number }> = [];
  const maxRawPoints = Math.max(Array.from(normalizedTarget).length * 2 + 8, 16);
  for (let startIndex = 0; startIndex < boundaries.length - 1; startIndex += 1) {
    const maxEndIndex = Math.min(boundaries.length - 1, startIndex + maxRawPoints);
    for (let endIndex = startIndex + 1; endIndex <= maxEndIndex; endIndex += 1) {
      const start = boundaries[startIndex]!;
      const end = boundaries[endIndex]!;
      if (normalizeNamedEntity(raw.slice(start, end)) === normalizedTarget) {
        found.push({ start, end });
      }
    }
  }
  return found;
}

function aliasValue(alias: string | KnownEntityAlias): string {
  return typeof alias === "string" ? alias : alias.value;
}

function aliasUnambiguous(alias: string | KnownEntityAlias): boolean {
  return typeof alias !== "string" && alias.unambiguous === true;
}

export function detectKnownEntities(
  recordId: string,
  surface: PrivacyDetectionSurface,
  raw: string,
  dictionary: KnownEntityDictionary | undefined,
): PrivacyDetectionCandidate[] {
  if (!dictionary) return [];
  const results: PrivacyDetectionCandidate[] = [];
  const dedupe = new Set<string>();
  const entries = [...dictionary.entries].sort((a, b) => {
    const typeCompare = a.entity_type.localeCompare(b.entity_type, "en");
    return typeCompare !== 0 ? typeCompare : a.canonical_value.localeCompare(b.canonical_value, "en");
  });

  const emit = (entry: KnownEntityEntry, start: number, end: number, detectorId: string, confidence: "HIGH" | "MEDIUM") => {
    const key = `${entry.entity_type}:${start}:${end}:${detectorId}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    results.push(makeCandidate({
      recordId,
      surface,
      start,
      end,
      entityType: entry.entity_type,
      normalizedKey: normalizeNamedEntity(raw.slice(start, end)),
      detectorId,
      detectionSource: "LOCAL_HEURISTIC",
      confidence,
      reviewState: confidence === "MEDIUM" ? "REVIEW_REQUIRED" : "UNREVIEWED",
    }));
  };

  for (const entry of entries) {
    for (const span of findAllExact(raw, entry.canonical_value)) emit(entry, span.start, span.end, `known.${entry.entity_type.toLowerCase()}.canonical.v1`, "HIGH");
    for (const span of findAllNormalized(raw, entry.canonical_value)) {
      if (raw.slice(span.start, span.end) === entry.canonical_value) continue;
      emit(entry, span.start, span.end, `known.${entry.entity_type.toLowerCase()}.normalized.v1`, "MEDIUM");
    }
    for (const alias of entry.aliases ?? []) {
      const value = aliasValue(alias);
      for (const span of findAllExact(raw, value)) emit(entry, span.start, span.end, `known.${entry.entity_type.toLowerCase()}.alias-exact.v1`, "HIGH");
      for (const span of findAllNormalized(raw, value)) {
        if (raw.slice(span.start, span.end) === value) continue;
        emit(entry, span.start, span.end, `known.${entry.entity_type.toLowerCase()}.alias-normalized.v1`, aliasUnambiguous(alias) ? "HIGH" : "MEDIUM");
      }
    }
  }
  return results;
}
