import { createHash } from "node:crypto";

import { compareUnicodeCodePoints, stableCanonicalSerialize } from "./stable-serialization.js";
import type {
  AuditId,
  EvidenceId,
  EvidenceIdentityInput,
  PrivacyRevisionId,
  RecordId,
  RecordRevisionId,
  RevisionMappingSnapshot,
  RevisionRecordSnapshot,
} from "./types.js";

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestBase64Url(parts: readonly (string | Uint8Array)[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    if (typeof part === "string") {
      hash.update(part, "utf8");
    } else {
      hash.update(part);
    }
  }
  return hash.digest("base64url");
}

export function createJsonRecordId(input: Readonly<{
  audit_id: AuditId;
  source_name: string;
  external_record_id: string;
}>): RecordId {
  const digest = sha256Hex(
    `record-logical-v1${input.audit_id}${input.source_name}${input.external_record_id}`,
  ).slice(0, 32);
  return `rec_${digest}`;
}

export function toRecordRevisionTuple(record: RevisionRecordSnapshot): readonly [
  RecordId,
  RevisionRecordSnapshot["source_type"],
  string,
  string | null,
  string | null,
  string,
  number,
] {
  return [
    record.record_id,
    record.source_type,
    record.source_name,
    record.author,
    record.timestamp,
    record.sanitized_content,
    record.sequence,
  ] as const;
}

function toMappingRevisionTuple(mapping: RevisionMappingSnapshot): readonly [
  RevisionMappingSnapshot["entity_type"],
  string,
  string,
  readonly string[],
  boolean,
] {
  const aliases = [...mapping.aliases].sort(compareUnicodeCodePoints);
  return [
    mapping.entity_type,
    mapping.placeholder,
    mapping.normalized_original_value,
    aliases,
    mapping.active,
  ] as const;
}

function serializePrivacySnapshot(
  records: readonly RevisionRecordSnapshot[],
  mappings: readonly RevisionMappingSnapshot[],
): string {
  const sortedRecords = [...records]
    .sort((left, right) => {
      const sequenceDifference = left.sequence - right.sequence;
      return sequenceDifference !== 0
        ? sequenceDifference
        : compareUnicodeCodePoints(left.record_id, right.record_id);
    })
    .map(toRecordRevisionTuple);

  const sortedMappings = [...mappings]
    .sort((left, right) => {
      const entityDifference = compareUnicodeCodePoints(left.entity_type, right.entity_type);
      return entityDifference !== 0
        ? entityDifference
        : compareUnicodeCodePoints(left.placeholder, right.placeholder);
    })
    .map(toMappingRevisionTuple);

  // The wrapper key order is explicitly frozen by P2C; tuple contents use the
  // one shared stable serializer. This avoids relying on arbitrary object order.
  return `{"version":"privacy-snapshot-v1","records":${stableCanonicalSerialize(sortedRecords)},"mappings":${stableCanonicalSerialize(sortedMappings)}}`;
}

export function computePrivacyRevisionId(input: Readonly<{
  revision_salt: Uint8Array;
  records: readonly RevisionRecordSnapshot[];
  mappings: readonly RevisionMappingSnapshot[];
}>): PrivacyRevisionId {
  if (input.revision_salt.byteLength !== 32) {
    throw new RangeError("revision_salt must contain exactly 32 bytes.");
  }

  const snapshot = serializePrivacySnapshot(input.records, input.mappings);
  const digest = digestBase64Url([
    "privacy-revision-v1\0",
    input.revision_salt,
    "\0",
    snapshot,
  ]);
  return `prv_${digest}`;
}

export function computeRecordRevisionId(input: Readonly<{
  privacy_revision_id: PrivacyRevisionId;
  record: RevisionRecordSnapshot;
}>): RecordRevisionId {
  const tuple = stableCanonicalSerialize(toRecordRevisionTuple(input.record));
  const digest = digestBase64Url([
    "record-revision-v1\0",
    input.privacy_revision_id,
    "\0",
    tuple,
  ]);
  return `rr_${digest}`;
}

export function computeEvidenceId(input: EvidenceIdentityInput): EvidenceId {
  if (!Number.isInteger(input.char_start) || input.char_start < 0) {
    throw new RangeError("char_start must be a non-negative integer.");
  }
  if (!Number.isInteger(input.char_end) || input.char_end <= input.char_start) {
    throw new RangeError("char_end must be an integer greater than char_start.");
  }

  const digest = digestBase64Url([
    "evidence-v1\0",
    input.report_version_id,
    "\0",
    input.record_revision_id,
    "\0",
    String(input.char_start),
    "\0",
    String(input.char_end),
    "\0",
    input.evidence_type,
  ]);
  return `ev_${digest}`;
}
