import type { output, ZodTypeAny } from "zod";

import type {
  audits,
  canonicalRecords,
  changes,
  commitments,
  conflicts,
  evidence as evidenceTable,
  privacyMappings,
  privacyRevisions,
  providerCalls,
  reportVersions,
} from "../schema.js";
import {
  SanitizedCanonicalRecordRevisionSchema,
  type SanitizedCanonicalRecordRevision,
} from "../../domain/schemas/canonical.js";
import {
  ChangeSchema,
  type RequirementDecisionChange,
} from "../../domain/schemas/change.js";
import {
  CommitmentSchema,
  type Commitment,
} from "../../domain/schemas/commitment.js";
import {
  PotentialConflictSchema,
  type PotentialConflict,
} from "../../domain/schemas/conflict.js";
import { EvidenceSchema, type Evidence } from "../../domain/schemas/evidence.js";
import {
  ConfirmedPrivacyRevisionSchema,
  PrivacyMappingSchema,
  type ConfirmedPrivacyRevision,
  type PrivacyMapping,
} from "../../domain/schemas/privacy.js";
import { ReportVersionSchema, type ReportVersion } from "../../domain/schemas/report.js";
import { jsonFieldCodecs } from "./json-codec.js";
import {
  AuditPersistenceInputSchema,
  IsoUtcTextSchema,
  PersistenceBoundaryError,
  ProviderCallPersistenceSchema,
  SafeAuditViewSchema,
  type AuditPersistenceInput,
  type ProviderCallPersistence,
  type SafeAuditView,
} from "./persistence-types.js";

type AuditRow = typeof audits.$inferSelect;
type AuditInsertRow = typeof audits.$inferInsert;
type PrivacyRevisionRow = typeof privacyRevisions.$inferSelect;
type PrivacyRevisionInsertRow = typeof privacyRevisions.$inferInsert;
type CanonicalRecordRow = typeof canonicalRecords.$inferSelect;
type CanonicalRecordInsertRow = typeof canonicalRecords.$inferInsert;
type PrivacyMappingRow = typeof privacyMappings.$inferSelect;
type PrivacyMappingInsertRow = typeof privacyMappings.$inferInsert;
type ReportVersionRow = typeof reportVersions.$inferSelect;
type ReportVersionInsertRow = typeof reportVersions.$inferInsert;
type EvidenceRow = typeof evidenceTable.$inferSelect;
type EvidenceInsertRow = typeof evidenceTable.$inferInsert;
type CommitmentRow = typeof commitments.$inferSelect;
type CommitmentInsertRow = typeof commitments.$inferInsert;
type ChangeRow = typeof changes.$inferSelect;
type ChangeInsertRow = typeof changes.$inferInsert;
type ConflictRow = typeof conflicts.$inferSelect;
type ConflictInsertRow = typeof conflicts.$inferInsert;
type ProviderCallRow = typeof providerCalls.$inferSelect;
type ProviderCallInsertRow = typeof providerCalls.$inferInsert;

function parseForWrite<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  objectName: string,
): output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PersistenceBoundaryError(
      "DOMAIN_VALIDATION_ERROR",
      objectName,
      `Domain validation failed before row mapping: ${objectName}`,
    );
  }
  return parsed.data;
}

function parseForRead<S extends ZodTypeAny>(
  schema: S,
  value: unknown,
  objectName: string,
): output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new PersistenceBoundaryError(
      "PERSISTENCE_INTEGRITY_ERROR",
      objectName,
      `Persisted row cannot be reconstructed under the frozen contract: ${objectName}`,
    );
  }
  return parsed.data;
}

function normalizeUtc(value: string): string {
  return new Date(value).toISOString();
}

function requireUtc(value: string, field: string): string {
  const parsed = IsoUtcTextSchema.safeParse(value);
  if (!parsed.success) {
    throw new PersistenceBoundaryError(
      "PERSISTENCE_INTEGRITY_ERROR",
      field,
      `Persisted UTC timestamp is invalid: ${field}`,
    );
  }
  return parsed.data;
}

function nullableUtc(value: string | null, field: string): string | null {
  return value === null ? null : requireUtc(value, field);
}

// Audit persistence shape. Safe read deliberately omits revision_salt.
export function auditToRow(input: unknown): AuditInsertRow {
  const value = parseForWrite(AuditPersistenceInputSchema, input, "AuditPersistenceInput");
  return {
    auditId: value.audit_id,
    revisionSalt: value.revision_salt,
    createdAt: value.created_at,
  };
}

export function auditRowToSafeView(row: AuditRow): SafeAuditView {
  const value = {
    audit_id: row.auditId,
    created_at: requireUtc(row.createdAt, "audits.created_at"),
  };
  return parseForRead(SafeAuditViewSchema, value, "SafeAuditView");
}

/** Explicit local-only path for ID computation; never use for ordinary DTOs/logs/exports. */
export function auditRowToLocalIdentity(row: AuditRow): AuditPersistenceInput {
  const value = {
    audit_id: row.auditId,
    revision_salt: row.revisionSalt,
    created_at: requireUtc(row.createdAt, "audits.created_at"),
  };
  return parseForRead(AuditPersistenceInputSchema, value, "AuditPersistenceInput");
}

export function confirmedPrivacyRevisionToRow(input: unknown): PrivacyRevisionInsertRow {
  const value = parseForWrite(
    ConfirmedPrivacyRevisionSchema,
    input,
    "ConfirmedPrivacyRevision",
  );
  return {
    privacyRevisionId: value.privacy_revision_id,
    auditId: value.audit_id,
    algorithm: value.algorithm,
    confirmedAt: normalizeUtc(value.confirmed_at),
    recordCount: value.record_count,
    mappingCount: value.mapping_count,
  };
}

export function privacyRevisionRowToDomain(row: PrivacyRevisionRow): ConfirmedPrivacyRevision {
  return parseForRead(
    ConfirmedPrivacyRevisionSchema,
    {
      privacy_revision_id: row.privacyRevisionId,
      audit_id: row.auditId,
      confirmation_state: "CONFIRMED",
      algorithm: row.algorithm,
      confirmed_at: requireUtc(row.confirmedAt, "privacy_revisions.confirmed_at"),
      record_count: row.recordCount,
      mapping_count: row.mappingCount,
    },
    "ConfirmedPrivacyRevision",
  );
}

export function canonicalRecordToRow(input: unknown): CanonicalRecordInsertRow {
  const value = parseForWrite(
    SanitizedCanonicalRecordRevisionSchema,
    input,
    "SanitizedCanonicalRecordRevision",
  );
  return {
    recordRevisionId: value.record_revision_id,
    auditId: value.audit_id,
    recordId: value.record_id,
    privacyRevisionId: value.privacy_revision_id,
    sourceType: value.source_type,
    sourceName: value.source_name,
    author: value.author,
    timestamp: value.timestamp,
    sanitizedContent: value.sanitized_content,
    sequence: value.sequence,
    metadataJson:
      value.metadata === undefined ? null : jsonFieldCodecs.canonicalMetadata.encode(value.metadata),
  };
}

export function canonicalRecordRowToDomain(row: CanonicalRecordRow): SanitizedCanonicalRecordRevision {
  const metadata =
    row.metadataJson === null ? undefined : jsonFieldCodecs.canonicalMetadata.decode(row.metadataJson);
  const candidate: Record<string, unknown> = {
    record_revision_id: row.recordRevisionId,
    audit_id: row.auditId,
    record_id: row.recordId,
    privacy_revision_id: row.privacyRevisionId,
    source_type: row.sourceType,
    source_name: row.sourceName,
    author: row.author,
    timestamp: row.timestamp,
    sanitized_content: row.sanitizedContent,
    sequence: row.sequence,
  };
  if (metadata !== undefined) candidate.metadata = metadata;
  return parseForRead(
    SanitizedCanonicalRecordRevisionSchema,
    candidate,
    "SanitizedCanonicalRecordRevision",
  );
}

export function privacyMappingToRow(input: unknown, createdAt: string): PrivacyMappingInsertRow {
  const value = parseForWrite(PrivacyMappingSchema, input, "PrivacyMapping");
  const persistedCreatedAt = parseForWrite(IsoUtcTextSchema, createdAt, "privacy_mappings.created_at");
  return {
    mappingId: value.mapping_id,
    auditId: value.audit_id,
    privacyRevisionId: value.privacy_revision_id,
    entityType: value.entity_type,
    placeholder: value.placeholder,
    originalValue: value.original_value,
    normalizedKey: value.normalized_key,
    aliasesJson: jsonFieldCodecs.privacyMappingAliases.encode(value.aliases),
    active: value.active,
    createdAt: persistedCreatedAt,
  };
}

export function privacyMappingRowToDomain(row: PrivacyMappingRow): PrivacyMapping {
  requireUtc(row.createdAt, "privacy_mappings.created_at");
  return parseForRead(
    PrivacyMappingSchema,
    {
      mapping_id: row.mappingId,
      audit_id: row.auditId,
      privacy_revision_id: row.privacyRevisionId,
      entity_type: row.entityType,
      placeholder: row.placeholder,
      original_value: row.originalValue,
      normalized_key: row.normalizedKey,
      aliases: jsonFieldCodecs.privacyMappingAliases.decode(row.aliasesJson),
      active: row.active,
    },
    "PrivacyMapping",
  );
}

export function reportVersionToRow(input: unknown): ReportVersionInsertRow {
  const value = parseForWrite(ReportVersionSchema, input, "ReportVersion");
  return {
    reportVersionId: value.report_version_id,
    auditId: value.audit_id,
    privacyRevisionId: value.privacy_revision_id,
    parentReportVersionId: value.parent_report_version_id,
    versionNumber: value.version_number,
    status: value.status,
    changesSummary: value.changes_summary,
    createdAt: normalizeUtc(value.created_at),
    startedAt: value.started_at === null ? null : normalizeUtc(value.started_at),
    completedAt: value.completed_at === null ? null : normalizeUtc(value.completed_at),
  };
}

export function reportVersionRowToDomain(row: ReportVersionRow): ReportVersion {
  return parseForRead(
    ReportVersionSchema,
    {
      report_version_id: row.reportVersionId,
      audit_id: row.auditId,
      privacy_revision_id: row.privacyRevisionId,
      parent_report_version_id: row.parentReportVersionId,
      version_number: row.versionNumber,
      status: row.status,
      changes_summary: row.changesSummary,
      created_at: requireUtc(row.createdAt, "report_versions.created_at"),
      started_at: nullableUtc(row.startedAt, "report_versions.started_at"),
      completed_at: nullableUtc(row.completedAt, "report_versions.completed_at"),
    },
    "ReportVersion",
  );
}

export function evidenceToRow(input: unknown): EvidenceInsertRow {
  const value = parseForWrite(EvidenceSchema, input, "Evidence");
  return {
    evidenceId: value.evidence_id,
    reportVersionId: value.report_version_id,
    privacyRevisionId: value.privacy_revision_id,
    recordRevisionId: value.record_revision_id,
    recordId: value.record_id,
    sourceName: value.source_ref.source_name,
    sourceSequence: value.source_ref.sequence,
    charStart: value.source_ref.char_start,
    charEnd: value.source_ref.char_end,
    excerpt: value.excerpt,
    actor: value.actor,
    timestamp: value.timestamp,
    evidenceType: value.evidence_type,
    epistemicStatus: value.epistemic_status,
    factScope: value.fact_scope,
  };
}

export function evidenceRowToDomain(row: EvidenceRow): Evidence {
  // excerpt === canonical_records.sanitized_content.slice(...) is deliberately deferred to Repository.
  return parseForRead(
    EvidenceSchema,
    {
      evidence_id: row.evidenceId,
      report_version_id: row.reportVersionId,
      privacy_revision_id: row.privacyRevisionId,
      record_revision_id: row.recordRevisionId,
      record_id: row.recordId,
      source_ref: {
        source_name: row.sourceName,
        sequence: row.sourceSequence,
        char_start: row.charStart,
        char_end: row.charEnd,
      },
      excerpt: row.excerpt,
      actor: row.actor,
      timestamp: row.timestamp,
      evidence_type: row.evidenceType,
      epistemic_status: row.epistemicStatus,
      fact_scope: row.factScope,
    },
    "Evidence",
  );
}

export function commitmentToRow(input: unknown): CommitmentInsertRow {
  const value = parseForWrite(CommitmentSchema, input, "Commitment");
  return {
    commitmentId: value.commitment_id,
    reportVersionId: value.report_version_id,
    classification: value.classification,
    epistemicStatus: value.epistemic_status,
    actor: value.actor,
    actionOrDeliverable: value.action_or_deliverable,
    evidenceIdsJson: jsonFieldCodecs.commitmentEvidenceIds.encode(value.evidence_ids),
    deadline: value.deadline,
    condition: value.condition,
    recipient: value.recipient,
    lifecycleStatus: value.lifecycle_status,
    supersedesCommitmentId: value.supersedes_commitment_id,
    statusEvidenceIdsJson: jsonFieldCodecs.commitmentStatusEvidenceIds.encode(
      value.status_evidence_ids,
    ),
  };
}

export function commitmentRowToDomain(row: CommitmentRow): Commitment {
  return parseForRead(
    CommitmentSchema,
    {
      commitment_id: row.commitmentId,
      report_version_id: row.reportVersionId,
      classification: row.classification,
      epistemic_status: row.epistemicStatus,
      actor: row.actor,
      action_or_deliverable: row.actionOrDeliverable,
      evidence_ids: jsonFieldCodecs.commitmentEvidenceIds.decode(row.evidenceIdsJson),
      deadline: row.deadline,
      condition: row.condition,
      recipient: row.recipient,
      lifecycle_status: row.lifecycleStatus,
      supersedes_commitment_id: row.supersedesCommitmentId,
      status_evidence_ids: jsonFieldCodecs.commitmentStatusEvidenceIds.decode(
        row.statusEvidenceIdsJson,
      ),
    },
    "Commitment",
  );
}

export function changeToRow(input: unknown): ChangeInsertRow {
  const value = parseForWrite(ChangeSchema, input, "RequirementDecisionChange");
  return {
    changeId: value.change_id,
    reportVersionId: value.report_version_id,
    classification: value.classification,
    epistemicStatus: value.epistemic_status,
    changeType: value.change_type,
    subject: value.subject,
    beforeSummary: value.before_summary,
    afterSummary: value.after_summary,
    evidenceIdsJson: jsonFieldCodecs.changeEvidenceIds.encode(value.evidence_ids),
    timestamp: value.timestamp,
  };
}

export function changeRowToDomain(row: ChangeRow): RequirementDecisionChange {
  return parseForRead(
    ChangeSchema,
    {
      change_id: row.changeId,
      report_version_id: row.reportVersionId,
      classification: row.classification,
      epistemic_status: row.epistemicStatus,
      change_type: row.changeType,
      subject: row.subject,
      before_summary: row.beforeSummary,
      after_summary: row.afterSummary,
      evidence_ids: jsonFieldCodecs.changeEvidenceIds.decode(row.evidenceIdsJson),
      timestamp: row.timestamp,
    },
    "RequirementDecisionChange",
  );
}

export function conflictToRow(input: unknown): ConflictInsertRow {
  const value = parseForWrite(PotentialConflictSchema, input, "PotentialConflict");
  return {
    conflictId: value.conflict_id,
    reportVersionId: value.report_version_id,
    conflictType: value.conflict_type,
    claimAText: value.claim_a.text,
    claimAEvidenceIdsJson: jsonFieldCodecs.conflictClaimAEvidenceIds.encode(
      value.claim_a.evidence_ids,
    ),
    claimBText: value.claim_b.text,
    claimBEvidenceIdsJson: jsonFieldCodecs.conflictClaimBEvidenceIds.encode(
      value.claim_b.evidence_ids,
    ),
    comparableSubject: value.comparable_context.subject,
    comparableTimeContext: value.comparable_context.time_context,
    comparableVersionContext: value.comparable_context.version_context,
    comparableConditionContext: value.comparable_context.condition_context,
    conflictReason: value.conflict_reason,
    counterEvidenceIdsJson: jsonFieldCodecs.conflictCounterEvidenceIds.encode(
      value.counter_evidence_ids,
    ),
    alternativeExplanationsJson: jsonFieldCodecs.conflictAlternativeExplanations.encode(
      value.alternative_explanations,
    ),
    missingEvidenceJson: jsonFieldCodecs.conflictMissingEvidence.encode(value.missing_evidence),
    epistemicStatus: value.epistemic_status,
    conflicted: value.conflicted,
  };
}

export function conflictRowToDomain(row: ConflictRow): PotentialConflict {
  return parseForRead(
    PotentialConflictSchema,
    {
      conflict_id: row.conflictId,
      report_version_id: row.reportVersionId,
      conflict_type: row.conflictType,
      claim_a: {
        text: row.claimAText,
        evidence_ids: jsonFieldCodecs.conflictClaimAEvidenceIds.decode(
          row.claimAEvidenceIdsJson,
        ),
      },
      claim_b: {
        text: row.claimBText,
        evidence_ids: jsonFieldCodecs.conflictClaimBEvidenceIds.decode(
          row.claimBEvidenceIdsJson,
        ),
      },
      comparable_context: {
        subject: row.comparableSubject,
        time_context: row.comparableTimeContext,
        version_context: row.comparableVersionContext,
        condition_context: row.comparableConditionContext,
      },
      conflict_reason: row.conflictReason,
      counter_evidence_ids: jsonFieldCodecs.conflictCounterEvidenceIds.decode(
        row.counterEvidenceIdsJson,
      ),
      alternative_explanations: jsonFieldCodecs.conflictAlternativeExplanations.decode(
        row.alternativeExplanationsJson,
      ),
      missing_evidence: jsonFieldCodecs.conflictMissingEvidence.decode(row.missingEvidenceJson),
      epistemic_status: row.epistemicStatus,
      conflicted: row.conflicted,
    },
    "PotentialConflict",
  );
}

export function providerCallToRow(input: unknown): ProviderCallInsertRow {
  const value = parseForWrite(ProviderCallPersistenceSchema, input, "ProviderCallPersistence");
  return {
    providerCallId: value.provider_call_id,
    auditId: value.audit_id,
    reportVersionId: value.report_version_id,
    stage: value.stage,
    providerName: value.provider_name,
    modelName: value.model_name,
    startedAt: normalizeUtc(value.started_at),
    completedAt: value.completed_at === null ? null : normalizeUtc(value.completed_at),
    latencyMs: value.latency_ms,
    status: value.status,
    inputRecordCount: value.input_record_count,
    inputSizeChars: value.input_size_chars,
    inputTokens: value.input_tokens,
    outputTokens: value.output_tokens,
    totalTokens: value.total_tokens,
    costAmountMicros: value.cost_amount_micros,
    costCurrency: value.cost_currency,
    retryCount: value.retry_count,
    schemaValid: value.schema_valid,
    errorCategory: value.error_category,
    outputCountsJson:
      value.output_counts === null
        ? null
        : jsonFieldCodecs.providerOutputCounts.encode(value.output_counts),
  };
}

export function providerCallRowToDomain(row: ProviderCallRow): ProviderCallPersistence {
  return parseForRead(
    ProviderCallPersistenceSchema,
    {
      provider_call_id: row.providerCallId,
      audit_id: row.auditId,
      report_version_id: row.reportVersionId,
      stage: row.stage,
      provider_name: row.providerName,
      model_name: row.modelName,
      started_at: requireUtc(row.startedAt, "provider_calls.started_at"),
      completed_at: nullableUtc(row.completedAt, "provider_calls.completed_at"),
      latency_ms: row.latencyMs,
      status: row.status,
      input_record_count: row.inputRecordCount,
      input_size_chars: row.inputSizeChars,
      input_tokens: row.inputTokens,
      output_tokens: row.outputTokens,
      total_tokens: row.totalTokens,
      cost_amount_micros: row.costAmountMicros,
      cost_currency: row.costCurrency,
      retry_count: row.retryCount,
      schema_valid: row.schemaValid,
      error_category: row.errorCategory,
      output_counts:
        row.outputCountsJson === null
          ? null
          : jsonFieldCodecs.providerOutputCounts.decode(row.outputCountsJson),
    },
    "ProviderCallPersistence",
  );
}
