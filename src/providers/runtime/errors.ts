export type ProviderTransportErrorCode =
  | "CONFIG_MISSING"
  | "CONFIG_INVALID"
  | "EGRESS_DENIED"
  | "INVALID_EGRESS_PAYLOAD"
  | "WIRE_CONTRACT_UNSUPPORTED"
  | "HTTP_BAD_REQUEST"
  | "AUTHENTICATION_FAILED"
  | "REQUEST_TIMEOUT"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "HTTP_ERROR"
  | "NETWORK_FAILURE"
  | "INVALID_CONTENT_TYPE"
  | "RESPONSE_TOO_LARGE"
  | "MALFORMED_ENVELOPE"
  | "EMPTY_CONTENT"
  | "MESSAGE_JSON_INVALID";

export class ProviderTransportError extends Error {
  readonly code: ProviderTransportErrorCode;

  constructor(code: ProviderTransportErrorCode) {
    super("Provider runtime request failed.");
    this.name = "ProviderTransportError";
    this.code = code;
  }

  toJSON(): Readonly<{ name: string; code: ProviderTransportErrorCode }> {
    return Object.freeze({ name: this.name, code: this.code });
  }
}

export function isProviderTransportError(value: unknown): value is ProviderTransportError {
  return value instanceof ProviderTransportError;
}
