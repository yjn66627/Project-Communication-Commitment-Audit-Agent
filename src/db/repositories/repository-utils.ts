import { isDeepStrictEqual } from "node:util";

import {
  normalizePersistenceError,
  PersistenceError,
  type PersistenceErrorCode,
} from "../persistence-errors.js";
import { PersistenceBoundaryError } from "../persistence/persistence-types.js";

export function semanticEqual(left: unknown, right: unknown): boolean {
  return isDeepStrictEqual(left, right);
}

/**
 * Bridges CP-3B boundary errors into the single CP-3C1 persistence error
 * contract without copying lower-level messages or sensitive values.
 */
export function toRepositoryError(
  error: unknown,
  fallbackCode: PersistenceErrorCode,
  safeMessage: string,
): PersistenceError {
  if (error instanceof PersistenceError) {
    return error;
  }

  if (error instanceof PersistenceBoundaryError) {
    return new PersistenceError(error.code, safeMessage);
  }

  return normalizePersistenceError(error, fallbackCode, safeMessage);
}

export type RepositoryWriteOutcome = "INSERTED" | "IDEMPOTENT_EXISTING";

export type RepositoryWriteResult<T> = Readonly<{
  outcome: RepositoryWriteOutcome;
  value: T;
}>;
