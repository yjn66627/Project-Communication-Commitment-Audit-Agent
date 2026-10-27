import {
  CommitmentChangeResponseSchema,
  ConflictReviewResponseSchema,
  ReportSummaryResponseSchema,
} from "../../domain/schemas/provider-responses.js";
import { ChangeTypeSchema } from "../../domain/schemas/base.js";
import type {
  FamilyEgressGateDependencies,
  FamilyEgressGateResult,
  FamilyEgressSafePayload,
} from "../../privacy/egress/contracts.js";
import { evaluateFamilyEgressGate } from "../../privacy/egress/egress-gate.js";
import type {
  ProviderReferenceAuthorityPort,
  ProviderTrustContext,
  ProviderWireSchema,
  ValidatedProviderAssertion,
} from "../contracts.js";
import {
  buildLocalCommitmentChangeCandidates,
  buildLocalConflictCandidates,
  buildLocalReportPresentationProposal,
  type LocalCommitmentChangeCandidates,
  type LocalConflictCandidates,
  type LocalReportPresentationProposal,
} from "../trust/family-builders.js";
import { trustProviderResponse } from "../trust/provider-response-trust-gate.js";
import type { ProviderRuntimeConfig } from "./config.js";
import { ProviderTransportError } from "./errors.js";
import {
  executeOpenAICompatibleChatCompletion,
  type FetchLike,
  type ProviderChatMessage,
  type ProviderUsage,
} from "./openai-compatible-transport.js";

export const COMMITMENT_CHANGE_OPERATION = "COMMITMENT_CHANGE" as const;
export const CONFLICT_REVIEW_OPERATION = "CONFLICT_REVIEW" as const;
export const REPORT_FINALIZE_OPERATION = "REPORT_FINALIZE" as const;

type FamilyOperation =
  | typeof COMMITMENT_CHANGE_OPERATION
  | typeof CONFLICT_REVIEW_OPERATION
  | typeof REPORT_FINALIZE_OPERATION;

const CHANGE_TYPE_VALUES = ChangeTypeSchema.options.join(", ");

const SYSTEM_PROMPTS: Readonly<Record<FamilyOperation, string>> = Object.freeze({
  COMMITMENT_CHANGE: `你是承诺和需求变更候选提取组件。只使用用户消息中已经由本地安全门批准的 evidence。
只返回严格 JSON：{"commitments":[],"changes":[]}。
每项只能是 classification=CANDIDATE，epistemic_status=INFERENCE 或 UNKNOWN。
commitments 项字段为 classification,actor,action_or_deliverable,evidence_ids,deadline,condition,recipient,epistemic_status。
changes 项字段为 classification,change_type,subject,before_summary,after_summary,evidence_ids,timestamp,epistemic_status。
change_type 只能是 ${CHANGE_TYPE_VALUES} 中之一，必须严格使用以上英文枚举原值，区分大小写，不得翻译、改写、使用同义词或创造其他值。
evidence_ids 只能引用输入 evidence 中已有 ID；不得提出最终 ID、已兑现状态、现实真实性或最终责任归属。不得返回 Markdown。`,
  CONFLICT_REVIEW: `你是潜在冲突候选审阅组件。只引用用户消息中已有的 evidence。
只返回严格 JSON：{"potential_conflicts":[]}。
potential_conflicts 是数组，可为空；每项必须是严格对象，且只含 claim_a、claim_b、comparable_context、conflict_reason、counter_evidence_ids、alternative_explanations、epistemic_status、missing_evidence。
claim_a 与 claim_b 各自必须是对象，且只含 text（非空 string）和 evidence_ids（至少一个输入中已有的 Evidence ID 字符串）。
comparable_context 必须为 object（对象），且只含以下字段：{"subject":"string","time_context":"string|null","version_context":"string|null","condition_context":"string|null"}。subject 是非空 string；time_context、version_context、condition_context 各为非空 string 或 null。
conflict_reason 是非空 string。counter_evidence_ids 是 Evidence ID 字符串数组，可为空，只引用输入中已有 ID。
alternative_explanations 是数组，可为空；每项必须是只含 text（非空 string）和 epistemic_status 的对象，epistemic_status 必须是 literal INFERENCE。
epistemic_status 只能是 INFERENCE 或 UNKNOWN。missing_evidence 是 string 数组，可为空，每项为非空 string。
这只是潜在冲突提议，不能宣布现实事实。不得返回最终 ID 或 Markdown。`,
  REPORT_FINALIZE: `你是报告呈现文字的提议组件。输入的 local_summary、timeline、evidence、commitments、changes、conflicts、missing_evidence 均由本地安全门提供。
只返回严格 JSON：{"summary":{"items":[],"unresolved_items":[]},"changes_summary":null}。
summary 必须是只含 items、unresolved_items 的对象。items 是数组，可为空；每项必须是只含 text（非空 string）、epistemic_status、evidence_ids、domain_ids、conflicted 的对象。text 是非空 string；epistemic_status 是 FACT、INFERENCE、UNKNOWN 之一；evidence_ids 是输入中已有 Evidence ID 字符串数组；domain_ids 是输入中已有 Commitment、Change 或 Conflict ID 字符串数组；conflicted 是 boolean。两个 ID 数组可为空；epistemic_status 为 FACT 时 evidence_ids 至少有一个 ID。
summary.items[].text 属于 presentation wording，可以改写；该许可不适用于 summary.unresolved_items。
unresolved_items 是 string 数组，可为空，每项为非空 string。changes_summary 是非空 string 或 null。
summary.unresolved_items 是输入 local_summary.unresolved_items 的本地 canonical unresolved Authority。输出数量必须与输入完全相同，逐项原样保留每个输入字符串，且输出 unresolved_items 的 multiset 必须与输入 multiset 完全一致。
不得省略任何输入项，不得增加新的 unresolved item，不得合并两个 unresolved items，不得拆分一个 unresolved item，不得改写任何 unresolved item，不得摘要任何 unresolved item，不得同义重述任何 unresolved item，不得去重任何 unresolved item。
可以改写 summary.items 的 text 并调整 items 顺序。每个条目的 evidence_ids、domain_ids、epistemic_status、conflicted 必须原样保留。
summary.items 每个条目的 epistemic_status 只能是 FACT、INFERENCE 或 UNKNOWN，并且必须与输入对应条目完全一致。
不得增删条目，不得删除 unresolved_items，不得删除、掩盖或改写 missing_evidence，也不得提升任何事实级别。
changes_summary 仅是文字提议。不得返回 report_version_id、隐私修订 ID、最终报告 ID 或 Markdown。`,
});

export type FamilyInvocationInput = Readonly<{
  egress_command: unknown;
  egress_dependencies: FamilyEgressGateDependencies;
  config: ProviderRuntimeConfig;
  authority: ProviderReferenceAuthorityPort;
  fetch_impl?: FetchLike;
  now_ms?: () => number;
}>;

export type FamilyProviderCallRuntimeMetadata = Readonly<{
  provider_name: string;
  model_name: string;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  usage: ProviderUsage;
  retry_count: 0;
  schema_valid: true;
  error_category: null;
  output_counts: Readonly<{
    commitments?: number;
    changes?: number;
    conflicts?: number;
    summary_items?: number;
  }>;
}>;

function buildTrustContext(payload: FamilyEgressSafePayload): ProviderTrustContext {
  const evidence = payload.evidence;
  const domainIds = payload.operation === "REPORT_FINALIZE"
    ? [
        ...payload.commitments.map((item) => item.commitment_id),
        ...payload.changes.map((item) => item.change_id),
        ...payload.conflicts.map((item) => item.conflict_id),
      ]
    : [];
  return Object.freeze({
    audit_id: payload.audit_id,
    report_version_id: payload.report_version_id,
    privacy_revision_id: payload.privacy_revision_id,
    allowed_record_revision_ids: new Set(evidence.map((item) => item.record_revision_id)),
    allowed_evidence_ids: new Set(evidence.map((item) => item.evidence_id)),
    allowed_domain_ids: new Set(domainIds),
  });
}

function buildFamilyMessages(payload: FamilyEgressSafePayload): readonly ProviderChatMessage[] {
  return Object.freeze([
    Object.freeze({ role: "system" as const, content: SYSTEM_PROMPTS[payload.operation] }),
    // This is the exact variable context returned by the Egress Gate; no local data is appended.
    Object.freeze({ role: "user" as const, content: JSON.stringify(payload) }),
  ]);
}

function metadata(
  input: FamilyInvocationInput,
  startedMs: number,
  completedMs: number,
  usage: ProviderUsage,
  outputCounts: FamilyProviderCallRuntimeMetadata["output_counts"],
): FamilyProviderCallRuntimeMetadata {
  return Object.freeze({
    provider_name: input.config.provider_name,
    model_name: input.config.model,
    started_at: new Date(startedMs).toISOString(),
    completed_at: new Date(completedMs).toISOString(),
    latency_ms: Math.max(0, completedMs - startedMs),
    usage,
    retry_count: 0 as const,
    schema_valid: true as const,
    error_category: null,
    output_counts: Object.freeze(outputCounts),
  });
}

async function invokeFamilyWire<T>(
  input: FamilyInvocationInput,
  expectedOperation: FamilyOperation,
  schema: ProviderWireSchema<T>,
): Promise<Readonly<{
  assertion: ValidatedProviderAssertion<T>;
  egress: Extract<FamilyEgressGateResult, { decision: "ALLOW" }>;
  context: ProviderTrustContext;
  started_ms: number;
  usage: ProviderUsage;
  now_ms: () => number;
}>> {
  const egress = evaluateFamilyEgressGate(input.egress_command, input.egress_dependencies);
  if (egress.decision !== "ALLOW") throw new ProviderTransportError("EGRESS_DENIED");
  if (egress.payload.operation !== expectedOperation) {
    throw new ProviderTransportError("INVALID_EGRESS_PAYLOAD");
  }

  const nowMs = input.now_ms ?? Date.now;
  const startedMs = nowMs();
  const completion = await executeOpenAICompatibleChatCompletion({
    config: input.config,
    messages: buildFamilyMessages(egress.payload),
    fetch_impl: input.fetch_impl,
  });

  let messageJson: unknown;
  try {
    messageJson = JSON.parse(completion.message_content) as unknown;
  } catch {
    throw new ProviderTransportError("MESSAGE_JSON_INVALID");
  }

  const context = buildTrustContext(egress.payload);
  const assertion = await trustProviderResponse({
    schema,
    raw_response: messageJson,
    context,
    authority: input.authority,
  });
  return Object.freeze({
    assertion,
    egress,
    context,
    started_ms: startedMs,
    usage: completion.usage,
    now_ms: nowMs,
  });
}

export type CommitmentChangeInvocationResult = Readonly<{
  operation: typeof COMMITMENT_CHANGE_OPERATION;
  candidates: LocalCommitmentChangeCandidates;
  provider_call: FamilyProviderCallRuntimeMetadata;
}>;

export async function invokeCommitmentChange(
  input: FamilyInvocationInput,
): Promise<CommitmentChangeInvocationResult> {
  const result = await invokeFamilyWire(input, COMMITMENT_CHANGE_OPERATION, CommitmentChangeResponseSchema);
  const candidates = await buildLocalCommitmentChangeCandidates({
    assertion: result.assertion,
    context: result.context,
    authority: input.authority,
  });
  return Object.freeze({
    operation: COMMITMENT_CHANGE_OPERATION,
    candidates,
    provider_call: metadata(input, result.started_ms, result.now_ms(), result.usage, {
      commitments: candidates.commitments.length,
      changes: candidates.changes.length,
    }),
  });
}

export type ConflictReviewInvocationResult = Readonly<{
  operation: typeof CONFLICT_REVIEW_OPERATION;
  candidates: LocalConflictCandidates;
  provider_call: FamilyProviderCallRuntimeMetadata;
}>;

export async function invokeConflictReview(
  input: FamilyInvocationInput,
): Promise<ConflictReviewInvocationResult> {
  const result = await invokeFamilyWire(input, CONFLICT_REVIEW_OPERATION, ConflictReviewResponseSchema);
  const candidates = await buildLocalConflictCandidates({
    assertion: result.assertion,
    context: result.context,
    authority: input.authority,
  });
  return Object.freeze({
    operation: CONFLICT_REVIEW_OPERATION,
    candidates,
    provider_call: metadata(input, result.started_ms, result.now_ms(), result.usage, {
      conflicts: candidates.conflicts.length,
    }),
  });
}

export type ReportFinalizeInvocationResult = Readonly<{
  operation: typeof REPORT_FINALIZE_OPERATION;
  presentation_proposal: LocalReportPresentationProposal;
  provider_call: FamilyProviderCallRuntimeMetadata;
}>;

export async function invokeReportFinalize(
  input: FamilyInvocationInput,
): Promise<ReportFinalizeInvocationResult> {
  const result = await invokeFamilyWire(input, REPORT_FINALIZE_OPERATION, ReportSummaryResponseSchema);
  if (result.egress.payload.operation !== "REPORT_FINALIZE" || result.egress.local_report === undefined) {
    throw new ProviderTransportError("INVALID_EGRESS_PAYLOAD");
  }
  const presentationProposal = buildLocalReportPresentationProposal({
    assertion: result.assertion,
    payload: result.egress.payload,
    local_report: result.egress.local_report,
  });
  return Object.freeze({
    operation: REPORT_FINALIZE_OPERATION,
    presentation_proposal: presentationProposal,
    provider_call: metadata(input, result.started_ms, result.now_ms(), result.usage, {
      summary_items: presentationProposal.local_report.audit_summary.items.length,
    }),
  });
}
