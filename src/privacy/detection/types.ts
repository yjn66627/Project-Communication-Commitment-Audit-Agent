import type { PrivacyEntity } from "../../domain/schemas/privacy.js";

export const PRIVACY_DETECTOR_RULESET_VERSION = "privacy-detector-rules-v1" as const;

export type PrivacyEntityType = PrivacyEntity["entity_type"];
export type PrivacyDetectionSource = PrivacyEntity["detection_source"];
export type PrivacyDetectionConfidence = PrivacyEntity["detection_confidence"];

export type PrivacyDetectionSurface = "CONTENT" | "AUTHOR" | "SOURCE_NAME";
export type PrivacyReplacementPolicy =
  | "PSEUDONYMIZE"
  | "REDACT"
  | "LOCKED_REDACTION"
  | "REVIEW_REQUIRED";
export type PrivacyDetectionReviewState =
  | "UNREVIEWED"
  | "REVIEW_REQUIRED"
  | "LOCKED_REDACTION";

export type SecretFamily =
  | "AUTH_BEARER"
  | "AUTH_BASIC"
  | "API_KEY_SK_STYLE"
  | "GITHUB_TOKEN_STYLE"
  | "AWS_ACCESS_KEY_STYLE"
  | "PRIVATE_KEY_PEM"
  | "JWT_STRUCTURED"
  | "NAMED_SECRET_ASSIGNMENT"
  | "URL_USERINFO_CREDENTIAL";

export interface PrivacyDetectionCandidate {
  readonly detection_id: string;
  readonly record_id: string;
  readonly surface: PrivacyDetectionSurface;
  readonly char_start: number;
  readonly char_end: number;
  readonly entity_type: PrivacyEntityType;
  readonly priority: number;
  readonly normalized_key: string | null;
  readonly detector_id: string;
  readonly detection_source: PrivacyDetectionSource;
  readonly confidence: PrivacyDetectionConfidence;
  readonly review_state: PrivacyDetectionReviewState;
  readonly replacement_policy: PrivacyReplacementPolicy;
  readonly ruleset_version: typeof PRIVACY_DETECTOR_RULESET_VERSION;
  readonly secret_family?: SecretFamily;
}

export interface ResolvedPrivacyDetection extends PrivacyDetectionCandidate {
  readonly effective_start: number;
  readonly effective_end: number;
  readonly overlap_member_count: number;
}

export type SourceNamePolicy = "SAFE_SIMPLE_LABEL" | "SAFE_LABEL_REQUIRED";

export interface SourceNamePolicyResult {
  readonly policy: SourceNamePolicy;
  readonly reason_codes: readonly (
    | "PATH_SEPARATOR"
    | "WINDOWS_DRIVE_PATH"
    | "UNC_PATH"
    | "HOME_PATH"
    | "FILE_URL"
    | "CONTROL_CHARACTER"
    | "PATH_SEGMENT"
    | "PRIVACY_SPAN"
  )[];
}

export interface KnownEntityAlias {
  readonly value: string;
  readonly unambiguous?: boolean;
}

export interface KnownEntityEntry {
  readonly entity_type: "PERSON" | "ORG" | "PROJECT";
  readonly canonical_value: string;
  readonly aliases?: readonly (string | KnownEntityAlias)[];
}

export interface KnownEntityDictionary {
  readonly entries: readonly KnownEntityEntry[];
}

export interface PrivacyDetectionDiagnostics {
  readonly ruleset_version: typeof PRIVACY_DETECTOR_RULESET_VERSION;
  readonly stage: "PRIVACY_DETECTION";
  readonly entity_type_counts: Readonly<Partial<Record<PrivacyEntityType, number>>>;
  readonly surface_counts: Readonly<Partial<Record<PrivacyDetectionSurface, number>>>;
  readonly duration_ms: number;
  readonly failure_category: string | null;
}
