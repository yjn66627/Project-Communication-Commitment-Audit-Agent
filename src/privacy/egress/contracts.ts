import { z } from "zod";

import type { SafeConfirmedPrivacyAggregate } from "../../db/repositories/privacy-repository.js";
import type { Commitment } from "../../domain/schemas/commitment.js";
import type { RequirementDecisionChange } from "../../domain/schemas/change.js";
import type { PotentialConflict } from "../../domain/schemas/conflict.js";
import type { Evidence } from "../../domain/schemas/evidence.js";
import {
  AuditReportSchema,
  AuditSummarySchema,
  MissingEvidenceSchema,
  TimelineEventSchema,
  type AuditReport,
  type ReportVersion,
} from "../../domain/schemas/report.js";
import {
  AuditIdSchema,
  ChangeIdSchema,
  ChangeTypeSchema,
  CommitmentIdSchema,
  CommitmentLifecycleStatusSchema,
  ConflictIdSchema,
  EpistemicStatusSchema,
  EvidenceIdSchema,
  EvidenceTypeSchema,
  PrivacyRevisionIdSchema,
  RecordIdSchema,
  RecordRevisionIdSchema,
  ReportVersionIdSchema,
} from "../../domain/schemas/base.js";
import type { EgressDenyCode, EgressSafeCategory } from "./errors.js";

export const EgressCommandSchema = z.object({
  audit_id: AuditIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  report_version_id: ReportVersionIdSchema.optional(),
}).strict();

export const EgressSafeRecordSchema = z.object({
  record_revision_id: RecordRevisionIdSchema,
  record_id: RecordIdSchema,
  source_name: z.string().min(1).max(512),
  author: z.string().min(1).max(256).nullable(),
  timestamp: z.string().max(128).nullable(),
  sanitized_content: z.string().min(1),
  sequence: z.number().int().nonnegative(),
}).strict();

export const EgressSafePayloadSchema = z.object({
  audit_id: AuditIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  records: z.array(EgressSafeRecordSchema),
  report_version_id: ReportVersionIdSchema.optional(),
}).strict();

export type EgressCommand = Readonly<z.infer<typeof EgressCommandSchema>>;
type EgressSafeRecordShape = z.infer<typeof EgressSafeRecordSchema>;
export type EgressSafeRecord = Readonly<EgressSafeRecordShape>;
type EgressSafePayloadShape = Omit<z.infer<typeof EgressSafePayloadSchema>, "records"> & {
  records: readonly EgressSafeRecord[];
};
export type EgressSafePayload = Readonly<EgressSafePayloadShape>;

export type EgressGateResult =
  | Readonly<{ decision: "ALLOW"; payload: EgressSafePayload }>
  | Readonly<{ decision: "DENY"; code: EgressDenyCode; safe_category: EgressSafeCategory }>;

/** Narrow egress read port: reversible/local mapping-vault APIs are intentionally absent. */
export interface EgressPrivacyReadPort {
  getConfirmedPrivacyAggregateSafe(privacyRevisionId: string): SafeConfirmedPrivacyAggregate;
}

export interface EgressReportReadPort {
  getReportVersionById(reportVersionId: string): ReportVersion;
}

export type EgressGateDependencies = Readonly<{
  privacy: EgressPrivacyReadPort;
  report?: EgressReportReadPort;
}>;

/** Additive family authority: the original Evidence Extraction command remains unchanged. */
export const MAX_FAMILY_REFERENCES = 64;

const FamilyIdentityShape = {
  audit_id: AuditIdSchema,
  privacy_revision_id: PrivacyRevisionIdSchema,
  report_version_id: ReportVersionIdSchema,
} as const;

const FamilyEvidenceIdsSchema = z.array(EvidenceIdSchema).min(1).max(MAX_FAMILY_REFERENCES);

export const FamilyEgressCommandSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("COMMITMENT_CHANGE"),
    ...FamilyIdentityShape,
    evidence_ids: FamilyEvidenceIdsSchema,
  }).strict(),
  z.object({
    operation: z.literal("CONFLICT_REVIEW"),
    ...FamilyIdentityShape,
    evidence_ids: FamilyEvidenceIdsSchema,
  }).strict(),
  z.object({
    operation: z.literal("REPORT_FINALIZE"),
    ...FamilyIdentityShape,
  }).strict(),
]);

export const FamilySafeEvidenceSchema = z.object({
  evidence_id: EvidenceIdSchema,
  record_revision_id: RecordRevisionIdSchema,
  evidence_type: EvidenceTypeSchema,
  excerpt: z.string().min(1).max(4096),
}).strict();

const FamilySafeCommitmentSchema = z.object({
  commitment_id: CommitmentIdSchema,
  classification: z.enum(["CANDIDATE", "CONFIRMED"]),
  epistemic_status: EpistemicStatusSchema,
  action_or_deliverable: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema),
  lifecycle_status: CommitmentLifecycleStatusSchema,
}).strict();

const FamilySafeChangeSchema = z.object({
  change_id: ChangeIdSchema,
  classification: z.enum(["CANDIDATE", "CONFIRMED"]),
  epistemic_status: EpistemicStatusSchema,
  change_type: ChangeTypeSchema,
  subject: z.string().min(1),
  after_summary: z.string().min(1),
  evidence_ids: z.array(EvidenceIdSchema),
}).strict();

const FamilySafeConflictSchema = z.object({
  conflict_id: ConflictIdSchema,
  epistemic_status: z.enum(["INFERENCE", "UNKNOWN"]),
  claim_a: z.object({ text: z.string().min(1), evidence_ids: z.array(EvidenceIdSchema).min(1) }).strict(),
  claim_b: z.object({ text: z.string().min(1), evidence_ids: z.array(EvidenceIdSchema).min(1) }).strict(),
  counter_evidence_ids: z.array(EvidenceIdSchema),
  conflict_reason: z.string().min(1),
  conflicted: z.literal(true),
}).strict();

const FamilySafePayloadBase = {
  ...FamilyIdentityShape,
  evidence: z.array(FamilySafeEvidenceSchema).max(MAX_FAMILY_REFERENCES),
} as const;

export const FamilyEgressSafePayloadSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("COMMITMENT_CHANGE"), ...FamilySafePayloadBase }).strict(),
  z.object({ operation: z.literal("CONFLICT_REVIEW"), ...FamilySafePayloadBase }).strict(),
  z.object({
    operation: z.literal("REPORT_FINALIZE"),
    ...FamilySafePayloadBase,
    local_summary: AuditSummarySchema,
    timeline: z.array(TimelineEventSchema).max(128),
    commitments: z.array(FamilySafeCommitmentSchema).max(MAX_FAMILY_REFERENCES),
    changes: z.array(FamilySafeChangeSchema).max(MAX_FAMILY_REFERENCES),
    conflicts: z.array(FamilySafeConflictSchema).max(MAX_FAMILY_REFERENCES),
    missing_evidence: z.array(MissingEvidenceSchema).max(MAX_FAMILY_REFERENCES),
  }).strict(),
]);

export type FamilyEgressCommand = z.infer<typeof FamilyEgressCommandSchema>;
export type FamilyEgressSafePayload = Readonly<z.infer<typeof FamilyEgressSafePayloadSchema>>;

/** Read-only local authority ports; Provider runtime never receives a Repository or SQLite handle. */
export interface EgressFamilyEvidenceReadPort {
  getEvidenceById(evidenceId: string): Evidence;
}

export interface EgressFamilyReportReadPort {
  getLocalReportByVersionId(reportVersionId: string): AuditReport;
  getCommitmentById(commitmentId: string): Commitment;
  getChangeById(changeId: string): RequirementDecisionChange;
  getConflictById(conflictId: string): PotentialConflict;
}

export type FamilyEgressGateDependencies = Readonly<{
  privacy: EgressPrivacyReadPort;
  report: EgressReportReadPort;
  evidence: EgressFamilyEvidenceReadPort;
  finalize?: EgressFamilyReportReadPort;
}>;

export type FamilyEgressGateResult =
  | Readonly<{
      decision: "ALLOW";
      payload: FamilyEgressSafePayload;
      /** Local-only, Gate-validated source snapshot. Never serialize this sidecar to Provider. */
      local_report?: z.infer<typeof AuditReportSchema>;
    }>
  | Extract<EgressGateResult, { decision: "DENY" }>;
