import {
  EvidenceTypeSchema,
  RecordRevisionIdSchema,
  ReportVersionIdSchema,
} from "../../domain/schemas/base.js";
import { EvidenceSchema } from "../../domain/schemas/evidence.js";
import { computeEvidenceId } from "../../shared/ids/index.js";
import type { RecordRevisionId, ReportVersionId } from "../../shared/ids/types.js";
import type {
  BuiltLocalEvidence,
  LocalAcceptedEvidence,
  ProviderEvidenceAssertion,
  ProviderReferenceAuthorityPort,
  ProviderTrustContext,
} from "../contracts.js";
import { ProviderTrustError } from "./errors.js";
import { validateRecordRevisionReference } from "./reference-validation.js";

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function isReportVersionId(value: string): value is ReportVersionId {
  return ReportVersionIdSchema.safeParse(value).success;
}

function isRecordRevisionId(value: string): value is RecordRevisionId {
  return RecordRevisionIdSchema.safeParse(value).success;
}

export function splitsUtf16SurrogatePair(text: string, index: number): boolean {
  if (index <= 0 || index >= text.length) {
    return false;
  }

  return (
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

export async function buildLocalAcceptedEvidence(input: Readonly<{
  assertion: ProviderEvidenceAssertion;
  context: ProviderTrustContext;
  authority: ProviderReferenceAuthorityPort;
}>): Promise<BuiltLocalEvidence> {
  const { assertion, context, authority } = input;

  if (
    !Number.isInteger(assertion.char_start) ||
    !Number.isInteger(assertion.char_end) ||
    assertion.char_start < 0 ||
    assertion.char_end <= assertion.char_start
  ) {
    throw new ProviderTrustError("EXCERPT_RANGE_INVALID");
  }

  const record = await validateRecordRevisionReference(
    assertion.record_revision_id,
    context,
    authority,
  );

  const source = record.sanitized_content;

  if (assertion.char_end > source.length) {
    throw new ProviderTrustError("EXCERPT_RANGE_INVALID");
  }

  if (
    splitsUtf16SurrogatePair(source, assertion.char_start) ||
    splitsUtf16SurrogatePair(source, assertion.char_end)
  ) {
    throw new ProviderTrustError("UTF16_BOUNDARY_INVALID");
  }

  if (source.slice(assertion.char_start, assertion.char_end) !== assertion.excerpt) {
    throw new ProviderTrustError("EXCERPT_MISMATCH");
  }

  const evidenceTypeParsed = EvidenceTypeSchema.safeParse(assertion.evidence_type);
  if (!evidenceTypeParsed.success) {
    throw new ProviderTrustError("SCHEMA_INVALID");
  }

  if (!isReportVersionId(context.report_version_id)) {
    throw new ProviderTrustError("INTERNAL_VALIDATION_FAILURE");
  }

  if (!isRecordRevisionId(record.record_revision_id)) {
    throw new ProviderTrustError("INTERNAL_VALIDATION_FAILURE");
  }

  const reportVersionId = context.report_version_id;
  const recordRevisionId = record.record_revision_id;

  const evidenceId = computeEvidenceId({
    report_version_id: reportVersionId,
    record_revision_id: recordRevisionId,
    char_start: assertion.char_start,
    char_end: assertion.char_end,
    evidence_type: evidenceTypeParsed.data,
  });

  const evidenceCandidate = {
    evidence_id: evidenceId,
    report_version_id: reportVersionId,
    privacy_revision_id: context.privacy_revision_id,
    record_id: record.record_id,
    record_revision_id: recordRevisionId,
    source_ref: {
      source_name: record.source_name,
      sequence: record.sequence,
      char_start: assertion.char_start,
      char_end: assertion.char_end,
    },
    excerpt: assertion.excerpt,
    actor: null,
    timestamp: null,
    evidence_type: evidenceTypeParsed.data,
    epistemic_status: "FACT" as const,
    fact_scope: "SOURCE_FACT" as const,
  };

  let evidenceParsed: ReturnType<typeof EvidenceSchema.safeParse>;
  try {
    evidenceParsed = EvidenceSchema.safeParse(evidenceCandidate);
  } catch {
    throw new ProviderTrustError("INTERNAL_VALIDATION_FAILURE");
  }

  if (!evidenceParsed.success) {
    throw new ProviderTrustError("INTERNAL_VALIDATION_FAILURE");
  }

  const evidence: LocalAcceptedEvidence = Object.freeze({
    ...evidenceParsed.data,
    source_ref: Object.freeze({ ...evidenceParsed.data.source_ref }),
    actor: null,
    timestamp: null,
    epistemic_status: "FACT" as const,
    fact_scope: "SOURCE_FACT" as const,
  });

  return Object.freeze({
    kind: "LOCAL_ACCEPTED_EVIDENCE" as const,
    evidence,
    provenance: Object.freeze({
      actor: "IGNORED_PROVIDER_ASSERTION" as const,
      timestamp: "IGNORED_PROVIDER_ASSERTION" as const,
      evidence_type: "LOCAL_ACCEPTED_DERIVED_CLASSIFICATION" as const,
      fact_semantics: "SOURCE_SUPPORTED_NOT_REAL_WORLD_TRUTH" as const,
    }),
  });
}
