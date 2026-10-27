import type { PrivacyDetectionCandidate, SourceNamePolicyResult } from "./types.js";

export function evaluateSourceNamePolicy(rawSourceName: string, detections: readonly PrivacyDetectionCandidate[]): SourceNamePolicyResult {
  const reasons: SourceNamePolicyResult["reason_codes"][number][] = [];
  const add = (reason: SourceNamePolicyResult["reason_codes"][number]) => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (/[\\/]/u.test(rawSourceName)) add("PATH_SEPARATOR");
  if (/^[A-Za-z]:[\\/]/u.test(rawSourceName)) add("WINDOWS_DRIVE_PATH");
  if (/^(?:\\\\|\/\/)/u.test(rawSourceName)) add("UNC_PATH");
  if (/^~[\\/]/u.test(rawSourceName)) add("HOME_PATH");
  if (/^file:\/\//iu.test(rawSourceName)) add("FILE_URL");
  if (/[\u0000-\u001F\u007F]/u.test(rawSourceName)) add("CONTROL_CHARACTER");
  if (/(?:^|[\\/])\.{1,2}(?:[\\/]|$)/u.test(rawSourceName)) add("PATH_SEGMENT");
  if (detections.length > 0) add("PRIVACY_SPAN");
  return Object.freeze({
    policy: reasons.length === 0 ? "SAFE_SIMPLE_LABEL" : "SAFE_LABEL_REQUIRED",
    reason_codes: Object.freeze(reasons),
  });
}
