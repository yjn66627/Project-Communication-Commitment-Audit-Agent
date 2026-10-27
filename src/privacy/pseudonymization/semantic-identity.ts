import { createHash } from "node:crypto";

import type { MappablePrivacyEntityType } from "./types.js";

function structuralHash(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex").slice(0, 32);
}

export function createSemanticEntityId(input: Readonly<{
  auditId: string;
  entityType: MappablePrivacyEntityType;
  detectionIds: readonly string[];
}>): string {
  const detectionIds = [...input.detectionIds].sort();
  if (detectionIds.length === 0) throw new TypeError("Semantic entity requires at least one detection identity.");
  return `sent_${structuralHash(["semantic-entity-v1", input.auditId, input.entityType, ...detectionIds])}`;
}

export function createSeedSemanticEntityId(input: Readonly<{
  auditId: string;
  entityType: MappablePrivacyEntityType;
  placeholder: string;
  seedRevisionId?: string | null;
}>): string {
  return `sent_${structuralHash([
    "seed-semantic-entity-v1",
    input.auditId,
    input.entityType,
    input.placeholder,
    input.seedRevisionId ?? "",
  ])}`;
}
