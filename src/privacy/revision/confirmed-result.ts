import type { SafeConfirmationResult } from "./types.js";

export function createSafeConfirmationResult(input: SafeConfirmationResult): SafeConfirmationResult {
  return Object.freeze({
    audit_id: input.audit_id,
    privacy_revision_id: input.privacy_revision_id,
    record_count: input.record_count,
    mapping_count: input.mapping_count,
    confirmed_at: input.confirmed_at,
    idempotent: input.idempotent,
  });
}
