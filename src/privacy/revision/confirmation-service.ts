import { PersistenceError } from "../../db/persistence-errors.js";
import { compareUnicodeCodePoints, stableCanonicalSerialize } from "../../shared/ids/stable-serialization.js";
import { validateCandidateFreshness } from "./candidate-freshness.js";
import { PerAuditConfirmationLock } from "./confirmation-lock.js";
import { createSafeConfirmationResult } from "./confirmed-result.js";
import { ConfirmationRuntimeError, staleCandidateError, toSafeConfirmationError } from "./errors.js";
import { buildConfirmedPrivacyAggregateDraft } from "./revision-builder.js";
import type {
  CandidateContextProvider,
  ConfirmationClock,
  ConfirmationRepositoryPort,
  ConfirmedPrivacyAggregateDraft,
  FinalizedReviewCandidate,
  SafeConfirmationResult,
} from "./types.js";

const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function revisionProjection(draft: ConfirmedPrivacyAggregateDraft) {
  return {
    audit_id: draft.audit_id,
    privacy_revision_id: draft.privacy_revision_id,
    algorithm: "privacy-revision-v1",
    record_count: draft.record_count,
    mapping_count: draft.mapping_count,
  };
}

function normalizeRecords(records: readonly Record<string, unknown>[]) {
  return [...records].sort((a, b) => {
    const sequence = Number(a.sequence) - Number(b.sequence);
    if (sequence !== 0) return sequence;
    return compareUnicodeCodePoints(String(a.record_id), String(b.record_id));
  });
}

function normalizeMappings(mappings: readonly Record<string, unknown>[]) {
  return [...mappings].sort((a, b) =>
    compareUnicodeCodePoints(String(a.entity_type), String(b.entity_type)) ||
    compareUnicodeCodePoints(String(a.placeholder), String(b.placeholder)) ||
    compareUnicodeCodePoints(String(a.mapping_id), String(b.mapping_id)),
  );
}

function assertExistingMatchesDraft(existing: Awaited<ReturnType<ConfirmationRepositoryPort["getConfirmedPrivacyAggregateLocal"]>>, draft: ConfirmedPrivacyAggregateDraft): void {
  const existingRevision = {
    audit_id: existing.revision.audit_id,
    privacy_revision_id: existing.revision.privacy_revision_id,
    algorithm: existing.revision.algorithm,
    record_count: existing.revision.record_count,
    mapping_count: existing.revision.mapping_count,
  };
  const sameRevision = stableCanonicalSerialize(existingRevision) === stableCanonicalSerialize(revisionProjection(draft));
  const sameRecords = stableCanonicalSerialize(normalizeRecords(existing.records as unknown as readonly Record<string, unknown>[])) === stableCanonicalSerialize(normalizeRecords(draft.records as unknown as readonly Record<string, unknown>[]));
  const sameMappings = stableCanonicalSerialize(normalizeMappings(existing.mappings as unknown as readonly Record<string, unknown>[])) === stableCanonicalSerialize(normalizeMappings(draft.mappings as unknown as readonly Record<string, unknown>[]));
  if (!sameRevision || !sameRecords || !sameMappings) {
    throw new ConfirmationRuntimeError({
      code: "IMMUTABILITY_VIOLATION",
      stage: "PERSISTENCE",
      safeCategory: "INTEGRITY",
      safeMessage: "Existing privacy revision identity has different immutable content.",
    });
  }
}

async function tryReadExisting(repository: ConfirmationRepositoryPort, privacyRevisionId: string) {
  try {
    return await repository.getConfirmedPrivacyAggregateLocal(privacyRevisionId);
  } catch (error: unknown) {
    if (error instanceof PersistenceError && error.code === "PERSISTENCE_NOT_FOUND") return undefined;
    throw error;
  }
}

function validateUtcClock(value: string): void {
  if (!UTC_MILLIS.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new ConfirmationRuntimeError({
      code: "INVALID_CONFIRMATION_CLOCK",
      stage: "BUILD",
      safeCategory: "INVALID_INPUT",
      safeMessage: "Confirmation clock must return UTC ISO time with milliseconds.",
    });
  }
}

export class PrivacyConfirmationService {
  constructor(
    private readonly repository: ConfirmationRepositoryPort,
    private readonly lock: PerAuditConfirmationLock = new PerAuditConfirmationLock(),
    private readonly clock: ConfirmationClock = () => new Date().toISOString(),
  ) {}

  async confirm(input: Readonly<{
    candidate: FinalizedReviewCandidate;
    revisionSalt: Uint8Array;
    currentContext: CandidateContextProvider;
  }>): Promise<SafeConfirmationResult> {
    return this.lock.runExclusive(input.candidate.audit_id, async () => {
      try {
        const context = await input.currentContext();
        const freshness = validateCandidateFreshness(input.candidate, context);
        if (freshness.status === "STALE") throw staleCandidateError(freshness.reason);

        const draft = buildConfirmedPrivacyAggregateDraft({
          candidate: input.candidate,
          revisionSalt: input.revisionSalt,
        });

        const existing = await tryReadExisting(this.repository, draft.privacy_revision_id);
        if (existing) {
          assertExistingMatchesDraft(existing, draft);
          return createSafeConfirmationResult({
            audit_id: draft.audit_id,
            privacy_revision_id: draft.privacy_revision_id,
            record_count: draft.record_count,
            mapping_count: draft.mapping_count,
            confirmed_at: existing.revision.confirmed_at,
            idempotent: true,
          });
        }

        const confirmedAt = this.clock();
        validateUtcClock(confirmedAt);
        const write = await this.repository.saveConfirmedPrivacyAggregate({
          revision: {
            privacy_revision_id: draft.privacy_revision_id,
            audit_id: draft.audit_id,
            confirmation_state: "CONFIRMED",
            algorithm: "privacy-revision-v1",
            confirmed_at: confirmedAt,
            record_count: draft.record_count,
            mapping_count: draft.mapping_count,
          },
          records: draft.records,
          mappings: draft.mappings,
        });

        return createSafeConfirmationResult({
          audit_id: draft.audit_id,
          privacy_revision_id: draft.privacy_revision_id,
          record_count: draft.record_count,
          mapping_count: draft.mapping_count,
          confirmed_at: write.value.revision.confirmed_at,
          idempotent: write.outcome === "IDEMPOTENT_EXISTING",
        });
      } catch (error: unknown) {
        if (error instanceof ConfirmationRuntimeError) throw error;
        throw toSafeConfirmationError(error, "PERSISTENCE");
      }
    });
  }
}
