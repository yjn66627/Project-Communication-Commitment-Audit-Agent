import { z } from "zod";

export const EpistemicStatusSchema = z.enum(["FACT", "INFERENCE", "UNKNOWN"]);
export const SourceTypeSchema = z.enum(["PASTE", "TXT", "MARKDOWN", "JSON"]);
export const PrivacyEntityTypeSchema = z.enum([
  "PERSON",
  "ORG",
  "PROJECT",
  "PHONE",
  "EMAIL",
  "ID_CARD",
  "IP",
  "URL",
  "SECRET",
]);
export const MappablePrivacyEntityTypeSchema = z.enum([
  "PERSON",
  "ORG",
  "PROJECT",
  "PHONE",
  "EMAIL",
  "ID_CARD",
  "IP",
  "URL",
]);
export const EvidenceTypeSchema = z.enum([
  "STATEMENT",
  "STATUS",
  "DECISION",
  "DELIVERY",
  "OTHER",
]);
export const ChangeTypeSchema = z.enum(["NEW", "MODIFY", "REPLACE", "WITHDRAW", "CLARIFY"]);
export const CommitmentLifecycleStatusSchema = z.enum([
  "OPEN",
  "FULFILLED",
  "MODIFIED",
  "WITHDRAWN",
  "SUPERSEDED",
  "UNKNOWN",
]);

export const AuditIdSchema = z.string().startsWith("aud_");
export const ReportVersionIdSchema = z.string().startsWith("rpt_");
export const RecordIdSchema = z.string().startsWith("rec_");
export const RecordRevisionIdSchema = z.string().startsWith("rr_");
export const PrivacyRevisionIdSchema = z.string().startsWith("prv_");
export const EvidenceIdSchema = z.string().startsWith("ev_");
export const CommitmentIdSchema = z.string().startsWith("com_");
export const ChangeIdSchema = z.string().startsWith("chg_");
export const ConflictIdSchema = z.string().startsWith("cfl_");
export const ProviderCallIdSchema = z.string().startsWith("pcall_");

export const MetadataValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export type EpistemicStatus = z.infer<typeof EpistemicStatusSchema>;
export type EvidenceType = z.infer<typeof EvidenceTypeSchema>;
