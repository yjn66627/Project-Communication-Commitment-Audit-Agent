import type { SanitizedCanonicalRecordRevision } from "../../domain/schemas/canonical.js";
import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";
import {
  computePrivacyRevisionId,
  computeRecordRevisionId,
  type RevisionRecordSnapshot,
} from "../../shared/ids/index.js";
import type { SanitizedPreviewRecordCandidate } from "../preview/types.js";
import { ConfirmationRuntimeError } from "./errors.js";
import { adaptLocalVaultToPrivacyMappings, assertMappingSnapshotMatchesVault } from "./mapping-adapter.js";
import type { ConfirmedPrivacyAggregateDraft, FinalizedReviewCandidate } from "./types.js";

const SOURCE_TYPES = new Set(["PASTE", "TXT", "MARKDOWN", "JSON"]);

export function previewToRevisionRecordSnapshot(
  preview: SanitizedPreviewRecordCandidate,
): RevisionRecordSnapshot {
  if (!preview.record_id.startsWith("rec_")) throw invalidRecord();
  if (!SOURCE_TYPES.has(preview.source_type)) throw invalidRecord();
  if (preview.sanitized_source_name.length < 1 || preview.sanitized_source_name.length > 512) throw invalidRecord();
  if (preview.sanitized_author !== null && (preview.sanitized_author.length < 1 || preview.sanitized_author.length > 256)) throw invalidRecord();
  if (preview.timestamp !== null && preview.timestamp.length > 128) throw invalidRecord();
  if (preview.sanitized_content.length < 1) throw invalidRecord();
  if (!Number.isInteger(preview.sequence) || preview.sequence < 0) throw invalidRecord();
  return Object.freeze({
    record_id: preview.record_id as RevisionRecordSnapshot["record_id"],
    source_type: preview.source_type as RevisionRecordSnapshot["source_type"],
    source_name: preview.sanitized_source_name,
    author: preview.sanitized_author,
    timestamp: preview.timestamp,
    sanitized_content: preview.sanitized_content,
    sequence: preview.sequence,
  });
}

function invalidRecord(): ConfirmationRuntimeError {
  return new ConfirmationRuntimeError({
    code: "REVISION_INPUT_INVALID",
    stage: "BUILD",
    safeCategory: "INVALID_INPUT",
    safeMessage: "Sanitized preview record does not satisfy the frozen revision snapshot contract.",
  });
}

export function buildConfirmedPrivacyAggregateDraft(input: Readonly<{
  candidate: FinalizedReviewCandidate;
  revisionSalt: Uint8Array;
}>): ConfirmedPrivacyAggregateDraft {
  if (input.revisionSalt.byteLength !== 32) {
    throw new ConfirmationRuntimeError({
      code: "INVALID_REVISION_SALT",
      stage: "BUILD",
      safeCategory: "INVALID_INPUT",
      safeMessage: "Audit revision salt must contain exactly 32 bytes.",
    });
  }
  if (input.candidate.mapping_plan.audit_id !== input.candidate.audit_id) {
    throw new ConfirmationRuntimeError({ code: "REVISION_INPUT_INVALID", stage: "BUILD", safeCategory: "INVALID_INPUT", safeMessage: "Review candidate audit identity is inconsistent." });
  }
  assertMappingSnapshotMatchesVault(input.candidate.revision_mapping_snapshot, input.candidate.local_mapping_vault);
  const snapshots = input.candidate.sanitized_preview_records.map(previewToRevisionRecordSnapshot);
  if (snapshots.length < 1) throw invalidRecord();

  const privacyRevisionId = computePrivacyRevisionId({
    revision_salt: input.revisionSalt,
    records: snapshots,
    mappings: input.candidate.revision_mapping_snapshot,
  });

  const paired = snapshots.map((snapshot): SanitizedCanonicalRecordRevision => Object.freeze({
    record_revision_id: computeRecordRevisionId({ privacy_revision_id: privacyRevisionId, record: snapshot }),
    audit_id: input.candidate.audit_id,
    record_id: snapshot.record_id,
    privacy_revision_id: privacyRevisionId,
    source_type: snapshot.source_type,
    source_name: snapshot.source_name,
    author: snapshot.author,
    timestamp: snapshot.timestamp,
    sanitized_content: snapshot.sanitized_content,
    sequence: snapshot.sequence,
  }));
  paired.sort((a, b) => a.sequence - b.sequence || compareUnicodeCodePoints(a.record_id, b.record_id));

  const mappings = adaptLocalVaultToPrivacyMappings({
    auditId: input.candidate.audit_id,
    privacyRevisionId,
    vault: input.candidate.local_mapping_vault,
  });
  return Object.freeze({
    audit_id: input.candidate.audit_id,
    privacy_revision_id: privacyRevisionId,
    records: Object.freeze(paired),
    mappings,
    record_count: paired.length,
    mapping_count: mappings.length,
  });
}
