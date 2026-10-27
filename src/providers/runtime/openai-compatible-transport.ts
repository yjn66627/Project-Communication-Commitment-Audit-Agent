import { TextDecoder } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, lstatSync } from "node:fs";
import path from "node:path";

import type { ProviderRuntimeConfig } from "./config.js";
import { buildChatCompletionsEndpoint } from "./config.js";
import {
  isProviderTransportError,
  ProviderTransportError,
} from "./errors.js";

export const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024;
export const MAX_PROVIDER_ATTEMPTS = 1;

export type ProviderChatMessage = Readonly<{
  role: "system" | "user";
  content: string;
}>;

export type ProviderUsage = Readonly<{
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  provenance: "PROVIDER_RETURNED" | "UNKNOWN";
}>;

export type OpenAICompatibleCompletionResult = Readonly<{
  message_content: string;
  usage: ProviderUsage;
}>;

export type FetchLike = typeof globalThis.fetch;

function mapHttpFailure(status: number): ProviderTransportError {
  if (status === 400) return new ProviderTransportError("HTTP_BAD_REQUEST");
  if (status === 401 || status === 403) return new ProviderTransportError("AUTHENTICATION_FAILED");
  if (status === 408) return new ProviderTransportError("REQUEST_TIMEOUT");
  if (status === 429) return new ProviderTransportError("RATE_LIMITED");
  if (status >= 500 && status <= 599) return new ProviderTransportError("PROVIDER_UNAVAILABLE");
  return new ProviderTransportError("HTTP_ERROR");
}

function safeNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseUsage(envelope: Record<string, unknown>): ProviderUsage {
  const usage = envelope.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) {
    return Object.freeze({
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      provenance: "UNKNOWN" as const,
    });
  }

  const record = usage as Record<string, unknown>;
  return Object.freeze({
    input_tokens: safeNonNegativeInteger(record.prompt_tokens ?? record.input_tokens),
    output_tokens: safeNonNegativeInteger(record.completion_tokens ?? record.output_tokens),
    total_tokens: safeNonNegativeInteger(record.total_tokens),
    provenance: "PROVIDER_RETURNED" as const,
  });
}

function parseEnvelope(value: unknown): OpenAICompatibleCompletionResult {
  noteProviderDiagnosticPhase("ENVELOPE");
  noteProviderEnvelope(value);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProviderTransportError("MALFORMED_ENVELOPE");
  }

  const envelope = value as Record<string, unknown>;
  const choices = envelope.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new ProviderTransportError("MALFORMED_ENVELOPE");
  }

  const first = choices[0];
  if (typeof first !== "object" || first === null || Array.isArray(first)) {
    throw new ProviderTransportError("MALFORMED_ENVELOPE");
  }

  const message = (first as Record<string, unknown>).message;
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    throw new ProviderTransportError("MALFORMED_ENVELOPE");
  }

  const content = (message as Record<string, unknown>).content;
  noteProviderContentLength(content);
  if (typeof content !== "string") {
    throw new ProviderTransportError("MALFORMED_ENVELOPE");
  }
  if (content.trim().length === 0) {
    throw new ProviderTransportError("EMPTY_CONTENT");
  }

  return Object.freeze({
    message_content: content,
    usage: parseUsage(envelope),
  });
}

async function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Overflow classification must remain RESPONSE_TOO_LARGE even if cancellation itself fails.
  }
}

async function readResponseBytesBounded(response: Response): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const length = Number(contentLength);
    if (Number.isFinite(length) && length > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new ProviderTransportError("RESPONSE_TOO_LARGE");
    }
  }

  if (response.body === null) return new Uint8Array(0);

  noteProviderBytes(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined || value.byteLength === 0) continue;

    const nextTotal = totalBytes + value.byteLength;
    noteProviderBytes(nextTotal);
    if (nextTotal > MAX_PROVIDER_RESPONSE_BYTES) {
      await cancelReader(reader);
      throw new ProviderTransportError("RESPONSE_TOO_LARGE");
    }

    chunks.push(value);
    totalBytes = nextTotal;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  noteProviderDiagnosticPhase("CONTENT_TYPE");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  noteProviderContentType(contentType);
  if (!contentType.includes("application/json")) {
    throw new ProviderTransportError("INVALID_CONTENT_TYPE");
  }

  noteProviderDiagnosticPhase("BODY_READ");
  const bytes = await readResponseBytesBounded(response);
  noteProviderBytes(bytes.byteLength);
  noteProviderDiagnosticPhase("UTF8_DECODE");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ProviderTransportError("MALFORMED_ENVELOPE");
  }

  try {
    noteProviderDiagnosticPhase("ENVELOPE_JSON");
    return JSON.parse(text) as unknown;
  } catch {
    throw new ProviderTransportError("MALFORMED_ENVELOPE");
  }
}

export async function executeOpenAICompatibleChatCompletion(input: Readonly<{
  config: ProviderRuntimeConfig;
  messages: readonly ProviderChatMessage[];
  fetch_impl?: FetchLike;
}>): Promise<OpenAICompatibleCompletionResult> {
  noteProviderTimeout(input.config.timeout_ms);
  const fetchImpl = input.fetch_impl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.config.timeout_ms);

  try {
    let response: Response;
    try {
      noteProviderDiagnosticPhase("FETCH");
      response = await fetchImpl(buildChatCompletionsEndpoint(input.config), {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.config.api_key}`,
        },
        body: JSON.stringify({
          model: input.config.model,
          messages: input.messages,
          temperature: 0,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new ProviderTransportError("REQUEST_TIMEOUT");
      }
      if (isProviderTransportError(error)) throw error;
      throw new ProviderTransportError("NETWORK_FAILURE");
    }

    noteProviderHttp(response);
    noteProviderDiagnosticPhase("HTTP_STATUS");
    if (!response.ok) {
      throw mapHttpFailure(response.status);
    }

    let envelope: unknown;
    try {
      envelope = await readBoundedJsonResponse(response);
    } catch (error) {
      if (isProviderTransportError(error)) throw error;
      if (controller.signal.aborted) {
        throw new ProviderTransportError("REQUEST_TIMEOUT");
      }
      throw new ProviderTransportError("NETWORK_FAILURE");
    }

    return parseEnvelope(envelope);
  } finally {
    clearTimeout(timeout);
  }
}

// R13 opt-in diagnostics. This module owns structural telemetry only; no wire acceptance changes.
type DiagnosticPhase = "CONFIG" | "FETCH" | "HTTP_STATUS" | "CONTENT_TYPE" | "BODY_READ" | "UTF8_DECODE" | "ENVELOPE_JSON" | "ENVELOPE" | "MESSAGE_JSON" | "PROMPT_BUILD" | "EGRESS" | "TRUST_SCHEMA" | "TRUST_SECURITY" | "TRUST_REFERENCE" | "LOCAL_BUILD" | "UNKNOWN";
type StructuralType = "string" | "number" | "boolean" | "array" | "object" | "null" | "undefined" | "NOT_AVAILABLE";
type SchemaField = Readonly<{ path: readonly (string | number)[]; issue_code: string; expected_type: string; actual_type: StructuralType }>;
type DiagnosticContext = { stage: string; callId: string; phase: DiagnosticPhase; httpStatus: number | "NOT_AVAILABLE"; responseBytes: number | "NOT_AVAILABLE"; timeoutMs: number | "NOT_AVAILABLE"; contentType: "APPLICATION_JSON" | "OTHER" | "MISSING" | "NOT_AVAILABLE"; rootType: StructuralType; choicesCount: number | "NOT_AVAILABLE"; contentLength: number | "NOT_AVAILABLE"; fields: SchemaField[] };
const diagnosticContext = new AsyncLocalStorage<DiagnosticContext>();
const diagnosticPhases = new Set<DiagnosticPhase>(["CONFIG","FETCH","HTTP_STATUS","CONTENT_TYPE","BODY_READ","UTF8_DECODE","ENVELOPE_JSON","ENVELOPE","MESSAGE_JSON","PROMPT_BUILD","EGRESS","TRUST_SCHEMA","TRUST_SECURITY","TRUST_REFERENCE","LOCAL_BUILD","UNKNOWN"]);
const diagnosticCodes = new Set(["CONFIG_MISSING","CONFIG_INVALID","EGRESS_DENIED","INVALID_EGRESS_PAYLOAD","WIRE_CONTRACT_UNSUPPORTED","HTTP_BAD_REQUEST","AUTHENTICATION_FAILED","REQUEST_TIMEOUT","RATE_LIMITED","PROVIDER_UNAVAILABLE","HTTP_ERROR","NETWORK_FAILURE","INVALID_CONTENT_TYPE","RESPONSE_TOO_LARGE","MALFORMED_ENVELOPE","EMPTY_CONTENT","MESSAGE_JSON_INVALID","SCHEMA_INVALID","REFERENCE_NOT_FOUND","REFERENCE_CONTEXT_MISMATCH","EXCERPT_RANGE_INVALID","EXCERPT_MISMATCH","UTF16_BOUNDARY_INVALID","UNSAFE_RESPONSE_CONTENT","INTERNAL_VALIDATION_FAILURE","AUTHORITY_UPGRADE_FORBIDDEN","RELATION_INVALID","REPORT_RECONCILIATION_INVALID","DOMAIN_CANDIDATE_INVALID","UNKNOWN"]);
const diagnosticStages = new Set(["EVIDENCE_EXTRACTION","COMMITMENT_CHANGE","CONFLICT_REVIEW","REPORT_FINALIZE"]);
const diagnosticPathKeys = new Set(["candidates","record_revision_id","char_start","char_end","excerpt","actor","timestamp","evidence_type","commitments","changes","classification","action_or_deliverable","evidence_ids","deadline","condition","recipient","epistemic_status","change_type","subject","before_summary","after_summary","potential_conflicts","claim_a","claim_b","text","comparable_context","time_context","version_context","condition_context","conflict_reason","counter_evidence_ids","alternative_explanations","missing_evidence","summary","items","unresolved_items","domain_ids","conflicted","changes_summary"]);
const diagnosticIssueCodes = new Set(["invalid_type","invalid_literal","custom","invalid_union","invalid_union_discriminator","invalid_enum_value","unrecognized_keys","invalid_arguments","invalid_return_type","invalid_date","invalid_string","too_small","too_big","invalid_intersection_types","not_multiple_of","not_finite"]);
const diagnosticTypes = new Set(["string","number","boolean","array","object","null","undefined","integer","nan","date","unknown","never","void","promise","map","set","function","bigint","symbol","enum","literal"]);
function structuralType(value: unknown): StructuralType { if(value===null)return "null";if(Array.isArray(value))return "array";const t=typeof value;return t==="string"||t==="number"||t==="boolean"||t==="object"||t==="undefined"?t:"NOT_AVAILABLE"; }
function ownValue(value: unknown, key: string | number): unknown { if(value===null||typeof value!=="object")return undefined;const d=Object.getOwnPropertyDescriptor(value,key);return d&&"value" in d?d.value:undefined; }
function boundedCount(value: unknown): number | "NOT_AVAILABLE" { return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0&&value<=100_000_000?value:"NOT_AVAILABLE"; }
export function withSafeProviderDiagnostics<T>(stage: string, callId: string, action: () => Promise<T>): Promise<T> {
  if(process.env.PCCA_PROVIDER_DIAGNOSTICS!=="1")return action();
  const state: DiagnosticContext={stage:diagnosticStages.has(stage)?stage:"NOT_AVAILABLE",callId:/^pcall_[0-9a-f-]{36}$/u.test(callId)?callId:"NOT_AVAILABLE",phase:"CONFIG",httpStatus:"NOT_AVAILABLE",responseBytes:"NOT_AVAILABLE",timeoutMs:"NOT_AVAILABLE",contentType:"NOT_AVAILABLE",rootType:"NOT_AVAILABLE",choicesCount:"NOT_AVAILABLE",contentLength:"NOT_AVAILABLE",fields:[]};
  return diagnosticContext.run(state,action);
}
export function noteProviderDiagnosticPhase(phase: DiagnosticPhase): void { const s=diagnosticContext.getStore();if(s)s.phase=diagnosticPhases.has(phase)?phase:"UNKNOWN"; }
function noteProviderTimeout(timeout: number): void { const s=diagnosticContext.getStore();if(s)s.timeoutMs=Number.isInteger(timeout)&&timeout>=1000&&timeout<=120000?timeout:"NOT_AVAILABLE"; }
function noteProviderHttp(response: Response): void { const s=diagnosticContext.getStore();if(s)s.httpStatus=Number.isInteger(response.status)&&response.status>=100&&response.status<=599?response.status:"NOT_AVAILABLE"; }
function noteProviderBytes(count: number): void { const s=diagnosticContext.getStore();if(s)s.responseBytes=boundedCount(count); }
function noteProviderContentType(value: string): void { const s=diagnosticContext.getStore();if(s)s.contentType=value.includes("application/json")?"APPLICATION_JSON":value.length?"OTHER":"MISSING"; }
function noteProviderEnvelope(value: unknown): void { const s=diagnosticContext.getStore();if(!s)return;s.rootType=structuralType(value);const c=ownValue(value,"choices");s.choicesCount=Array.isArray(c)?boundedCount(c.length):"NOT_AVAILABLE"; }
function noteProviderContentLength(value: unknown): void { const s=diagnosticContext.getStore();if(s)s.contentLength=typeof value==="string"?boundedCount(value.length):"NOT_AVAILABLE"; }
export function noteProviderSchemaFailure(issues: readonly unknown[], raw: unknown): void {
  const s=diagnosticContext.getStore();if(!s)return;
  try { for(const value of issues.slice(0,16)) {
    const p=ownValue(value,"path"),code=ownValue(value,"code"),expected=ownValue(value,"expected"),kind=ownValue(value,"type");
    const originalPath=Array.isArray(p)?p.slice(0,8):[];
    const safePath=originalPath.map(x=>typeof x==="number"?Number.isSafeInteger(x)&&x>=0&&x<=1_000_000?x:"INDEX":typeof x==="string"&&diagnosticPathKeys.has(x)?x:"FIELD");
    let received: unknown=raw;for(const k of originalPath)received=typeof k==="string"||typeof k==="number"?ownValue(received,k):undefined;
    const expectedType=typeof expected==="string"&&diagnosticTypes.has(expected)?expected:code==="invalid_enum_value"?"enum":code==="invalid_literal"?"literal":typeof kind==="string"&&diagnosticTypes.has(kind)?kind:"NOT_AVAILABLE";
    s.fields.push(Object.freeze({path:Object.freeze(safePath),issue_code:typeof code==="string"&&diagnosticIssueCodes.has(code)?code:"OTHER",expected_type:expectedType,actual_type:structuralType(received)}));
    if(s.fields.length>=16)break;
  }}catch { /* Diagnostic observation must never change Schema rejection. */ }
}
export function recordSafeProviderFailure(code: string, trustError: boolean, familyError: boolean): void {
  const s=diagnosticContext.getStore();if(!s)return;
  try {
    const safeCode=diagnosticCodes.has(code)?code:"UNKNOWN";
    const phase: DiagnosticPhase=safeCode==="MESSAGE_JSON_INVALID"?"MESSAGE_JSON":safeCode==="WIRE_CONTRACT_UNSUPPORTED"?"PROMPT_BUILD":safeCode==="EGRESS_DENIED"||safeCode==="INVALID_EGRESS_PAYLOAD"?"EGRESS":s.phase;
    const event=Object.freeze({version:1,stage:s.stage,provider_call_id:s.callId,status:"FAILED",suberror_code:safeCode,processing_phase:phase,http_status:s.httpStatus,http_status_obtained:s.httpStatus!=="NOT_AVAILABLE",content_type_category:s.contentType,response_byte_length:s.responseBytes,envelope_root_type:s.rootType,envelope_choices_count:s.choicesCount,message_content_code_units:s.contentLength,schema_fields:Object.freeze([...s.fields]),family_error_class:familyError===true,trust_gate_rejected:trustError?(s.phase==="TRUST_SCHEMA"||s.phase==="TRUST_SECURITY"||s.phase==="TRUST_REFERENCE"):false,timeout_ms:s.timeoutMs,at:new Date().toISOString()});
    const local=process.env.LOCALAPPDATA;if(!local||!path.isAbsolute(local))return;
    const dir=path.join(local,"ProjectCommunicationCommitmentAuditAgent"),target=path.join(dir,"provider-diagnostics.ndjson");
    if(lstatSync(local).isSymbolicLink()||!lstatSync(dir).isDirectory()||lstatSync(dir).isSymbolicLink())return;
    if(existsSync(target)){const st=lstatSync(target);if(st.isSymbolicLink()||!st.isFile())return;}
    appendFileSync(target,JSON.stringify(event)+"\n",{encoding:"utf8",mode:0o600,flag:"a"});
  } catch { /* Best-effort private telemetry cannot replace the original failure. */ }
}
