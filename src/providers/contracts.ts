import type { ZodType } from "zod";
import type { EvidenceType } from "../domain/schemas/base.js";
import type { Evidence } from "../domain/schemas/evidence.js";
import type { SanitizedCanonicalRecordRevision } from "../domain/schemas/canonical.js";

export type MaybePromise<T> = T | Promise<T>;

export type ProviderWireSchema<T> = ZodType<T>;

export type ReferenceAuthorityRecord = Readonly<{
  audit_id: string;
  report_version_id: string;
}>;

export type DomainReferenceAuthorityRecord = Readonly<{
  audit_id: string;
  report_version_id: string;
  kind: "COMMITMENT" | "CHANGE" | "CONFLICT";
}>;

export interface ProviderReferenceAuthorityPort {
  resolveRecordRevision(
    recordRevisionId: string,
  ): MaybePromise<SanitizedCanonicalRecordRevision | null>;

  resolveEvidenceReference(
    evidenceId: string,
  ): MaybePromise<ReferenceAuthorityRecord | null>;

  resolveDomainReference(
    domainId: string,
  ): MaybePromise<DomainReferenceAuthorityRecord | null>;
}

export type ProviderTrustContext = Readonly<{
  audit_id: string;
  report_version_id: string;
  privacy_revision_id: string;
  allowed_record_revision_ids: ReadonlySet<string>;
  allowed_evidence_ids: ReadonlySet<string>;
  allowed_domain_ids: ReadonlySet<string>;
}>;

export type ProviderEvidenceAssertion = Readonly<{
  record_revision_id: string;
  char_start: number;
  char_end: number;
  excerpt: string;
  actor: string | null;
  timestamp: string | null;
  evidence_type: EvidenceType;
}>;

export type LocalAcceptedEvidence = Readonly<
  Evidence & {
    actor: null;
    timestamp: null;
    epistemic_status: "FACT";
    fact_scope: "SOURCE_FACT";
  }
>;

export type BuiltLocalEvidence = Readonly<{
  kind: "LOCAL_ACCEPTED_EVIDENCE";
  evidence: LocalAcceptedEvidence;
  provenance: Readonly<{
    actor: "IGNORED_PROVIDER_ASSERTION";
    timestamp: "IGNORED_PROVIDER_ASSERTION";
    evidence_type: "LOCAL_ACCEPTED_DERIVED_CLASSIFICATION";
    fact_semantics: "SOURCE_SUPPORTED_NOT_REAL_WORLD_TRUTH";
  }>;
}>;

export type ValidatedProviderAssertion<T> = Readonly<{
  kind: "VALIDATED_PROVIDER_ASSERTION";
  value: T;
  provider_assertion_only: true;
  final_authority: false;
}>;
