import { ZodError } from "zod";
import { ApplicationError } from "../../application/errors.js";
import { PersistenceError } from "../../db/persistence-errors.js";
import { PersistenceBoundaryError } from "../../db/persistence/persistence-types.js";
import { ReviewRuntimeError } from "../../privacy/review/types.js";
import { ConfirmationRuntimeError } from "../../privacy/revision/errors.js";
import { ProviderTransportError } from "../../providers/runtime/errors.js";
import type { SafeRunFailureCategory } from "../../application/runs/four-family-run-ports.js";
import { ReportDigestConflictError, ReportLifecycleConflictError } from "../../application/reports/report-application-facade.js";
import { BoundedJsonError } from "./bounded-json.js";
import { HttpBoundaryError } from "./local-origin-guard.js";

export type SafeHttpCode =
  | "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE" | "METHOD_NOT_ALLOWED" | "LOCAL_ACCESS_REQUIRED"
  | "AUDIT_NOT_FOUND" | "RESOURCE_NOT_FOUND" | "RUN_ALREADY_ACTIVE" | "REQUEST_CONFLICT" | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REQUEST_FAILED" | "RUN_REJECTED" | "INTERNAL_ERROR";

export type SafeHttpMapping = Readonly<{ status: number; code: SafeHttpCode; message: string }>;

export class SafeRunHttpError extends Error {
  constructor(readonly category: SafeRunFailureCategory) {
    super("The Run did not complete successfully.");
    this.name = "SafeRunHttpError";
  }
}

const RESPONSE: Readonly<Record<SafeHttpCode, Omit<SafeHttpMapping, "code">>> = Object.freeze({
  INVALID_REQUEST: { status: 400, message: "Invalid request." },
  PAYLOAD_TOO_LARGE: { status: 413, message: "Request body is too large." },
  METHOD_NOT_ALLOWED: { status: 405, message: "Method not allowed." },
  LOCAL_ACCESS_REQUIRED: { status: 403, message: "Local access is required." },
  AUDIT_NOT_FOUND: { status: 404, message: "Audit not found." },
  RESOURCE_NOT_FOUND: { status: 404, message: "Requested resource not found." },
  RUN_ALREADY_ACTIVE: { status: 409, message: "Analysis is already running." },
  REQUEST_CONFLICT: { status: 409, message: "Request conflicts with current local state." },
  PROVIDER_UNAVAILABLE: { status: 503, message: "AI provider is unavailable." },
  PROVIDER_REQUEST_FAILED: { status: 502, message: "AI provider request failed." },
  RUN_REJECTED: { status: 422, message: "AI processing could not produce a usable result." },
  INTERNAL_ERROR: { status: 500, message: "Internal application error." },
});

export function safeRunFailureMapping(category: SafeRunFailureCategory): SafeHttpMapping {
  if (category === "CONFIG_MISSING" || category === "CONFIG_INVALID") return mapping("PROVIDER_UNAVAILABLE");
  if (["PROVIDER_TRANSPORT_FAILURE", "PROVIDER_STAGE_FAILURE", "EGRESS_DENIED", "WIRE_SCHEMA_FAILURE", "TRUST_FAILURE", "REFERENCE_FAILURE", "NO_VALID_EVIDENCE"].includes(category)) return mapping("PROVIDER_REQUEST_FAILED");
  if (category === "STALE_PRIVACY" || category === "LIFECYCLE_DRIFT") return mapping("REQUEST_CONFLICT");
  return mapping("INTERNAL_ERROR");
}

export function mapSafeHttpError(error: unknown): SafeHttpMapping {
  if (error instanceof SafeRunHttpError) return safeRunFailureMapping(error.category);
  if (error instanceof ReportDigestConflictError || error instanceof ReportLifecycleConflictError) return mapping("REQUEST_CONFLICT");
  if (error instanceof HttpBoundaryError) return mapping(error.code);
  if (error instanceof BoundedJsonError) return mapping(error.code);
  if (error instanceof ZodError) return mapping("INVALID_REQUEST");

  if (error instanceof ApplicationError) {
    if (["AUDIT_NOT_FOUND"].includes(error.code)) return mapping("AUDIT_NOT_FOUND");
    if (["INVALID_AUDIT_INPUT", "INVALID_AUDIT_NAME", "INVALID_PASTE", "INVALID_CONFIRMATION", "INVALID_RUN_COMMAND"].includes(error.code)) return mapping("INVALID_REQUEST");
    if (error.code === "RUN_ALREADY_ACTIVE") return mapping("RUN_ALREADY_ACTIVE");
    if (["STORE_CLOSED", "REVIEW_UNAVAILABLE", "REVIEW_CONFIRMING"].includes(error.code)) return mapping("REQUEST_CONFLICT");
    if (error.code === "PERSISTENCE_NOT_FOUND") return mapping("RESOURCE_NOT_FOUND");
  }

  if (error instanceof ReviewRuntimeError) {
    if (["REVIEW_DETECTION_NOT_FOUND", "REVIEW_ENTITY_NOT_FOUND", "REVIEW_SEED_NOT_FOUND"].includes(error.code)) return mapping("RESOURCE_NOT_FOUND");
    if (["REVIEW_PENDING_DECISIONS", "REVIEW_SEED_ALREADY_BOUND", "REVIEW_PLACEHOLDER_RESERVED"].includes(error.code)) return mapping("REQUEST_CONFLICT");
    return mapping("INVALID_REQUEST");
  }

  if (error instanceof ConfirmationRuntimeError) {
    if (error.code === "CANDIDATE_STALE") return mapping("REQUEST_CONFLICT");
    if (error.safe_category === "INVALID_INPUT") return mapping("INVALID_REQUEST");
    return mapping("INTERNAL_ERROR");
  }

  if (error instanceof ProviderTransportError) {
    if (error.code === "CONFIG_MISSING" || error.code === "CONFIG_INVALID") return mapping("PROVIDER_UNAVAILABLE");
    return mapping("PROVIDER_REQUEST_FAILED");
  }

  if (error instanceof PersistenceError || error instanceof PersistenceBoundaryError) {
    if (error.code === "PERSISTENCE_NOT_FOUND") return mapping("RESOURCE_NOT_FOUND");
    if (error.code === "IMMUTABILITY_VIOLATION" || error.code === "CONFLICTING_EXISTING_ROW") return mapping("REQUEST_CONFLICT");
    return mapping("INTERNAL_ERROR");
  }

  return mapping("INTERNAL_ERROR");
}

function mapping(code: SafeHttpCode): SafeHttpMapping {
  return Object.freeze({ code, ...RESPONSE[code] });
}
