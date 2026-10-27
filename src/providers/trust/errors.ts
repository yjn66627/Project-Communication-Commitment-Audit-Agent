export type ProviderTrustErrorCode =
  | "SCHEMA_INVALID"
  | "REFERENCE_NOT_FOUND"
  | "REFERENCE_CONTEXT_MISMATCH"
  | "EXCERPT_RANGE_INVALID"
  | "EXCERPT_MISMATCH"
  | "UTF16_BOUNDARY_INVALID"
  | "UNSAFE_RESPONSE_CONTENT"
  | "INTERNAL_VALIDATION_FAILURE";

export class ProviderTrustError extends Error {
  readonly code: ProviderTrustErrorCode;

  constructor(code: ProviderTrustErrorCode) {
    super("Provider response trust validation failed.");
    this.name = "ProviderTrustError";
    this.code = code;
  }
}

export function isProviderTrustError(value: unknown): value is ProviderTrustError {
  return value instanceof ProviderTrustError;
}
