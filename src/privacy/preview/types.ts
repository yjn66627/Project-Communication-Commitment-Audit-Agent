export interface SanitizedPreviewRecordCandidate {
  readonly record_id: string;
  readonly source_type: string;
  readonly sanitized_source_name: string;
  readonly sanitized_author: string | null;
  readonly timestamp: string | null;
  readonly sanitized_content: string;
  readonly sequence: number;
}
