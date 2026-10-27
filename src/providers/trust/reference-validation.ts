import type {
  ProviderReferenceAuthorityPort,
  ProviderTrustContext,
} from "../contracts.js";
import { ProviderTrustError } from "./errors.js";

function assertNoDuplicates(values: readonly string[]): void {
  if (new Set(values).size !== values.length) {
    throw new ProviderTrustError("REFERENCE_CONTEXT_MISMATCH");
  }
}

export async function validateRecordRevisionReference(
  recordRevisionId: string,
  context: ProviderTrustContext,
  authority: ProviderReferenceAuthorityPort,
) {
  const record = await authority.resolveRecordRevision(recordRevisionId);
  if (record === null) {
    throw new ProviderTrustError("REFERENCE_NOT_FOUND");
  }

  if (
    record.audit_id !== context.audit_id ||
    record.privacy_revision_id !== context.privacy_revision_id ||
    !context.allowed_record_revision_ids.has(recordRevisionId)
  ) {
    throw new ProviderTrustError("REFERENCE_CONTEXT_MISMATCH");
  }

  return record;
}

export async function validateEvidenceReferences(
  evidenceIds: readonly string[],
  context: ProviderTrustContext,
  authority: ProviderReferenceAuthorityPort,
): Promise<void> {
  assertNoDuplicates(evidenceIds);

  for (const evidenceId of evidenceIds) {
    const reference = await authority.resolveEvidenceReference(evidenceId);
    if (reference === null) {
      throw new ProviderTrustError("REFERENCE_NOT_FOUND");
    }

    if (
      reference.audit_id !== context.audit_id ||
      reference.report_version_id !== context.report_version_id ||
      !context.allowed_evidence_ids.has(evidenceId)
    ) {
      throw new ProviderTrustError("REFERENCE_CONTEXT_MISMATCH");
    }
  }
}

export async function validateDomainReferences(
  domainIds: readonly string[],
  context: ProviderTrustContext,
  authority: ProviderReferenceAuthorityPort,
): Promise<void> {
  assertNoDuplicates(domainIds);

  for (const domainId of domainIds) {
    const reference = await authority.resolveDomainReference(domainId);
    if (reference === null) {
      throw new ProviderTrustError("REFERENCE_NOT_FOUND");
    }

    if (
      reference.audit_id !== context.audit_id ||
      reference.report_version_id !== context.report_version_id ||
      !context.allowed_domain_ids.has(domainId)
    ) {
      throw new ProviderTrustError("REFERENCE_CONTEXT_MISMATCH");
    }
  }
}

export async function validateProviderReferences(
  value: unknown,
  context: ProviderTrustContext,
  authority: ProviderReferenceAuthorityPort,
): Promise<void> {
  const visited = new WeakSet<object>();

  async function visit(current: unknown): Promise<void> {
    if (current === null || typeof current !== "object") {
      return;
    }

    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        await visit(item);
      }
      return;
    }

    const record = current as Record<string, unknown>;

    if (typeof record.record_revision_id === "string") {
      await validateRecordRevisionReference(
        record.record_revision_id,
        context,
        authority,
      );
    }

    for (const key of ["evidence_ids", "counter_evidence_ids", "known_evidence_ids"] as const) {
      const candidate = record[key];
      if (Array.isArray(candidate) && candidate.every((item) => typeof item === "string")) {
        await validateEvidenceReferences(candidate, context, authority);
      }
    }

    const domainIds = record.domain_ids;
    if (Array.isArray(domainIds) && domainIds.every((item) => typeof item === "string")) {
      await validateDomainReferences(domainIds, context, authority);
    }

    for (const nested of Object.values(record)) {
      await visit(nested);
    }
  }

  await visit(value);
}
