import { EvidenceExtractionResponseSchema } from "../../domain/schemas/provider-responses.js";
import type {
  EgressGateDependencies,
  EgressSafePayload,
} from "../../privacy/egress/contracts.js";
import { evaluateEgressGate } from "../../privacy/egress/egress-gate.js";
import type {
  BuiltLocalEvidence,
  ProviderEvidenceAssertion,
  ProviderReferenceAuthorityPort,
  ProviderTrustContext,
} from "../contracts.js";
import { buildLocalAcceptedEvidence } from "../trust/evidence-builder.js";
import { trustProviderResponse } from "../trust/provider-response-trust-gate.js";
import type { ProviderRuntimeConfig } from "./config.js";
import { ProviderTransportError } from "./errors.js";
import {
  executeOpenAICompatibleChatCompletion,
  type FetchLike,
  type ProviderChatMessage,
  type ProviderUsage,
} from "./openai-compatible-transport.js";

export const EVIDENCE_EXTRACTION_OPERATION = "EVIDENCE_EXTRACTION" as const;

const SYSTEM_PROMPT = `你是结构化证据提取组件。
只根据提供的sanitized records提取证据。
不得把推断当作来源事实。
必须返回符合指定JSON结构的数据。
record_revision_id只能引用输入中出现的ID。
excerpt必须逐字符来自sanitized_content。
char_start/char_end使用JavaScript UTF-16 code unit索引，区间为[start,end)。
不得返回Markdown代码围栏。`;

const PROMPT_EXAMPLE_ASSERTION = Object.freeze({
  record_revision_id: "rr_prompt_example",
  char_start: 0,
  char_end: 1,
  excerpt: "X",
  actor: null,
  timestamp: null,
  evidence_type: "OTHER",
});

function evidenceWireShapeCandidates(assertions: readonly unknown[]): readonly unknown[] {
  return [
    assertions,
    { candidates: assertions },
    { evidence_candidates: assertions },
    { evidence: assertions },
    { items: assertions },
    { results: assertions },
    assertions[0],
  ];
}

export function wrapEvidenceAssertionsForWire(assertions: readonly unknown[]): unknown {
  for (const candidate of evidenceWireShapeCandidates(assertions)) {
    if (candidate === undefined) continue;
    if (EvidenceExtractionResponseSchema.safeParse(candidate).success) {
      return candidate;
    }
  }
  throw new ProviderTransportError("WIRE_CONTRACT_UNSUPPORTED");
}

function isEvidenceAssertion(value: unknown): value is ProviderEvidenceAssertion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.record_revision_id === "string" &&
    Number.isInteger(record.char_start) &&
    Number.isInteger(record.char_end) &&
    typeof record.excerpt === "string" &&
    (record.actor === null || typeof record.actor === "string") &&
    (record.timestamp === null || typeof record.timestamp === "string") &&
    ["STATEMENT", "STATUS", "DECISION", "DELIVERY", "OTHER"].includes(String(record.evidence_type))
  );
}

function collectEvidenceAssertions(value: unknown): readonly ProviderEvidenceAssertion[] {
  const found: ProviderEvidenceAssertion[] = [];
  const visited = new WeakSet<object>();

  function visit(current: unknown): void {
    if (isEvidenceAssertion(current)) {
      found.push(current);
      return;
    }
    if (current === null || typeof current !== "object") return;
    if (visited.has(current)) return;
    visited.add(current);
    if (Array.isArray(current)) {
      for (const item of current) visit(item);
      return;
    }
    for (const nested of Object.values(current as Record<string, unknown>)) visit(nested);
  }

  visit(value);
  return found;
}

export function buildEvidenceExtractionMessages(payload: EgressSafePayload): readonly ProviderChatMessage[] {
  const responseTemplate = wrapEvidenceAssertionsForWire([PROMPT_EXAMPLE_ASSERTION]);
  const safeRecords = payload.records.map((record) => Object.freeze({
    record_revision_id: record.record_revision_id,
    sanitized_content: record.sanitized_content,
  }));

  return Object.freeze([
    Object.freeze({ role: "system" as const, content: SYSTEM_PROMPT }),
    Object.freeze({
      role: "user" as const,
      content: JSON.stringify({
        operation: EVIDENCE_EXTRACTION_OPERATION,
        response_json_template: responseTemplate,
        records: safeRecords,
      }),
    }),
  ]);
}

export type ProviderCallRuntimeMetadata = Readonly<{
  provider_name: string;
  model_name: string;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  usage: ProviderUsage;
  retry_count: 0;
  schema_valid: true;
  error_category: null;
  output_counts: Readonly<{ evidence: number }>;
}>;

export type EvidenceExtractionInvocationResult = Readonly<{
  operation: typeof EVIDENCE_EXTRACTION_OPERATION;
  evidence: readonly BuiltLocalEvidence[];
  provider_call: ProviderCallRuntimeMetadata;
}>;

export type EvidenceExtractionInvocationInput = Readonly<{
  egress_command: unknown;
  egress_dependencies: EgressGateDependencies;
  config: ProviderRuntimeConfig;
  authority: ProviderReferenceAuthorityPort;
  fetch_impl?: FetchLike;
  now_ms?: () => number;
}>;

async function invokeEvidenceExtractionFromAllowedPayload(input: Readonly<{
  payload: EgressSafePayload;
  config: ProviderRuntimeConfig;
  authority: ProviderReferenceAuthorityPort;
  fetch_impl?: FetchLike;
  now_ms?: () => number;
}>): Promise<EvidenceExtractionInvocationResult> {
  const reportVersionId = input.payload.report_version_id;
  if (reportVersionId === undefined) {
    throw new ProviderTransportError("INVALID_EGRESS_PAYLOAD");
  }

  const context: ProviderTrustContext = Object.freeze({
    audit_id: input.payload.audit_id,
    report_version_id: reportVersionId,
    privacy_revision_id: input.payload.privacy_revision_id,
    allowed_record_revision_ids: new Set(input.payload.records.map((record) => record.record_revision_id)),
    allowed_evidence_ids: new Set<string>(),
    allowed_domain_ids: new Set<string>(),
  });

  const nowMs = input.now_ms ?? Date.now;
  const startedMs = nowMs();
  const completion = await executeOpenAICompatibleChatCompletion({
    config: input.config,
    messages: buildEvidenceExtractionMessages(input.payload),
    fetch_impl: input.fetch_impl,
  });

  let messageJson: unknown;
  try {
    messageJson = JSON.parse(completion.message_content) as unknown;
  } catch {
    throw new ProviderTransportError("MESSAGE_JSON_INVALID");
  }

  const trusted = await trustProviderResponse({
    schema: EvidenceExtractionResponseSchema,
    raw_response: messageJson,
    context,
    authority: input.authority,
  });

  const assertions = collectEvidenceAssertions(trusted.value);
  const accepted: BuiltLocalEvidence[] = [];
  for (const assertion of assertions) {
    accepted.push(await buildLocalAcceptedEvidence({
      assertion,
      context,
      authority: input.authority,
    }));
  }

  const completedMs = nowMs();
  const providerCall = Object.freeze({
    provider_name: input.config.provider_name,
    model_name: input.config.model,
    started_at: new Date(startedMs).toISOString(),
    completed_at: new Date(completedMs).toISOString(),
    latency_ms: Math.max(0, completedMs - startedMs),
    usage: completion.usage,
    retry_count: 0 as const,
    schema_valid: true as const,
    error_category: null,
    output_counts: Object.freeze({ evidence: accepted.length }),
  });

  return Object.freeze({
    operation: EVIDENCE_EXTRACTION_OPERATION,
    evidence: Object.freeze(accepted),
    provider_call: providerCall,
  });
}

export async function invokeEvidenceExtraction(
  input: EvidenceExtractionInvocationInput,
): Promise<EvidenceExtractionInvocationResult> {
  const egressResult = evaluateEgressGate(input.egress_command, input.egress_dependencies);
  if (egressResult.decision !== "ALLOW") {
    throw new ProviderTransportError("EGRESS_DENIED");
  }

  return invokeEvidenceExtractionFromAllowedPayload({
    payload: egressResult.payload,
    config: input.config,
    authority: input.authority,
    fetch_impl: input.fetch_impl,
    now_ms: input.now_ms,
  });
}
