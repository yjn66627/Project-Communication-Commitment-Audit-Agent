import { sql } from "drizzle-orm";
import { check, foreignKey, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * DEV03_CP-1B2 candidate.
 * Scope: frozen CP-1B1 fields/primary keys/FKs/Unique constraints plus CHECK constraints
 * and explicit RESTRICT delete policies. Intentionally contains NO normal indexes,
 * migration SQL, repositories, or runtime DB connection code.
 */

export const audits = sqliteTable(
  "audits",
  {
    auditId: text("audit_id").notNull().primaryKey(),
    revisionSalt: text("revision_salt").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("audits_revision_salt_uq").on(table.revisionSalt),
  ],
);

// DEV06-C1: additive application metadata; Audit identity remains unchanged.
export const auditMetadata = sqliteTable(
  "audit_metadata",
  {
    auditId: text("audit_id").notNull().primaryKey(),
    displayName: text("display_name").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.auditId],
      foreignColumns: [audits.auditId],
      name: "audit_metadata_audit_fk",
    }).onDelete("restrict"),
    check("audit_metadata_display_name_nonempty_ck", sql`length(trim(${table.displayName})) > 0`),
  ],
);

export const privacyRevisions = sqliteTable(
  "privacy_revisions",
  {
    privacyRevisionId: text("privacy_revision_id").notNull().primaryKey(),
    auditId: text("audit_id").notNull(),
    algorithm: text("algorithm").notNull(),
    confirmedAt: text("confirmed_at").notNull(),
    recordCount: integer("record_count").notNull(),
    mappingCount: integer("mapping_count").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.auditId],
      foreignColumns: [audits.auditId],
      name: "privacy_revisions_audit_fk",
    }).onDelete("restrict"),
    uniqueIndex("privacy_revisions_audit_revision_uq").on(
      table.auditId,
      table.privacyRevisionId,
    ),
    check("privacy_revisions_record_count_positive_ck", sql`${table.recordCount} > 0`),
    check("privacy_revisions_mapping_count_nonnegative_ck", sql`${table.mappingCount} >= 0`),
  ],
);

export const canonicalRecords = sqliteTable(
  "canonical_records",
  {
    recordRevisionId: text("record_revision_id").notNull().primaryKey(),
    auditId: text("audit_id").notNull(),
    recordId: text("record_id").notNull(),
    privacyRevisionId: text("privacy_revision_id").notNull(),
    sourceType: text("source_type").notNull(),
    sourceName: text("source_name").notNull(),
    author: text("author"),
    timestamp: text("timestamp"),
    sanitizedContent: text("sanitized_content").notNull(),
    sequence: integer("sequence").notNull(),
    metadataJson: text("metadata_json"),
  },
  (table) => [
    foreignKey({
      columns: [table.auditId, table.privacyRevisionId],
      foreignColumns: [privacyRevisions.auditId, privacyRevisions.privacyRevisionId],
      name: "canonical_records_audit_privacy_revision_fk",
    }).onDelete("restrict"),
    uniqueIndex("canonical_records_audit_record_privacy_revision_uq").on(
      table.auditId,
      table.recordId,
      table.privacyRevisionId,
    ),
    uniqueIndex("canonical_records_evidence_source_identity_uq").on(
      table.recordRevisionId,
      table.privacyRevisionId,
      table.recordId,
      table.sourceName,
      table.sequence,
    ),
    check("canonical_records_sequence_nonnegative_ck", sql`${table.sequence} >= 0`),
  ],
);

export const privacyMappings = sqliteTable(
  "privacy_mappings",
  {
    mappingId: text("mapping_id").notNull(),
    auditId: text("audit_id").notNull(),
    privacyRevisionId: text("privacy_revision_id").notNull(),
    entityType: text("entity_type").notNull(),
    placeholder: text("placeholder").notNull(),
    originalValue: text("original_value").notNull(),
    normalizedKey: text("normalized_key").notNull(),
    aliasesJson: text("aliases_json").notNull(),
    active: integer("active", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.auditId,
        table.privacyRevisionId,
        table.entityType,
        table.placeholder,
      ],
      name: "privacy_mappings_pk",
    }),
    foreignKey({
      columns: [table.auditId, table.privacyRevisionId],
      foreignColumns: [privacyRevisions.auditId, privacyRevisions.privacyRevisionId],
      name: "privacy_mappings_audit_privacy_revision_fk",
    }).onDelete("restrict"),
    check("privacy_mappings_entity_type_not_secret_ck", sql`${table.entityType} <> 'SECRET'`),
    check("privacy_mappings_active_boolean_ck", sql`${table.active} IN (0, 1)`),
  ],
);

export const reportVersions = sqliteTable(
  "report_versions",
  {
    reportVersionId: text("report_version_id").notNull().primaryKey(),
    auditId: text("audit_id").notNull(),
    privacyRevisionId: text("privacy_revision_id").notNull(),
    parentReportVersionId: text("parent_report_version_id"),
    versionNumber: integer("version_number").notNull(),
    status: text("status").notNull(),
    changesSummary: text("changes_summary"),
    createdAt: text("created_at").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.auditId, table.privacyRevisionId],
      foreignColumns: [privacyRevisions.auditId, privacyRevisions.privacyRevisionId],
      name: "report_versions_audit_privacy_revision_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.parentReportVersionId, table.auditId],
      foreignColumns: [table.reportVersionId, table.auditId],
      name: "report_versions_parent_same_audit_fk",
    }).onDelete("restrict"),
    uniqueIndex("report_versions_audit_number_uq").on(
      table.auditId,
      table.versionNumber,
    ),
    uniqueIndex("report_versions_report_privacy_revision_uq").on(
      table.reportVersionId,
      table.privacyRevisionId,
    ),
    uniqueIndex("report_versions_report_audit_uq").on(
      table.reportVersionId,
      table.auditId,
    ),
    check("report_versions_version_number_positive_ck", sql`${table.versionNumber} > 0`),
    check(
      "report_versions_status_enum_ck",
      sql`${table.status} IN ('DRAFT', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED')`,
    ),
  ],
);

export const evidence = sqliteTable(
  "evidence",
  {
    evidenceId: text("evidence_id").notNull().primaryKey(),
    reportVersionId: text("report_version_id").notNull(),
    privacyRevisionId: text("privacy_revision_id").notNull(),
    recordRevisionId: text("record_revision_id").notNull(),
    recordId: text("record_id").notNull(),
    sourceName: text("source_name").notNull(),
    sourceSequence: integer("source_sequence").notNull(),
    charStart: integer("char_start").notNull(),
    charEnd: integer("char_end").notNull(),
    excerpt: text("excerpt").notNull(),
    actor: text("actor"),
    timestamp: text("timestamp"),
    evidenceType: text("evidence_type").notNull(),
    epistemicStatus: text("epistemic_status").notNull(),
    factScope: text("fact_scope").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reportVersionId, table.privacyRevisionId],
      foreignColumns: [reportVersions.reportVersionId, reportVersions.privacyRevisionId],
      name: "evidence_report_privacy_revision_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [
        table.recordRevisionId,
        table.privacyRevisionId,
        table.recordId,
        table.sourceName,
        table.sourceSequence,
      ],
      foreignColumns: [
        canonicalRecords.recordRevisionId,
        canonicalRecords.privacyRevisionId,
        canonicalRecords.recordId,
        canonicalRecords.sourceName,
        canonicalRecords.sequence,
      ],
      name: "evidence_canonical_source_identity_fk",
    }).onDelete("restrict"),
    check("evidence_source_sequence_nonnegative_ck", sql`${table.sourceSequence} >= 0`),
    check("evidence_char_start_nonnegative_ck", sql`${table.charStart} >= 0`),
    check("evidence_char_range_ck", sql`${table.charEnd} > ${table.charStart}`),
    check(
      "evidence_type_enum_ck",
      sql`${table.evidenceType} IN ('STATEMENT', 'STATUS', 'DECISION', 'DELIVERY', 'OTHER')`,
    ),
    check("evidence_epistemic_fact_ck", sql`${table.epistemicStatus} = 'FACT'`),
    check("evidence_fact_scope_ck", sql`${table.factScope} = 'SOURCE_FACT'`),
  ],
);

export const commitments = sqliteTable(
  "commitments",
  {
    commitmentId: text("commitment_id").notNull().primaryKey(),
    reportVersionId: text("report_version_id").notNull(),
    classification: text("classification").notNull(),
    epistemicStatus: text("epistemic_status").notNull(),
    actor: text("actor"),
    actionOrDeliverable: text("action_or_deliverable").notNull(),
    evidenceIdsJson: text("evidence_ids_json").notNull(),
    deadline: text("deadline"),
    condition: text("condition"),
    recipient: text("recipient"),
    lifecycleStatus: text("lifecycle_status").notNull(),
    supersedesCommitmentId: text("supersedes_commitment_id"),
    statusEvidenceIdsJson: text("status_evidence_ids_json").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reportVersionId],
      foreignColumns: [reportVersions.reportVersionId],
      name: "commitments_report_version_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.supersedesCommitmentId],
      foreignColumns: [table.commitmentId],
      name: "commitments_supersedes_fk",
    }).onDelete("restrict"),
    check(
      "commitments_classification_enum_ck",
      sql`${table.classification} IN ('CANDIDATE', 'CONFIRMED')`,
    ),
    check(
      "commitments_classification_epistemic_ck",
      sql`(${table.classification} = 'CONFIRMED' AND ${table.epistemicStatus} = 'FACT') OR (${table.classification} = 'CANDIDATE' AND ${table.epistemicStatus} IN ('INFERENCE', 'UNKNOWN'))`,
    ),
    check(
      "commitments_lifecycle_status_enum_ck",
      sql`${table.lifecycleStatus} IN ('OPEN', 'FULFILLED', 'MODIFIED', 'WITHDRAWN', 'SUPERSEDED', 'UNKNOWN')`,
    ),
  ],
);

export const changes = sqliteTable(
  "changes",
  {
    changeId: text("change_id").notNull().primaryKey(),
    reportVersionId: text("report_version_id").notNull(),
    classification: text("classification").notNull(),
    epistemicStatus: text("epistemic_status").notNull(),
    changeType: text("change_type").notNull(),
    subject: text("subject").notNull(),
    beforeSummary: text("before_summary"),
    afterSummary: text("after_summary").notNull(),
    evidenceIdsJson: text("evidence_ids_json").notNull(),
    timestamp: text("timestamp"),
  },
  (table) => [
    foreignKey({
      columns: [table.reportVersionId],
      foreignColumns: [reportVersions.reportVersionId],
      name: "changes_report_version_fk",
    }).onDelete("restrict"),
    check(
      "changes_classification_enum_ck",
      sql`${table.classification} IN ('CANDIDATE', 'CONFIRMED')`,
    ),
    check(
      "changes_classification_epistemic_ck",
      sql`(${table.classification} = 'CONFIRMED' AND ${table.epistemicStatus} = 'FACT') OR (${table.classification} = 'CANDIDATE' AND ${table.epistemicStatus} IN ('INFERENCE', 'UNKNOWN'))`,
    ),
    check(
      "changes_change_type_enum_ck",
      sql`${table.changeType} IN ('NEW', 'MODIFY', 'REPLACE', 'WITHDRAW', 'CLARIFY')`,
    ),
  ],
);

export const conflicts = sqliteTable(
  "conflicts",
  {
    conflictId: text("conflict_id").notNull().primaryKey(),
    reportVersionId: text("report_version_id").notNull(),
    conflictType: text("conflict_type").notNull(),
    claimAText: text("claim_a_text").notNull(),
    claimAEvidenceIdsJson: text("claim_a_evidence_ids_json").notNull(),
    claimBText: text("claim_b_text").notNull(),
    claimBEvidenceIdsJson: text("claim_b_evidence_ids_json").notNull(),
    comparableSubject: text("comparable_subject").notNull(),
    comparableTimeContext: text("comparable_time_context"),
    comparableVersionContext: text("comparable_version_context"),
    comparableConditionContext: text("comparable_condition_context"),
    conflictReason: text("conflict_reason").notNull(),
    counterEvidenceIdsJson: text("counter_evidence_ids_json").notNull(),
    alternativeExplanationsJson: text("alternative_explanations_json").notNull(),
    missingEvidenceJson: text("missing_evidence_json").notNull(),
    epistemicStatus: text("epistemic_status").notNull(),
    conflicted: integer("conflicted", { mode: "boolean" }).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reportVersionId],
      foreignColumns: [reportVersions.reportVersionId],
      name: "conflicts_report_version_fk",
    }).onDelete("restrict"),
    check("conflicts_type_ck", sql`${table.conflictType} = 'POTENTIAL_CONFLICT'`),
    check(
      "conflicts_epistemic_status_ck",
      sql`${table.epistemicStatus} IN ('INFERENCE', 'UNKNOWN')`,
    ),
    check("conflicts_conflicted_true_ck", sql`${table.conflicted} = 1`),
  ],
);

export const providerCalls = sqliteTable(
  "provider_calls",
  {
    providerCallId: text("provider_call_id").notNull().primaryKey(),
    auditId: text("audit_id").notNull(),
    reportVersionId: text("report_version_id"),
    stage: text("stage").notNull(),
    providerName: text("provider_name").notNull(),
    modelName: text("model_name").notNull(),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    inputRecordCount: integer("input_record_count"),
    inputSizeChars: integer("input_size_chars"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    totalTokens: integer("total_tokens"),
    costAmountMicros: integer("cost_amount_micros"),
    costCurrency: text("cost_currency"),
    retryCount: integer("retry_count").notNull(),
    schemaValid: integer("schema_valid", { mode: "boolean" }),
    errorCategory: text("error_category"),
    outputCountsJson: text("output_counts_json"),
  },
  (table) => [
    foreignKey({
      columns: [table.auditId],
      foreignColumns: [audits.auditId],
      name: "provider_calls_audit_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reportVersionId, table.auditId],
      foreignColumns: [reportVersions.reportVersionId, reportVersions.auditId],
      name: "provider_calls_report_same_audit_fk",
    }).onDelete("restrict"),
    check("provider_calls_latency_nonnegative_ck", sql`${table.latencyMs} >= 0`),
    check(
      "provider_calls_input_record_count_nonnegative_ck",
      sql`${table.inputRecordCount} >= 0`,
    ),
    check("provider_calls_input_size_nonnegative_ck", sql`${table.inputSizeChars} >= 0`),
    check("provider_calls_input_tokens_nonnegative_ck", sql`${table.inputTokens} >= 0`),
    check("provider_calls_output_tokens_nonnegative_ck", sql`${table.outputTokens} >= 0`),
    check("provider_calls_total_tokens_nonnegative_ck", sql`${table.totalTokens} >= 0`),
    check("provider_calls_cost_nonnegative_ck", sql`${table.costAmountMicros} >= 0`),
    check("provider_calls_retry_count_nonnegative_ck", sql`${table.retryCount} >= 0`),
    check("provider_calls_schema_valid_boolean_ck", sql`${table.schemaValid} IN (0, 1)`),
  ],
);

// DEV06-C2: explicit immutable acceptance; COMPLETED lifecycle remains unchanged.
export const reportAcceptances = sqliteTable(
  "report_acceptances",
  {
    reportVersionId: text("report_version_id").notNull().primaryKey(),
    auditId: text("audit_id").notNull(),
    privacyRevisionId: text("privacy_revision_id").notNull(),
    canonicalFormatVersion: integer("canonical_format_version").notNull(),
    canonicalDigest: text("canonical_digest").notNull(),
    canonicalJson: text("canonical_json").notNull(),
    acceptedAt: text("accepted_at").notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.reportVersionId, table.auditId],
      foreignColumns: [reportVersions.reportVersionId, reportVersions.auditId],
      name: "report_acceptances_report_audit_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reportVersionId, table.privacyRevisionId],
      foreignColumns: [reportVersions.reportVersionId, reportVersions.privacyRevisionId],
      name: "report_acceptances_report_privacy_revision_fk",
    }).onDelete("restrict"),
    check("report_acceptances_format_v1_ck", sql`${table.canonicalFormatVersion} = 1`),
    check("report_acceptances_digest_length_ck", sql`length(${table.canonicalDigest}) = 64`),
    check("report_acceptances_json_nonempty_ck", sql`length(${table.canonicalJson}) > 0`),
  ],
);
