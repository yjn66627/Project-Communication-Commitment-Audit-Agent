export const PERSISTENCE_ERROR_CODES = [
  "PERSISTENCE_NOT_FOUND",
  "PERSISTENCE_INTEGRITY_ERROR",
  "IMMUTABILITY_VIOLATION",
  "FOREIGN_KEYS_DISABLED",
  "TRANSACTION_FAILED",
  "JSON_CODEC_ERROR",
  "DOMAIN_VALIDATION_ERROR",
  "CONFLICTING_EXISTING_ROW",
] as const;

export type PersistenceErrorCode = (typeof PERSISTENCE_ERROR_CODES)[number];

/**
 * Safe persistence-layer error. Messages must be caller-supplied, bounded,
 * and must never interpolate local privacy material, source content, provider
 * payloads, credentials, or Authorization data.
 */
export class PersistenceError extends Error {
  readonly code: PersistenceErrorCode;

  constructor(code: PersistenceErrorCode, safeMessage: string) {
    super(safeMessage);
    this.name = "PersistenceError";
    this.code = code;
  }
}

/**
 * Converts an unknown lower-level failure to a safe persistence error without
 * copying the original error message or payload into the returned error.
 */
export function normalizePersistenceError(
  error: unknown,
  fallbackCode: PersistenceErrorCode,
  safeMessage: string,
): PersistenceError {
  if (error instanceof PersistenceError) {
    return error;
  }

  return new PersistenceError(fallbackCode, safeMessage);
}
