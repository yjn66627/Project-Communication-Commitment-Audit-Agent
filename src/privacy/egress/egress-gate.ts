import { PersistenceError } from "../../db/persistence-errors.js";
import type { SanitizedCanonicalRecordRevision } from "../../domain/schemas/canonical.js";
import { ChangeSchema } from "../../domain/schemas/change.js";
import { CommitmentSchema } from "../../domain/schemas/commitment.js";
import { PotentialConflictSchema } from "../../domain/schemas/conflict.js";
import { EvidenceSchema } from "../../domain/schemas/evidence.js";
import { AuditReportSchema, ReportVersionSchema } from "../../domain/schemas/report.js";
import { evaluateSourceNamePolicy } from "../detection/source-name-policy.js";
import { detectSecrets } from "../detection/rules/secret.js";
import { detectUrls } from "../detection/rules/url.js";
import {
  EgressCommandSchema,
  EgressSafePayloadSchema,
  FamilyEgressCommandSchema,
  FamilyEgressSafePayloadSchema,
  MAX_FAMILY_REFERENCES,
  type EgressCommand,
  type EgressGateDependencies,
  type EgressGateResult,
  type EgressSafePayload,
  type EgressSafeRecord,
  type FamilyEgressCommand,
  type FamilyEgressGateDependencies,
  type FamilyEgressGateResult,
} from "./contracts.js";
import { safeCategoryForEgressCode, type EgressDenyCode } from "./errors.js";

type ForbiddenFamily = "RAW" | "MAPPING" | "SECRET";

const RAW_KEYS = new Set(["raw", "raw_content", "raw_input", "raw_records"]);
const MAPPING_KEYS = new Set([
  "mapping",
  "mappings",
  "privacy_mapping",
  "mapping_vault",
  "original",
  "original_value",
  "normalized_original_value",
  "normalized_key",
  "aliases",
  "revision_salt",
]);
const SECRET_KEYS = new Set([
  "authorization",
  "api_key",
  "apikey",
  "credential",
  "credentials",
  "access_token",
  "client_secret",
  "password",
  "secret",
]);

function canonicalKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/gu, "_");
}

function forbiddenFamilyForKey(key: string): ForbiddenFamily | null {
  const canonical = canonicalKey(key);
  if (RAW_KEYS.has(canonical)) return "RAW";
  if (MAPPING_KEYS.has(canonical)) return "MAPPING";
  if (SECRET_KEYS.has(canonical)) return "SECRET";
  return null;
}

function ownCommandInput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]]),
  );
}

function scanForbiddenKeys(value: unknown): ForbiddenFamily | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = scanForbiddenKeys(item);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const own = forbiddenFamilyForKey(key);
    if (own !== null) return own;
    const nested = scanForbiddenKeys(child);
    if (nested !== null) return nested;
  }
  return null;
}

function deny(code: EgressDenyCode): EgressGateResult {
  return Object.freeze({ decision: "DENY" as const, code, safe_category: safeCategoryForEgressCode(code) });
}

function denyForForbiddenFamily(family: ForbiddenFamily): EgressGateResult {
  if (family === "RAW") return deny("EGRESS_RAW_FIELD_DETECTED");
  if (family === "MAPPING") return deny("EGRESS_MAPPING_DETECTED");
  return deny("EGRESS_SECRET_DETECTED");
}

function hasSecretInString(value: string): boolean {
  try {
    if (detectSecrets("rec_egress_scan", "CONTENT", value).length > 0) return true;
    return detectUrls("rec_egress_scan", "CONTENT", value).credentialSecrets.length > 0;
  } catch {
    throw new Error("EGRESS_SECRET_SCAN_INTERNAL");
  }
}

function scanStringLeavesForSecret(value: unknown): boolean {
  if (typeof value === "string") return hasSecretInString(value);
  if (Array.isArray(value)) return value.some((item) => scanStringLeavesForSecret(item));
  if (typeof value !== "object" || value === null) return false;
  return Object.values(value as Record<string, unknown>).some((item) => scanStringLeavesForSecret(item));
}

function safeRecordFromPersisted(record: SanitizedCanonicalRecordRevision): EgressSafeRecord {
  return Object.freeze({
    record_revision_id: record.record_revision_id,
    record_id: record.record_id,
    source_name: record.source_name,
    author: record.author,
    timestamp: record.timestamp,
    sanitized_content: record.sanitized_content,
    sequence: record.sequence,
  });
}

function compareRecords(left: SanitizedCanonicalRecordRevision, right: SanitizedCanonicalRecordRevision): number {
  const sequenceDelta = left.sequence - right.sequence;
  if (sequenceDelta !== 0) return sequenceDelta;
  if (left.record_id < right.record_id) return -1;
  if (left.record_id > right.record_id) return 1;
  return 0;
}

function validateAggregateBinding(command: EgressCommand, aggregate: ReturnType<EgressGateDependencies["privacy"]["getConfirmedPrivacyAggregateSafe"]>): EgressGateResult | null {
  if (
    aggregate.revision.audit_id !== command.audit_id ||
    aggregate.revision.privacy_revision_id !== command.privacy_revision_id
  ) {
    return deny("PRIVACY_REVISION_MISMATCH");
  }
  for (const record of aggregate.records) {
    if (record.audit_id !== command.audit_id || record.privacy_revision_id !== command.privacy_revision_id) {
      return deny("PRIVACY_REVISION_MISMATCH");
    }
  }
  return null;
}

function validateSourceNames(records: readonly SanitizedCanonicalRecordRevision[]): EgressGateResult | null {
  for (const record of records) {
    const policy = evaluateSourceNamePolicy(record.source_name, []);
    if (policy.policy === "SAFE_LABEL_REQUIRED") return deny("SOURCE_REFERENCE_INVALID");
  }
  return null;
}

function readPrivacy(command: EgressCommand, deps: EgressGateDependencies):
  | { ok: true; aggregate: ReturnType<EgressGateDependencies["privacy"]["getConfirmedPrivacyAggregateSafe"]> }
  | { ok: false; result: EgressGateResult } {
  try {
    return { ok: true, aggregate: deps.privacy.getConfirmedPrivacyAggregateSafe(command.privacy_revision_id) };
  } catch (error: unknown) {
    if (error instanceof PersistenceError && error.code === "PERSISTENCE_NOT_FOUND") {
      return { ok: false, result: deny("PRIVACY_REVISION_NOT_CONFIRMED") };
    }
    return { ok: false, result: deny("EGRESS_INTERNAL_FAILURE") };
  }
}

function validateReport(command: EgressCommand, deps: EgressGateDependencies): EgressGateResult | null {
  if (command.report_version_id === undefined) return null;
  if (deps.report === undefined) return deny("EGRESS_INTERNAL_FAILURE");
  try {
    const report = deps.report.getReportVersionById(command.report_version_id);
    const forbidden = scanForbiddenKeys(report);
    if (forbidden !== null) return denyForForbiddenFamily(forbidden);
    if (report.audit_id !== command.audit_id) return deny("REPORT_REFERENCE_INVALID");
    if (report.privacy_revision_id !== command.privacy_revision_id) return deny("PRIVACY_REVISION_MISMATCH");
    return null;
  } catch (error: unknown) {
    if (error instanceof PersistenceError && error.code === "PERSISTENCE_NOT_FOUND") {
      return deny("REPORT_REFERENCE_INVALID");
    }
    return deny("EGRESS_INTERNAL_FAILURE");
  }
}

function buildPayload(command: EgressCommand, records: readonly SanitizedCanonicalRecordRevision[]): EgressSafePayload {
  const safeRecords = [...records].sort(compareRecords).map(safeRecordFromPersisted);
  const frozenRecords: readonly EgressSafeRecord[] = Object.freeze(safeRecords);
  return Object.freeze({
    audit_id: command.audit_id,
    privacy_revision_id: command.privacy_revision_id,
    records: frozenRecords,
    ...(command.report_version_id === undefined ? {} : { report_version_id: command.report_version_id }),
  });
}

export function evaluateEgressGate(commandInput: unknown, deps: EgressGateDependencies): EgressGateResult {
  try {
    // Command validation is deliberately first: any unknown/extra command field maps to the generic allowlist code.
    const commandParsed = EgressCommandSchema.safeParse(ownCommandInput(commandInput));
    if (!commandParsed.success) return deny("EGRESS_PAYLOAD_NOT_ALLOWLISTED");
    const command = commandParsed.data;

    const privacyRead = readPrivacy(command, deps);
    if (!privacyRead.ok) return privacyRead.result;
    const aggregate = privacyRead.aggregate;

    const aggregateForbidden = scanForbiddenKeys(aggregate);
    if (aggregateForbidden !== null) return denyForForbiddenFamily(aggregateForbidden);

    const bindingFailure = validateAggregateBinding(command, aggregate);
    if (bindingFailure !== null) return bindingFailure;

    const reportFailure = validateReport(command, deps);
    if (reportFailure !== null) return reportFailure;

    const sourceFailure = validateSourceNames(aggregate.records);
    if (sourceFailure !== null) return sourceFailure;

    const payload = buildPayload(command, aggregate.records);

    const payloadForbidden = scanForbiddenKeys(payload);
    if (payloadForbidden !== null) return denyForForbiddenFamily(payloadForbidden);

    if (!EgressSafePayloadSchema.safeParse(payload).success) {
      return deny("EGRESS_PAYLOAD_NOT_ALLOWLISTED");
    }

    if (scanStringLeavesForSecret(payload)) return deny("EGRESS_SECRET_DETECTED");

    return Object.freeze({ decision: "ALLOW" as const, payload });
  } catch {
    return deny("EGRESS_INTERNAL_FAILURE");
  }
}

/*
 * DEV05-C family extension. The original evaluateEgressGate path above is
 * unchanged. Every variable byte sent by a family invoker is selected here,
 * then allowlisted, secret-scanned and frozen before ALLOW.
 */
const MAX_FAMILY_PAYLOAD_CHARS = 200_000;

class FamilyGateFailure {
  constructor(readonly code: EgressDenyCode) {}
}

function familyDeny(code: EgressDenyCode): Extract<EgressGateResult, { decision: "DENY" }> {
  return Object.freeze({ decision: "DENY" as const, code, safe_category: safeCategoryForEgressCode(code) });
}

function familyFail(code: EgressDenyCode): never {
  throw new FamilyGateFailure(code);
}

function inspectFamilyAuthority(value: unknown): void {
  const forbidden = scanForbiddenKeys(value);
  if (forbidden === "RAW") familyFail("EGRESS_RAW_FIELD_DETECTED");
  if (forbidden === "MAPPING") familyFail("EGRESS_MAPPING_DETECTED");
  if (forbidden === "SECRET") familyFail("EGRESS_SECRET_DETECTED");
  if (scanStringLeavesForSecret(value)) familyFail("EGRESS_SECRET_DETECTED");
}

function readFamilyAuthority<T>(read: () => T, missingCode: EgressDenyCode): T {
  try {
    return read();
  } catch (error: unknown) {
    if (error instanceof PersistenceError && error.code === "PERSISTENCE_NOT_FOUND") {
      return familyFail(missingCode);
    }
    return familyFail("EGRESS_INTERNAL_FAILURE");
  }
}

function assertUniqueBoundedIds(values: readonly string[], code: EgressDenyCode): void {
  if (values.length > MAX_FAMILY_REFERENCES || new Set(values).size !== values.length) {
    familyFail(code);
  }
}

function freezeFamilyTree<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) freezeFamilyTree(item);
    } else {
      for (const item of Object.values(value as Record<string, unknown>)) freezeFamilyTree(item);
    }
    Object.freeze(value);
  }
  return value;
}

function readFamilyEvidence(
  evidenceId: string,
  command: FamilyEgressCommand,
  records: readonly EgressSafeRecord[],
  deps: FamilyEgressGateDependencies,
) {
  const raw = readFamilyAuthority(() => deps.evidence.getEvidenceById(evidenceId), "SOURCE_REFERENCE_INVALID");
  inspectFamilyAuthority(raw);
  const parsed = EvidenceSchema.safeParse(raw);
  if (!parsed.success || parsed.data.evidence_id !== evidenceId) familyFail("SOURCE_REFERENCE_INVALID");
  const value = parsed.data;
  if (value.report_version_id !== command.report_version_id) familyFail("REPORT_REFERENCE_INVALID");
  if (value.privacy_revision_id !== command.privacy_revision_id) familyFail("PRIVACY_REVISION_MISMATCH");

  const record = records.find((item) => item.record_revision_id === value.record_revision_id);
  if (
    record === undefined ||
    record.record_id !== value.record_id ||
    record.source_name !== value.source_ref.source_name ||
    record.sequence !== value.source_ref.sequence ||
    value.source_ref.char_end > record.sanitized_content.length ||
    record.sanitized_content.slice(value.source_ref.char_start, value.source_ref.char_end) !== value.excerpt
  ) {
    familyFail("SOURCE_REFERENCE_INVALID");
  }

  return {
    evidence_id: value.evidence_id,
    record_revision_id: value.record_revision_id,
    evidence_type: value.evidence_type,
    excerpt: value.excerpt,
  };
}

function readReportFinalizeContext(
  command: Extract<FamilyEgressCommand, { operation: "REPORT_FINALIZE" }>,
  report: ReturnType<FamilyEgressGateDependencies["report"]["getReportVersionById"]>,
  records: readonly EgressSafeRecord[],
  deps: FamilyEgressGateDependencies,
) {
  if (deps.finalize === undefined) familyFail("EGRESS_INTERNAL_FAILURE");
  const finalize = deps.finalize;
  const raw = readFamilyAuthority(
    () => finalize.getLocalReportByVersionId(command.report_version_id),
    "REPORT_REFERENCE_INVALID",
  );
  inspectFamilyAuthority(raw);
  const parsed = AuditReportSchema.safeParse(raw);
  const reportParsed = ReportVersionSchema.safeParse(report);
  if (!parsed.success || !reportParsed.success) familyFail("REPORT_REFERENCE_INVALID");
  const localReport = parsed.data;
  if (JSON.stringify(localReport.report_version) !== JSON.stringify(reportParsed.data)) {
    familyFail("REPORT_REFERENCE_INVALID");
  }

  const evidenceIds = localReport.evidence_ledger;
  const commitmentIds = localReport.commitment_ledger;
  const changeIds = localReport.requirement_decision_change_log;
  const conflictIds = localReport.conflict_counter_evidence_review;
  for (const ids of [evidenceIds, commitmentIds, changeIds, conflictIds]) {
    assertUniqueBoundedIds(ids, "REPORT_REFERENCE_INVALID");
  }
  if (
    localReport.audit_summary.items.length > 128 ||
    localReport.audit_summary.unresolved_items.length > MAX_FAMILY_REFERENCES ||
    localReport.timeline.length > 128 ||
    localReport.missing_evidence_and_uncertainty.length > MAX_FAMILY_REFERENCES
  ) {
    familyFail("EGRESS_PAYLOAD_NOT_ALLOWLISTED");
  }

  const evidence = evidenceIds.map((id) => readFamilyEvidence(id, command, records, deps));
  const allowedEvidence = new Set(evidenceIds);
  const requireEvidence = (ids: readonly string[]): void => {
    if (new Set(ids).size !== ids.length || ids.some((id) => !allowedEvidence.has(id))) {
      familyFail("SOURCE_REFERENCE_INVALID");
    }
  };

  const commitments = commitmentIds.map((id) => {
    const rawValue = readFamilyAuthority(() => finalize.getCommitmentById(id), "REPORT_REFERENCE_INVALID");
    inspectFamilyAuthority(rawValue);
    const result = CommitmentSchema.safeParse(rawValue);
    if (!result.success || result.data.commitment_id !== id || result.data.report_version_id !== command.report_version_id) {
      familyFail("REPORT_REFERENCE_INVALID");
    }
    const value = result.data;
    requireEvidence(value.evidence_ids);
    requireEvidence(value.status_evidence_ids);
    return {
      commitment_id: value.commitment_id,
      classification: value.classification,
      epistemic_status: value.epistemic_status,
      action_or_deliverable: value.action_or_deliverable,
      evidence_ids: value.evidence_ids,
      lifecycle_status: value.lifecycle_status,
    };
  });

  const changes = changeIds.map((id) => {
    const rawValue = readFamilyAuthority(() => finalize.getChangeById(id), "REPORT_REFERENCE_INVALID");
    inspectFamilyAuthority(rawValue);
    const result = ChangeSchema.safeParse(rawValue);
    if (!result.success || result.data.change_id !== id || result.data.report_version_id !== command.report_version_id) {
      familyFail("REPORT_REFERENCE_INVALID");
    }
    const value = result.data;
    requireEvidence(value.evidence_ids);
    return {
      change_id: value.change_id,
      classification: value.classification,
      epistemic_status: value.epistemic_status,
      change_type: value.change_type,
      subject: value.subject,
      after_summary: value.after_summary,
      evidence_ids: value.evidence_ids,
    };
  });

  const conflicts = conflictIds.map((id) => {
    const rawValue = readFamilyAuthority(() => finalize.getConflictById(id), "REPORT_REFERENCE_INVALID");
    inspectFamilyAuthority(rawValue);
    const result = PotentialConflictSchema.safeParse(rawValue);
    if (!result.success || result.data.conflict_id !== id || result.data.report_version_id !== command.report_version_id) {
      familyFail("REPORT_REFERENCE_INVALID");
    }
    const value = result.data;
    requireEvidence(value.claim_a.evidence_ids);
    requireEvidence(value.claim_b.evidence_ids);
    requireEvidence(value.counter_evidence_ids);
    return {
      conflict_id: value.conflict_id,
      epistemic_status: value.epistemic_status,
      claim_a: value.claim_a,
      claim_b: value.claim_b,
      counter_evidence_ids: value.counter_evidence_ids,
      conflict_reason: value.conflict_reason,
      conflicted: value.conflicted,
    };
  });

  const allowedDomain = new Set([...commitmentIds, ...changeIds, ...conflictIds]);
  if (allowedDomain.size !== commitmentIds.length + changeIds.length + conflictIds.length) {
    familyFail("REPORT_REFERENCE_INVALID");
  }
  for (const item of localReport.audit_summary.items) {
    requireEvidence(item.evidence_ids);
    if (new Set(item.domain_ids).size !== item.domain_ids.length ||
        item.domain_ids.some((id) => !allowedDomain.has(id))) {
      familyFail("REPORT_REFERENCE_INVALID");
    }
  }
  for (const item of localReport.timeline) requireEvidence(item.evidence_ids);
  const missingIds = localReport.missing_evidence_and_uncertainty.map((item) => item.item_id);
  if (new Set(missingIds).size !== missingIds.length) familyFail("REPORT_REFERENCE_INVALID");
  for (const item of localReport.missing_evidence_and_uncertainty) requireEvidence(item.known_evidence_ids);

  return {
    localReport: freezeFamilyTree(localReport),
    safeFields: {
      evidence,
      local_summary: localReport.audit_summary,
      timeline: localReport.timeline,
      commitments,
      changes,
      conflicts,
      missing_evidence: localReport.missing_evidence_and_uncertainty,
    },
  };
}

export function evaluateFamilyEgressGate(
  commandInput: unknown,
  deps: FamilyEgressGateDependencies,
): FamilyEgressGateResult {
  try {
    const parsedCommand = FamilyEgressCommandSchema.safeParse(ownCommandInput(commandInput));
    if (!parsedCommand.success) return familyDeny("EGRESS_PAYLOAD_NOT_ALLOWLISTED");
    const command = parsedCommand.data;

    let reportRead: ReturnType<FamilyEgressGateDependencies["report"]["getReportVersionById"]> | null = null;
    const base = evaluateEgressGate(
      {
        audit_id: command.audit_id,
        privacy_revision_id: command.privacy_revision_id,
        report_version_id: command.report_version_id,
      },
      {
        privacy: deps.privacy,
        report: {
          getReportVersionById(id) {
            reportRead = deps.report.getReportVersionById(id);
            return reportRead;
          },
        },
      },
    );
    if (base.decision === "DENY") return base;
    if (reportRead === null) familyFail("EGRESS_INTERNAL_FAILURE");
    const reportResult = ReportVersionSchema.safeParse(reportRead);
    if (!reportResult.success) familyFail("REPORT_REFERENCE_INVALID");
    const report = reportResult.data;
    if (
      report.report_version_id !== command.report_version_id ||
      report.audit_id !== command.audit_id ||
      report.privacy_revision_id !== command.privacy_revision_id
    ) {
      familyFail("REPORT_REFERENCE_INVALID");
    }
    if (report.status !== "DRAFT" && report.status !== "RUNNING") {
      familyFail("REPORT_REFERENCE_INVALID");
    }
    if (command.operation === "REPORT_FINALIZE" && report.status !== "RUNNING") {
      familyFail("REPORT_REFERENCE_INVALID");
    }

    let candidate: unknown;
    let localReport: ReturnType<typeof readReportFinalizeContext>["localReport"] | undefined;
    if (command.operation === "REPORT_FINALIZE") {
      const context = readReportFinalizeContext(command, report, base.payload.records, deps);
      localReport = context.localReport;
      candidate = {
        operation: command.operation,
        audit_id: command.audit_id,
        privacy_revision_id: command.privacy_revision_id,
        report_version_id: command.report_version_id,
        ...context.safeFields,
      };
    } else {
      assertUniqueBoundedIds(command.evidence_ids, "SOURCE_REFERENCE_INVALID");
      candidate = {
        operation: command.operation,
        audit_id: command.audit_id,
        privacy_revision_id: command.privacy_revision_id,
        report_version_id: command.report_version_id,
        evidence: command.evidence_ids.map((id) => readFamilyEvidence(id, command, base.payload.records, deps)),
      };
    }

    inspectFamilyAuthority(candidate);
    const safe = FamilyEgressSafePayloadSchema.safeParse(candidate);
    if (!safe.success || JSON.stringify(safe.data).length > MAX_FAMILY_PAYLOAD_CHARS) {
      familyFail("EGRESS_PAYLOAD_NOT_ALLOWLISTED");
    }

    return Object.freeze({
      decision: "ALLOW" as const,
      payload: freezeFamilyTree(safe.data),
      ...(localReport === undefined ? {} : { local_report: localReport }),
    });
  } catch (error: unknown) {
    return familyDeny(error instanceof FamilyGateFailure ? error.code : "EGRESS_INTERNAL_FAILURE");
  }
}
