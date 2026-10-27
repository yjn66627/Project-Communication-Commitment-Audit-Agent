import { randomBytes, randomUUID } from "node:crypto";

import type {
  AuditId,
  ChangeId,
  CommitmentId,
  ConflictId,
  ProviderCallId,
  RecordId,
  ReportVersionId,
} from "./types.js";

export function createAuditId(): AuditId {
  return `aud_${randomUUID()}`;
}

export function createReportVersionId(): ReportVersionId {
  return `rpt_${randomUUID()}`;
}

export function createCommitmentId(): CommitmentId {
  return `com_${randomUUID()}`;
}

export function createChangeId(): ChangeId {
  return `chg_${randomUUID()}`;
}

export function createConflictId(): ConflictId {
  return `cfl_${randomUUID()}`;
}

export function createProviderCallId(): ProviderCallId {
  return `pcall_${randomUUID()}`;
}

export function createRandomRecordId(): RecordId {
  return `rec_${randomUUID()}`;
}

/** Local-only salt. Never place this value in provider payloads, logs or exports. */
export function createRevisionSalt(): Uint8Array {
  return randomBytes(32);
}
