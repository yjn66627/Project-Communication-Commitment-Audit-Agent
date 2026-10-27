import { randomUUID } from "node:crypto";
import { createProviderRuntimeConfig, readProviderRuntimeConfig, type ProviderEnvironment, type ProviderRuntimeConfig } from "./config.js";
import { invokeEvidenceExtraction } from "./evidence-extraction-invoker.js";
import { invokeCommitmentChange, invokeConflictReview, invokeReportFinalize } from "./family-invokers.js";
import { ProviderTransportError } from "./errors.js";
import { FamilyTrustError } from "../trust/family-builders.js";
import { ProviderTrustError } from "../trust/errors.js";
import type { ProviderReferenceAuthorityPort } from "../contracts.js";
import type { EgressGateDependencies, FamilyEgressGateDependencies } from "../../privacy/egress/contracts.js";
import {
  FOUR_FAMILY_RUN_STAGES,
  type FourFamilyProviderPort,
  type FourFamilyRunStage,
  type ProviderCallMetadata,
  type ProviderStageOutcome,
  type RunContext,
  type RunProviderAuthorityPort,
  type SafeRunFailureCategory,
} from "../../application/runs/four-family-run-ports.js";
import { withSafeProviderDiagnostics, recordSafeProviderFailure, type FetchLike } from "./openai-compatible-transport.js";

function safeName(value: string | undefined): string {
  return value && /^[A-Za-z0-9._:-]{1,96}$/u.test(value) ? value : "configured";
}

function classify(error: unknown): SafeRunFailureCategory {
  if (error instanceof ProviderTransportError) {
    if (error.code === "CONFIG_MISSING") return "CONFIG_MISSING";
    if (error.code === "CONFIG_INVALID") return "CONFIG_INVALID";
    if (error.code === "EGRESS_DENIED") return "EGRESS_DENIED";
    if (error.code === "INVALID_EGRESS_PAYLOAD") return "REFERENCE_FAILURE";
    if (error.code === "WIRE_CONTRACT_UNSUPPORTED" || error.code === "MESSAGE_JSON_INVALID" || error.code === "MALFORMED_ENVELOPE" || error.code === "INVALID_CONTENT_TYPE" || error.code === "EMPTY_CONTENT") return "WIRE_SCHEMA_FAILURE";
    return "PROVIDER_TRANSPORT_FAILURE";
  }
  if (error instanceof ProviderTrustError) {
    if (error.code === "SCHEMA_INVALID") return "WIRE_SCHEMA_FAILURE";
    if (error.code === "REFERENCE_NOT_FOUND" || error.code === "REFERENCE_CONTEXT_MISMATCH" || error.code === "EXCERPT_RANGE_INVALID" || error.code === "EXCERPT_MISMATCH" || error.code === "UTF16_BOUNDARY_INVALID") return "REFERENCE_FAILURE";
    return "TRUST_FAILURE";
  }
  if (error instanceof FamilyTrustError) return "TRUST_FAILURE";
  return "PROVIDER_STAGE_FAILURE";
}

type RuntimeCall = Readonly<{
  provider_name: string;
  model_name: string;
  started_at: string;
  completed_at: string;
  latency_ms: number;
  usage: Readonly<{ input_tokens: number | null; output_tokens: number | null; total_tokens: number | null }> | null;
  schema_valid: boolean | null;
  output_counts: ProviderCallMetadata["output_counts"];
}>;

function metadata(input: Readonly<{
  stage: FourFamilyRunStage;
  callId: string;
  runtime: RuntimeCall;
  inputRecordCount: number | null;
  inputSizeChars: number | null;
  status: "SUCCEEDED" | "FAILED";
  errorCategory: SafeRunFailureCategory | null;
}>): ProviderCallMetadata {
  return Object.freeze({
    provider_call_id: input.callId,
    stage: input.stage,
    provider_name: safeName(input.runtime.provider_name),
    model_name: safeName(input.runtime.model_name),
    started_at: input.runtime.started_at,
    completed_at: input.runtime.completed_at,
    latency_ms: input.runtime.latency_ms,
    status: input.status,
    input_record_count: input.inputRecordCount,
    input_size_chars: input.inputSizeChars,
    input_tokens: input.runtime.usage?.input_tokens ?? null,
    output_tokens: input.runtime.usage?.output_tokens ?? null,
    total_tokens: input.runtime.usage?.total_tokens ?? null,
    cost_amount_micros: null,
    cost_currency: null,
    retry_count: 0,
    schema_valid: input.runtime.schema_valid,
    error_category: input.errorCategory,
    output_counts: input.runtime.output_counts,
  });
}

function makeProviderCall<T>(input: Readonly<{
  stage: FourFamilyRunStage;
  measure: () => Readonly<{ count: number | null; size: number | null }>;
  assertOutsideTransaction: () => void;
  configFactory: () => ProviderRuntimeConfig;
  invoke: (config: ProviderRuntimeConfig, callId: string) => Promise<Readonly<{ value: T; runtime: RuntimeCall }>>;
}>): () => Promise<ProviderStageOutcome<T>> {
  return () => {
    const callId = `pcall_${randomUUID()}`;
    return withSafeProviderDiagnostics(input.stage, callId, async () => {
    const startedMs = Date.now();
    let config: ProviderRuntimeConfig | undefined;
    let size = { count: null as number | null, size: null as number | null };
    const callRuntime = (runtime?: RuntimeCall): RuntimeCall => runtime ?? {
      provider_name: config ? config.provider_name : "unconfigured",
      model_name: config ? config.model : "unconfigured",
      started_at: new Date(startedMs).toISOString(),
      completed_at: new Date().toISOString(),
      latency_ms: Math.max(0, Date.now() - startedMs),
      usage: null,
      schema_valid: null,
      output_counts: null,
    };

    try {
      input.assertOutsideTransaction();
      size = input.measure();
      config = input.configFactory();
      const result = await input.invoke(config, callId);
      return Object.freeze({
        ok: true as const,
        value: result.value,
        providerCall: metadata({
          stage: input.stage, callId, runtime: result.runtime, inputRecordCount: size.count,
          inputSizeChars: size.size, status: "SUCCEEDED", errorCategory: null,
        }),
      });
    } catch (error) {
      recordSafeProviderFailure(error instanceof ProviderTransportError || error instanceof ProviderTrustError || error instanceof FamilyTrustError ? error.code : "UNKNOWN", error instanceof ProviderTrustError, error instanceof FamilyTrustError);
      const failureCategory = classify(error);
      return Object.freeze({
        ok: false as const,
        failureCategory,
        providerCall: metadata({
          stage: input.stage, callId, runtime: callRuntime(), inputRecordCount: size.count,
          inputSizeChars: size.size, status: "FAILED", errorCategory: failureCategory,
        }),
      });
    }
    });
  };
}

function referenceAuthority(authority: RunProviderAuthorityPort, context: RunContext): ProviderReferenceAuthorityPort {
  return Object.freeze({
    resolveRecordRevision: (recordRevisionId: string) => authority.resolveRecordRevision(recordRevisionId, context),
    resolveEvidenceReference: (evidenceId: string) => authority.resolveEvidenceReference(evidenceId, context),
    resolveDomainReference: (domainId: string) => authority.resolveDomainReference(domainId, context),
  });
}

function recordsMeasure(authority: RunProviderAuthorityPort, context: RunContext) {
  const records = authority.getConfirmedPrivacyAggregateSafe(context.privacyRevisionId).records;
  return { count: records.length, size: records.reduce((sum, item) => sum + item.sanitized_content.length, 0) };
}

function evidenceMeasure(authority: RunProviderAuthorityPort, context: RunContext) {
  const evidence = authority.getEvidenceByReportVersion(context.reportVersionId);
  return { count: evidence.length, size: evidence.reduce((sum, item) => sum + item.excerpt.length, 0) };
}

function invocationRuntime(input: Readonly<{
  config: ProviderRuntimeConfig;
  startedMs: number;
  completedMs?: number;
  usage: Readonly<{ input_tokens: number | null; output_tokens: number | null; total_tokens: number | null }> | null;
  outputCounts: ProviderCallMetadata["output_counts"];
}>): RuntimeCall {
  const completedMs = input.completedMs ?? Date.now();
  return Object.freeze({
    provider_name: input.config.provider_name,
    model_name: input.config.model,
    started_at: new Date(input.startedMs).toISOString(),
    completed_at: new Date(completedMs).toISOString(),
    latency_ms: Math.max(0, completedMs - input.startedMs),
    usage: input.usage,
    schema_valid: true,
    output_counts: input.outputCounts,
  });
}

/** Connects the existing invokers to the application port; config and credentials are read per real stage call. */
export function createFourFamilyRunProviderAdapter(
  authority: RunProviderAuthorityPort,
  options: Readonly<{
    configFactory?: () => ProviderRuntimeConfig;
    environment?: ProviderEnvironment;
    fetchImpl?: FetchLike;
  }> = {},
): FourFamilyProviderPort {
  const configFactory = options.configFactory ?? (() => options.environment
    ? createProviderRuntimeConfig({
      provider_name: options.environment.AUDIT_PROVIDER_NAME,
      base_url: options.environment.AUDIT_PROVIDER_BASE_URL ?? "",
      model: options.environment.AUDIT_PROVIDER_MODEL ?? "",
      api_key: options.environment.AUDIT_PROVIDER_API_KEY ?? "",
    })
    : readProviderRuntimeConfig());

  const egress = Object.freeze({ privacy: authority, report: authority }) satisfies EgressGateDependencies;
  const familyEgress = Object.freeze({
    privacy: authority,
    report: authority,
    evidence: authority,
    finalize: authority,
  }) satisfies FamilyEgressGateDependencies;

  return Object.freeze({
    extractEvidence: (context: RunContext) => makeProviderCall({
      stage: FOUR_FAMILY_RUN_STAGES[0],
      measure: () => recordsMeasure(authority, context),
      assertOutsideTransaction: () => authority.assertProviderCallOutsideTransaction(),
      configFactory,
      invoke: async (config, callId) => {
        const startedMs = Date.now();
        const result = await invokeEvidenceExtraction({
          egress_command: { audit_id: context.auditId, privacy_revision_id: context.privacyRevisionId, report_version_id: context.reportVersionId },
          egress_dependencies: egress,
          config,
          authority: referenceAuthority(authority, context),
          fetch_impl: options.fetchImpl,
        });
        return {
          value: result.evidence.map((item) => item.evidence),
          runtime: invocationRuntime({
            config, startedMs,
            completedMs: Date.parse(result.provider_call.completed_at),
            usage: result.provider_call.usage,
            outputCounts: { evidence: result.evidence.length },
          }),
        };
      },
    })(),

    commitmentChange: (context: RunContext) => makeProviderCall({
      stage: FOUR_FAMILY_RUN_STAGES[1],
      measure: () => evidenceMeasure(authority, context),
      assertOutsideTransaction: () => authority.assertProviderCallOutsideTransaction(),
      configFactory,
      invoke: async (config) => {
        const startedMs = Date.now();
        const evidenceIds = authority.getEvidenceByReportVersion(context.reportVersionId).map((item) => item.evidence_id);
        const result = await invokeCommitmentChange({
          egress_command: { operation: "COMMITMENT_CHANGE", audit_id: context.auditId, privacy_revision_id: context.privacyRevisionId, report_version_id: context.reportVersionId, evidence_ids: evidenceIds },
          egress_dependencies: familyEgress,
          config,
          authority: referenceAuthority(authority, context),
          fetch_impl: options.fetchImpl,
        });
        return {
          value: result.candidates,
          runtime: invocationRuntime({
            config, startedMs,
            completedMs: Date.parse(result.provider_call.completed_at),
            usage: result.provider_call.usage,
            outputCounts: { commitments: result.candidates.commitments.length, changes: result.candidates.changes.length },
          }),
        };
      },
    })(),

    conflictCounterEvidence: (context: RunContext) => makeProviderCall({
      stage: FOUR_FAMILY_RUN_STAGES[2],
      measure: () => evidenceMeasure(authority, context),
      assertOutsideTransaction: () => authority.assertProviderCallOutsideTransaction(),
      configFactory,
      invoke: async (config) => {
        const startedMs = Date.now();
        const evidenceIds = authority.getEvidenceByReportVersion(context.reportVersionId).map((item) => item.evidence_id);
        const result = await invokeConflictReview({
          egress_command: { operation: "CONFLICT_REVIEW", audit_id: context.auditId, privacy_revision_id: context.privacyRevisionId, report_version_id: context.reportVersionId, evidence_ids: evidenceIds },
          egress_dependencies: familyEgress,
          config,
          authority: referenceAuthority(authority, context),
          fetch_impl: options.fetchImpl,
        });
        return {
          value: result.candidates,
          runtime: invocationRuntime({
            config, startedMs,
            completedMs: Date.parse(result.provider_call.completed_at),
            usage: result.provider_call.usage,
            outputCounts: { conflicts: result.candidates.conflicts.length },
          }),
        };
      },
    })(),

    proposeReportPresentation: (context: RunContext) => makeProviderCall({
      stage: FOUR_FAMILY_RUN_STAGES[3],
      measure: () => evidenceMeasure(authority, context),
      assertOutsideTransaction: () => authority.assertProviderCallOutsideTransaction(),
      configFactory,
      invoke: async (config) => {
        const startedMs = Date.now();
        const result = await invokeReportFinalize({
          egress_command: { operation: "REPORT_FINALIZE", audit_id: context.auditId, privacy_revision_id: context.privacyRevisionId, report_version_id: context.reportVersionId },
          egress_dependencies: familyEgress,
          config,
          authority: referenceAuthority(authority, context),
          fetch_impl: options.fetchImpl,
        });
        return {
          value: result.presentation_proposal,
          runtime: invocationRuntime({
            config, startedMs,
            completedMs: Date.parse(result.provider_call.completed_at),
            usage: result.provider_call.usage,
            outputCounts: { unknown: 0 },
          }),
        };
      },
    })(),
  });
}
