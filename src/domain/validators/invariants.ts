import type { SanitizedCanonicalRecordRevision } from "../schemas/canonical.js";
import type { Commitment } from "../schemas/commitment.js";
import type { PotentialConflict } from "../schemas/conflict.js";
import type { Evidence } from "../schemas/evidence.js";
import type { RequirementDecisionChange } from "../schemas/change.js";
import { SanitizedCanonicalRecordRevisionSchema } from "../schemas/canonical.js";

export type DomainInvariantCode =
  | "EVIDENCE_SOURCE_MISMATCH"
  | "EVIDENCE_SPAN_OUT_OF_RANGE"
  | "EVIDENCE_EXCERPT_MISMATCH"
  | "CONFIRMED_COMMITMENT_WITHOUT_EVIDENCE"
  | "FULFILLED_COMMITMENT_WITHOUT_COMPLETION_EVIDENCE"
  | "CONFIRMED_CHANGE_WITHOUT_EVIDENCE"
  | "CONFLICT_FACT_FORBIDDEN"
  | "SANITIZED_RECORD_CONTRACT_INVALID";

export type DomainInvariantResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: DomainInvariantCode; message: string }>;

const PASS: DomainInvariantResult = { ok: true };

export function validateEvidenceExcerpt(
  record: SanitizedCanonicalRecordRevision,
  evidence: Evidence,
): DomainInvariantResult {
  if (
    evidence.record_id !== record.record_id ||
    evidence.record_revision_id !== record.record_revision_id ||
    evidence.privacy_revision_id !== record.privacy_revision_id ||
    evidence.source_ref.source_name !== record.source_name ||
    evidence.source_ref.sequence !== record.sequence
  ) {
    return {
      ok: false,
      code: "EVIDENCE_SOURCE_MISMATCH",
      message: "Evidence source identity does not match the sanitized record revision.",
    };
  }

  const { char_start: start, char_end: end } = evidence.source_ref;
  if (start < 0 || end <= start || end > record.sanitized_content.length) {
    return {
      ok: false,
      code: "EVIDENCE_SPAN_OUT_OF_RANGE",
      message: "Evidence character span is outside the sanitized source record.",
    };
  }

  if (record.sanitized_content.slice(start, end) !== evidence.excerpt) {
    return {
      ok: false,
      code: "EVIDENCE_EXCERPT_MISMATCH",
      message: "Evidence excerpt must exactly equal the cited sanitized source substring.",
    };
  }

  return PASS;
}

export function validateCommitmentInvariants(commitment: Commitment): DomainInvariantResult {
  if (commitment.classification === "CONFIRMED" && commitment.evidence_ids.length === 0) {
    return {
      ok: false,
      code: "CONFIRMED_COMMITMENT_WITHOUT_EVIDENCE",
      message: "Confirmed commitment requires Evidence.",
    };
  }

  if (commitment.lifecycle_status === "FULFILLED" && commitment.status_evidence_ids.length === 0) {
    return {
      ok: false,
      code: "FULFILLED_COMMITMENT_WITHOUT_COMPLETION_EVIDENCE",
      message: "FULFILLED commitment requires completion/status Evidence.",
    };
  }

  return PASS;
}

export function validateChangeInvariants(change: RequirementDecisionChange): DomainInvariantResult {
  if (change.classification === "CONFIRMED" && change.evidence_ids.length === 0) {
    return {
      ok: false,
      code: "CONFIRMED_CHANGE_WITHOUT_EVIDENCE",
      message: "Confirmed requirement/decision change requires Evidence.",
    };
  }
  return PASS;
}

export function validatePotentialConflictInvariants(
  conflict: PotentialConflict,
): DomainInvariantResult {
  if ((conflict.epistemic_status as string) === "FACT") {
    return {
      ok: false,
      code: "CONFLICT_FACT_FORBIDDEN",
      message: "Potential conflict cannot use FACT epistemic status.",
    };
  }
  return PASS;
}

export function validateSanitizedRecordContract(value: unknown): DomainInvariantResult {
  const result = SanitizedCanonicalRecordRevisionSchema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      code: "SANITIZED_RECORD_CONTRACT_INVALID",
      message: "Value is not a valid sanitized canonical record revision.",
    };
  }
  return PASS;
}
