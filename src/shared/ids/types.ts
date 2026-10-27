export type AuditId = `aud_${string}`;
export type ReportVersionId = `rpt_${string}`;
export type RecordId = `rec_${string}`;
export type RecordRevisionId = `rr_${string}`;
export type PrivacyRevisionId = `prv_${string}`;
export type EvidenceId = `ev_${string}`;
export type CommitmentId = `com_${string}`;
export type ChangeId = `chg_${string}`;
export type ConflictId = `cfl_${string}`;
export type ProviderCallId = `pcall_${string}`;

export type RevisionSourceType = "PASTE" | "TXT" | "MARKDOWN" | "JSON";

export type RevisionRecordSnapshot = Readonly<{
  record_id: RecordId;
  source_type: RevisionSourceType;
  source_name: string;
  author: string | null;
  timestamp: string | null;
  sanitized_content: string;
  sequence: number;
}>;

export type RevisionMappingSnapshot = Readonly<{
  entity_type:
    | "PERSON"
    | "ORG"
    | "PROJECT"
    | "PHONE"
    | "EMAIL"
    | "ID_CARD"
    | "IP"
    | "URL";
  placeholder: string;
  normalized_original_value: string;
  aliases: readonly string[];
  active: boolean;
}>;

export type EvidenceIdentityInput = Readonly<{
  report_version_id: ReportVersionId;
  record_revision_id: RecordRevisionId;
  char_start: number;
  char_end: number;
  evidence_type: "STATEMENT" | "STATUS" | "DECISION" | "DELIVERY" | "OTHER";
}>;
