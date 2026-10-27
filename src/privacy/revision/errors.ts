import { PersistenceError, type PersistenceErrorCode } from "../../db/persistence-errors.js";
import type { SafeInvalidationReason } from "./types.js";

export type ConfirmationStage = "FRESHNESS" | "BUILD" | "PERSISTENCE";
export type ConfirmationSafeCategory = "STALE_CANDIDATE" | "INVALID_INPUT" | "INTEGRITY" | "PERSISTENCE" | "INTERNAL";
export type ConfirmationRuntimeErrorCode =
  | "CANDIDATE_STALE"
  | "REVISION_INPUT_INVALID"
  | "MAPPING_SNAPSHOT_MISMATCH"
  | "SECRET_MAPPING_FORBIDDEN"
  | "INVALID_REVISION_SALT"
  | "INVALID_CONFIRMATION_CLOCK"
  | "CONFIRMATION_FAILED"
  | PersistenceErrorCode;

export class ConfirmationRuntimeError extends Error {
  readonly code: ConfirmationRuntimeErrorCode;
  readonly stage: ConfirmationStage;
  readonly safe_category: ConfirmationSafeCategory;
  readonly invalidation_reason?: SafeInvalidationReason;

  constructor(input: Readonly<{
    code: ConfirmationRuntimeErrorCode;
    stage: ConfirmationStage;
    safeCategory: ConfirmationSafeCategory;
    safeMessage: string;
    invalidationReason?: SafeInvalidationReason;
  }>) {
    super(input.safeMessage);
    this.name = "ConfirmationRuntimeError";
    this.code = input.code;
    this.stage = input.stage;
    this.safe_category = input.safeCategory;
    this.invalidation_reason = input.invalidationReason;
  }
}

export function staleCandidateError(reason: SafeInvalidationReason): ConfirmationRuntimeError {
  return new ConfirmationRuntimeError({
    code: "CANDIDATE_STALE",
    stage: "FRESHNESS",
    safeCategory: "STALE_CANDIDATE",
    safeMessage: "Privacy review candidate is stale or unavailable.",
    invalidationReason: reason,
  });
}

export function toSafeConfirmationError(
  error: unknown,
  stage: ConfirmationStage,
): ConfirmationRuntimeError {
  if (error instanceof ConfirmationRuntimeError) return error;
  if (error instanceof PersistenceError) {
    return new ConfirmationRuntimeError({
      code: error.code,
      stage,
      safeCategory: error.code === "IMMUTABILITY_VIOLATION" ? "INTEGRITY" : "PERSISTENCE",
      safeMessage: "Privacy confirmation persistence operation failed safely.",
    });
  }
  return new ConfirmationRuntimeError({
    code: "CONFIRMATION_FAILED",
    stage,
    safeCategory: "INTERNAL",
    safeMessage: "Privacy confirmation operation failed safely.",
  });
}
