import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";
import type { LatestConfirmedRevisionMetadata } from "./types.js";

const UTC_MILLIS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isValidConfirmedAt(value: string | null): value is string {
  return value !== null && UTC_MILLIS.test(value) && Number.isFinite(Date.parse(value));
}

export function selectLatestApplicableConfirmedRevision(
  auditId: string,
  revisions: readonly LatestConfirmedRevisionMetadata[],
): LatestConfirmedRevisionMetadata | undefined {
  return revisions
    .filter((revision) => revision.audit_id === auditId && isValidConfirmedAt(revision.confirmed_at))
    .sort((a, b) => {
      const time = Date.parse(b.confirmed_at!) - Date.parse(a.confirmed_at!);
      return time !== 0 ? time : compareUnicodeCodePoints(a.privacy_revision_id, b.privacy_revision_id);
    })[0];
}
