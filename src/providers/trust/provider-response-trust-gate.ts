import { noteProviderDiagnosticPhase, noteProviderSchemaFailure } from "../runtime/openai-compatible-transport.js";
import { detectSecrets } from "../../privacy/detection/rules/secret.js";
import { detectUrls } from "../../privacy/detection/rules/url.js";
import type {
  ProviderReferenceAuthorityPort,
  ProviderTrustContext,
  ProviderWireSchema,
  ValidatedProviderAssertion,
} from "../contracts.js";
import {
  isProviderTrustError,
  ProviderTrustError,
} from "./errors.js";
import { validateProviderReferences } from "./reference-validation.js";

const SECURITY_SCAN_RECORD_ID = "rec_provider_response_security_scan";
const SECURITY_SCAN_SURFACE = "CONTENT" as const;

function deepFreezeJsonLike<T>(value: T, visited = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const objectValue = value as object;
  if (visited.has(objectValue)) {
    return value;
  }
  visited.add(objectValue);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreezeJsonLike(item, visited);
    }
  } else {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreezeJsonLike(nested, visited);
    }
  }

  Object.freeze(objectValue);
  return value;
}

function collectStringLeaves(value: unknown): string[] {
  const leaves: string[] = [];
  const visited = new WeakSet<object>();

  function visit(current: unknown): void {
    if (typeof current === "string") {
      leaves.push(current);
      return;
    }

    if (current === null || typeof current !== "object") {
      return;
    }

    if (visited.has(current)) {
      return;
    }
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item);
      }
      return;
    }

    for (const nested of Object.values(current as Record<string, unknown>)) {
      visit(nested);
    }
  }

  visit(value);
  return leaves;
}

export function assertProviderResponseSecuritySafe(value: unknown): void {
  try {
    for (const text of collectStringLeaves(value)) {
      if (
        detectSecrets(SECURITY_SCAN_RECORD_ID, SECURITY_SCAN_SURFACE, text).length > 0 ||
        detectUrls(SECURITY_SCAN_RECORD_ID, SECURITY_SCAN_SURFACE, text).credentialSecrets.length > 0
      ) {
        throw new ProviderTrustError("UNSAFE_RESPONSE_CONTENT");
      }
    }
  } catch (error) {
    if (isProviderTrustError(error)) {
      throw error;
    }
    throw new ProviderTrustError("INTERNAL_VALIDATION_FAILURE");
  }
}

export function parseProviderWireResponse<T>(
  schema: ProviderWireSchema<T>,
  rawResponse: unknown,
): T {
  try {
    noteProviderDiagnosticPhase("TRUST_SCHEMA");
    const parsed = schema.safeParse(rawResponse);
    if (!parsed.success) {
      noteProviderSchemaFailure(parsed.error.issues, rawResponse);
      throw new ProviderTrustError("SCHEMA_INVALID");
    }
    return parsed.data;
  } catch (error) {
    if (isProviderTrustError(error)) {
      throw error;
    }
    throw new ProviderTrustError("INTERNAL_VALIDATION_FAILURE");
  }
}

export async function trustProviderResponse<T>(input: Readonly<{
  schema: ProviderWireSchema<T>;
  raw_response: unknown;
  context: ProviderTrustContext;
  authority: ProviderReferenceAuthorityPort;
}>): Promise<ValidatedProviderAssertion<T>> {
  try {
    const parsed = parseProviderWireResponse(input.schema, input.raw_response);
    noteProviderDiagnosticPhase("TRUST_SECURITY");
    assertProviderResponseSecuritySafe(parsed);
    noteProviderDiagnosticPhase("TRUST_REFERENCE");
    await validateProviderReferences(parsed, input.context, input.authority);
    const frozenValue = deepFreezeJsonLike(parsed);
    noteProviderDiagnosticPhase("LOCAL_BUILD");

    return Object.freeze({
      kind: "VALIDATED_PROVIDER_ASSERTION" as const,
      value: frozenValue,
      provider_assertion_only: true as const,
      final_authority: false as const,
    });
  } catch (error) {
    if (isProviderTrustError(error)) {
      throw error;
    }
    throw new ProviderTrustError("INTERNAL_VALIDATION_FAILURE");
  }
}
