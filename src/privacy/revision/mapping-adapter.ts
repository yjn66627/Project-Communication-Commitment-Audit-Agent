import { createHash } from "node:crypto";

import type { PrivacyMapping } from "../../domain/schemas/privacy.js";
import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";
import type { RevisionMappingSnapshot } from "../../shared/ids/types.js";
import type { LocalPrivacyMappingDraft } from "../pseudonymization/types.js";
import { ConfirmationRuntimeError } from "./errors.js";

const SNAPSHOT_FIELDS = ["active", "aliases", "entity_type", "normalized_original_value", "placeholder"] as const;

function canonicalAliases(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareUnicodeCodePoints);
}

function mappingKey(value: { entity_type: string; placeholder: string }): string {
  return `${value.entity_type}\0${value.placeholder}`;
}

export function assertRevisionMappingSnapshotExactFields(snapshot: readonly RevisionMappingSnapshot[]): void {
  for (const entry of snapshot as readonly Record<string, unknown>[]) {
    const keys = Object.keys(entry).sort(compareUnicodeCodePoints);
    if (keys.length !== SNAPSHOT_FIELDS.length || keys.some((key, index) => key !== SNAPSHOT_FIELDS[index])) {
      throw new ConfirmationRuntimeError({
        code: "MAPPING_SNAPSHOT_MISMATCH",
        stage: "BUILD",
        safeCategory: "INVALID_INPUT",
        safeMessage: "Revision mapping snapshot does not satisfy the frozen field contract.",
      });
    }
    if ((entry as { entity_type?: string }).entity_type === "SECRET") {
      throw new ConfirmationRuntimeError({
        code: "SECRET_MAPPING_FORBIDDEN",
        stage: "BUILD",
        safeCategory: "INVALID_INPUT",
        safeMessage: "SECRET cannot enter a reversible mapping snapshot.",
      });
    }
  }
}

export function assertMappingSnapshotMatchesVault(
  snapshot: readonly RevisionMappingSnapshot[],
  vault: readonly LocalPrivacyMappingDraft[],
): void {
  assertRevisionMappingSnapshotExactFields(snapshot);
  if (snapshot.length !== vault.length) {
    throw new ConfirmationRuntimeError({
      code: "MAPPING_SNAPSHOT_MISMATCH",
      stage: "BUILD",
      safeCategory: "INVALID_INPUT",
      safeMessage: "Revision mapping snapshot and local mapping vault are inconsistent.",
    });
  }

  const snapshotMap = new Map<string, RevisionMappingSnapshot>();
  for (const item of snapshot) {
    const key = mappingKey(item);
    if (snapshotMap.has(key)) {
      throw new ConfirmationRuntimeError({ code: "MAPPING_SNAPSHOT_MISMATCH", stage: "BUILD", safeCategory: "INVALID_INPUT", safeMessage: "Revision mapping snapshot contains duplicate identities." });
    }
    snapshotMap.set(key, item);
  }

  const vaultKeys = new Set<string>();
  for (const local of vault) {
    const runtimeEntityType = (local as unknown as { entity_type?: unknown }).entity_type;
    if (runtimeEntityType === "SECRET") {
      throw new ConfirmationRuntimeError({ code: "SECRET_MAPPING_FORBIDDEN", stage: "BUILD", safeCategory: "INVALID_INPUT", safeMessage: "SECRET cannot enter local reversible mapping persistence." });
    }
    const key = mappingKey(local);
    if (vaultKeys.has(key)) {
      throw new ConfirmationRuntimeError({ code: "MAPPING_SNAPSHOT_MISMATCH", stage: "BUILD", safeCategory: "INVALID_INPUT", safeMessage: "Local mapping vault contains duplicate identities." });
    }
    vaultKeys.add(key);
    const snap = snapshotMap.get(key);
    if (!snap) {
      throw new ConfirmationRuntimeError({ code: "MAPPING_SNAPSHOT_MISMATCH", stage: "BUILD", safeCategory: "INVALID_INPUT", safeMessage: "Revision mapping snapshot and local mapping vault are inconsistent." });
    }
    const aliasesEqual = canonicalAliases(snap.aliases).length === canonicalAliases(local.aliases).length &&
      canonicalAliases(snap.aliases).every((value, index) => value === canonicalAliases(local.aliases)[index]);
    if (
      snap.normalized_original_value !== local.normalized_key ||
      snap.active !== local.active ||
      !aliasesEqual
    ) {
      throw new ConfirmationRuntimeError({ code: "MAPPING_SNAPSHOT_MISMATCH", stage: "BUILD", safeCategory: "INVALID_INPUT", safeMessage: "Revision mapping snapshot and local mapping vault are inconsistent." });
    }
  }
}

export function computeCompatibilityMappingId(input: Readonly<{
  privacyRevisionId: string;
  entityType: string;
  placeholder: string;
}>): string {
  const digest = createHash("sha256")
    .update("privacy-mapping-roundtrip-v1\0", "utf8")
    .update(input.privacyRevisionId, "utf8")
    .update("\0", "utf8")
    .update(input.entityType, "utf8")
    .update("\0", "utf8")
    .update(input.placeholder, "utf8")
    .digest("hex")
    .slice(0, 32);
  return `map_${digest}`;
}

export function adaptLocalVaultToPrivacyMappings(input: Readonly<{
  auditId: string;
  privacyRevisionId: `prv_${string}`;
  vault: readonly LocalPrivacyMappingDraft[];
}>): readonly PrivacyMapping[] {
  const mappings = input.vault.map((mapping) => Object.freeze({
    mapping_id: computeCompatibilityMappingId({
      privacyRevisionId: input.privacyRevisionId,
      entityType: mapping.entity_type,
      placeholder: mapping.placeholder,
    }),
    audit_id: input.auditId,
    privacy_revision_id: input.privacyRevisionId,
    entity_type: mapping.entity_type,
    placeholder: mapping.placeholder,
    original_value: mapping.original_value,
    normalized_key: mapping.normalized_key,
    aliases: canonicalAliases(mapping.aliases),
    active: mapping.active,
  } satisfies PrivacyMapping));
  mappings.sort((a, b) => compareUnicodeCodePoints(a.entity_type, b.entity_type) || compareUnicodeCodePoints(a.placeholder, b.placeholder) || compareUnicodeCodePoints(a.mapping_id, b.mapping_id));
  return Object.freeze(mappings);
}
