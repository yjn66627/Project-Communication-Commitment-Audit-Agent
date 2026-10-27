import { z } from "zod";
import { ApplicationError } from "../errors.js";
import {
  createProviderCallId,
} from "../../shared/ids/random-ids.js";
import {
  FOUR_FAMILY_RUN_STAGES,
  type FourFamilyProviderPort,
  type FourFamilyProviderPortFactory,
  type FourFamilyRunResult,
  type FourFamilyRunStage,
  type ProviderCallMetadata,
  type ReportRunPersistencePort,
  type RunContext,
  type SafeRunFailureCategory,
} from "./four-family-run-ports.js";

const RunCommandSchema = z.object({ auditId: z.string().startsWith("aud_") }).strict();
const SafeFailureCategories = new Set<SafeRunFailureCategory>([
  "CONFIG_MISSING", "CONFIG_INVALID", "EGRESS_DENIED", "WIRE_SCHEMA_FAILURE", "TRUST_FAILURE",
  "REFERENCE_FAILURE", "PROVIDER_TRANSPORT_FAILURE", "PROVIDER_STAGE_FAILURE", "STALE_PRIVACY",
  "LIFECYCLE_DRIFT", "LOCAL_AUTHORITY_FAILURE", "PERSISTENCE_FAILURE", "NO_VALID_EVIDENCE",
]);

function safeLabel(value: unknown, fallback: string): string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,96}$/u.test(value) ? value : fallback;
}

function safeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeCategory(value: unknown, fallback: SafeRunFailureCategory): SafeRunFailureCategory {
  return typeof value === "string" && SafeFailureCategories.has(value as SafeRunFailureCategory)
    ? value as SafeRunFailureCategory
    : fallback;
}

function normalizeMetadata(
  metadata: ProviderCallMetadata,
  stage: FourFamilyRunStage,
  status: "SUCCEEDED" | "FAILED",
  category: SafeRunFailureCategory | null,
): ProviderCallMetadata {
  const now = new Date().toISOString();
  const started = typeof metadata.started_at === "string" && Number.isFinite(Date.parse(metadata.started_at))
    ? new Date(metadata.started_at).toISOString() : now;
  const completed = typeof metadata.completed_at === "string" && Number.isFinite(Date.parse(metadata.completed_at))
    ? new Date(metadata.completed_at).toISOString() : now;
  const counts = metadata.output_counts === null || typeof metadata.output_counts !== "object"
    ? null
    : Object.fromEntries(Object.entries(metadata.output_counts)
      .filter(([key]) => ["evidence", "commitments", "changes", "conflicts", "unknown"].includes(key))
      .map(([key, value]) => [key, safeCount(value)])
      .filter((entry): entry is [string, number] => entry[1] !== null));

  return Object.freeze({
    provider_call_id: typeof metadata.provider_call_id === "string" && metadata.provider_call_id.startsWith("pcall_")
      ? metadata.provider_call_id : createProviderCallId(),
    stage,
    provider_name: safeLabel(metadata.provider_name, "configured"),
    model_name: safeLabel(metadata.model_name, "configured"),
    started_at: started,
    completed_at: completed < started ? started : completed,
    latency_ms: safeCount(metadata.latency_ms) ?? Math.max(0, Date.parse(completed) - Date.parse(started)),
    status,
    input_record_count: safeCount(metadata.input_record_count),
    input_size_chars: safeCount(metadata.input_size_chars),
    input_tokens: safeCount(metadata.input_tokens),
    output_tokens: safeCount(metadata.output_tokens),
    total_tokens: safeCount(metadata.total_tokens),
    cost_amount_micros: null,
    cost_currency: null,
    retry_count: 0,
    schema_valid: typeof metadata.schema_valid === "boolean" ? metadata.schema_valid : null,
    error_category: category === null ? null : safeCategory(category, "PROVIDER_STAGE_FAILURE"),
    output_counts: counts,
  });
}

function failedMetadata(stage: FourFamilyRunStage, category: SafeRunFailureCategory): ProviderCallMetadata {
  const now = new Date().toISOString();
  return normalizeMetadata({
    provider_call_id: createProviderCallId(), stage, provider_name: "unconfigured", model_name: "unconfigured",
    started_at: now, completed_at: now, latency_ms: 0, status: "FAILED", input_record_count: null,
    input_size_chars: null, input_tokens: null, output_tokens: null, total_tokens: null,
    cost_amount_micros: null, cost_currency: null, retry_count: 0, schema_valid: null,
    error_category: category, output_counts: null,
  }, stage, "FAILED", category);
}

function asFailure(metadata: ProviderCallMetadata, stage: FourFamilyRunStage, category: SafeRunFailureCategory): ProviderCallMetadata {
  return normalizeMetadata(metadata, stage, "FAILED", category);
}

function categorizedFailure(error: unknown): SafeRunFailureCategory | null {
  if (typeof error === "object" && error !== null && "category" in error) {
    return safeCategory(Reflect.get(error, "category"), "LOCAL_AUTHORITY_FAILURE");
  }
  return null;
}

/** Coordinates one version-bound sequential Run. Provider work never runs inside a storage method. */
export class FourFamilyRunService {
  #persistence: ReportRunPersistencePort;
  #providerFactory: FourFamilyProviderPortFactory | undefined;
  #activeAudits = new Map<string, Promise<FourFamilyRunResult>>();
  #accepting = true;
  #drainPromise: Promise<void> | undefined;

  constructor(input: Readonly<{
    persistence: ReportRunPersistencePort;
    providerFactory?: FourFamilyProviderPortFactory;
  }>) {
    this.#persistence = input.persistence;
    this.#providerFactory = input.providerFactory;
  }

  run(commandInput: unknown): Promise<FourFamilyRunResult> {
    const parsed = RunCommandSchema.safeParse(commandInput);
    if (!parsed.success) throw new ApplicationError("INVALID_RUN_COMMAND", "A local Audit identity is required.");
    if (!this.#accepting) throw new ApplicationError("STORE_CLOSED", "The application store is closed.");
    if (this.#activeAudits.has(parsed.data.auditId)) {
      throw new ApplicationError("RUN_ALREADY_ACTIVE", "A Run is already active for this Audit.");
    }

    const task = Promise.resolve().then(() => this.#execute(parsed.data.auditId)).finally(() => {
      this.#activeAudits.delete(parsed.data.auditId);
      if (!this.#accepting && this.#activeAudits.size === 0) this.#drainPromise = Promise.resolve();
    });
    this.#activeAudits.set(parsed.data.auditId, task);
    return task;
  }

  /** Called by Store.close: reject new work and wait for every started Run to settle. */
  closeAndDrain(): Promise<void> {
    this.#accepting = false;
    if (this.#drainPromise) return this.#drainPromise;
    this.#drainPromise = Promise.allSettled([...this.#activeAudits.values()]).then(() => undefined);
    return this.#drainPromise;
  }

  async #execute(auditId: string): Promise<FourFamilyRunResult> {
    const context = this.#persistence.startRun(auditId);
    let provider: FourFamilyProviderPort | undefined;
    const failedRun = (category: SafeRunFailureCategory, call?: ProviderCallMetadata): FourFamilyRunResult => {
      try {
        this.#persistence.failRun(context, category, call);
      } catch {
        throw new ApplicationError("PERSISTENCE_FAILURE", "The Run failure could not be safely persisted.");
      }
      return Object.freeze({ context, status: "FAILED" as const, failureCategory: category });
    };

    const assertAuthority = (): SafeRunFailureCategory | null => {
      try { this.#persistence.assertRunAuthority(context); return null; }
      catch (error: unknown) { return categorizedFailure(error) ?? "LOCAL_AUTHORITY_FAILURE"; }
    };

    const invoke = async <T>(
      stage: FourFamilyRunStage,
      operation: (port: FourFamilyProviderPort) => Promise<{ ok: true; value: T; providerCall: ProviderCallMetadata } | { ok: false; failureCategory: SafeRunFailureCategory; providerCall: ProviderCallMetadata }>,
    ): Promise<{ ok: true; value: T; providerCall: ProviderCallMetadata } | { ok: false; failureCategory: SafeRunFailureCategory; providerCall: ProviderCallMetadata }> => {
      const stale = assertAuthority();
      if (stale !== null) return { ok: false, failureCategory: stale, providerCall: failedMetadata(stage, stale) };
      try {
        provider ??= this.#providerFactory?.(this.#persistence);
        if (!provider) return { ok: false, failureCategory: "CONFIG_MISSING", providerCall: failedMetadata(stage, "CONFIG_MISSING") };
        const result = await operation(provider);
        return { ...result, providerCall: normalizeMetadata(result.providerCall, stage, result.ok ? "SUCCEEDED" : "FAILED", result.ok ? null : result.failureCategory) };
      } catch {
        return { ok: false, failureCategory: "PROVIDER_STAGE_FAILURE", providerCall: failedMetadata(stage, "PROVIDER_STAGE_FAILURE") };
      }
    };

    const evidence = await invoke(FOUR_FAMILY_RUN_STAGES[0], (port) => port.extractEvidence(context));
    if (!evidence.ok) return failedRun(evidence.failureCategory, asFailure(evidence.providerCall, evidence.providerCall.stage, evidence.failureCategory));
    try { this.#persistence.persistEvidenceStage(context, evidence.value, evidence.providerCall); }
    catch (error) {
      const category = categorizedFailure(error) ?? "PERSISTENCE_FAILURE";
      return failedRun(category, asFailure(evidence.providerCall, FOUR_FAMILY_RUN_STAGES[0], category));
    }
    if (evidence.value.length === 0) return failedRun("NO_VALID_EVIDENCE");

    const commitmentChange = await invoke(FOUR_FAMILY_RUN_STAGES[1], (port) => port.commitmentChange(context));
    if (!commitmentChange.ok) return failedRun(commitmentChange.failureCategory, asFailure(commitmentChange.providerCall, FOUR_FAMILY_RUN_STAGES[1], commitmentChange.failureCategory));
    if (commitmentChange.value.final_authority !== false || commitmentChange.value.provider_assertion_only !== true) {
      return failedRun("TRUST_FAILURE", asFailure(commitmentChange.providerCall, FOUR_FAMILY_RUN_STAGES[1], "TRUST_FAILURE"));
    }
    try { this.#persistence.persistCommitmentChangeStage(context, commitmentChange.value, commitmentChange.providerCall); }
    catch (error) {
      const category = categorizedFailure(error) ?? "PERSISTENCE_FAILURE";
      return failedRun(category, asFailure(commitmentChange.providerCall, FOUR_FAMILY_RUN_STAGES[1], category));
    }

    const conflict = await invoke(FOUR_FAMILY_RUN_STAGES[2], (port) => port.conflictCounterEvidence(context));
    if (!conflict.ok) return failedRun(conflict.failureCategory, asFailure(conflict.providerCall, FOUR_FAMILY_RUN_STAGES[2], conflict.failureCategory));
    if (conflict.value.final_authority !== false || conflict.value.provider_assertion_only !== true) {
      return failedRun("TRUST_FAILURE", asFailure(conflict.providerCall, FOUR_FAMILY_RUN_STAGES[2], "TRUST_FAILURE"));
    }
    try { this.#persistence.persistConflictStage(context, conflict.value, conflict.providerCall); }
    catch (error) {
      const category = categorizedFailure(error) ?? "PERSISTENCE_FAILURE";
      return failedRun(category, asFailure(conflict.providerCall, FOUR_FAMILY_RUN_STAGES[2], category));
    }

    const finalize = await invoke(FOUR_FAMILY_RUN_STAGES[3], (port) => port.proposeReportPresentation(context));
    if (!finalize.ok) return failedRun(finalize.failureCategory, asFailure(finalize.providerCall, FOUR_FAMILY_RUN_STAGES[3], finalize.failureCategory));
    if (finalize.value.final_authority !== false || finalize.value.provider_assertion_only !== true) {
      return failedRun("TRUST_FAILURE", asFailure(finalize.providerCall, FOUR_FAMILY_RUN_STAGES[3], "TRUST_FAILURE"));
    }
    try { this.#persistence.completeRun(context, finalize.providerCall); }
    catch (error) {
      const category = categorizedFailure(error) ?? "PERSISTENCE_FAILURE";
      return failedRun(category, asFailure(finalize.providerCall, FOUR_FAMILY_RUN_STAGES[3], category));
    }
    return Object.freeze({ context, status: "COMPLETED" as const, failureCategory: null });
  }
}
