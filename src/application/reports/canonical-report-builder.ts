import { createHash } from "node:crypto";
import { z } from "zod";

import { AuditIdSchema, PrivacyRevisionIdSchema, ReportVersionIdSchema } from "../../domain/schemas/base.js";
import { SanitizedCanonicalRecordRevisionSchema } from "../../domain/schemas/canonical.js";
import { ChangeSchema } from "../../domain/schemas/change.js";
import { CommitmentSchema } from "../../domain/schemas/commitment.js";
import { PotentialConflictSchema } from "../../domain/schemas/conflict.js";
import { EvidenceSchema } from "../../domain/schemas/evidence.js";
import { AuditReportSchema, ReportVersionSchema, type AuditReport, type ReportVersion } from "../../domain/schemas/report.js";
import { validateEvidenceExcerpt } from "../../domain/validators/invariants.js";
import { PersistenceError } from "../../db/persistence-errors.js";
import { detectSecrets } from "../../privacy/detection/rules/secret.js";
import { evaluateSourceNamePolicy } from "../../privacy/detection/source-name-policy.js";
import { compareUnicodeCodePoints, stableCanonicalSerialize } from "../../shared/ids/stable-serialization.js";

export const CANONICAL_FORMAT_VERSION = 1 as const;
export const ACCEPTED_REPORT_DOMAIN_SEPARATOR = "PROJECT_COMMITMENT_AUDIT:ACCEPTED_REPORT:v1\0";
export const CanonicalDigestSchema = z.string().regex(/^[0-9a-f]{64}$/u);

const SnapshotShapeSchema = z.object({
  canonical_format_version: z.literal(CANONICAL_FORMAT_VERSION),
  binding: z.object({ audit_id: AuditIdSchema, report_version_id: ReportVersionIdSchema, privacy_revision_id: PrivacyRevisionIdSchema }).strict(),
  report: AuditReportSchema,
  evidence: z.array(EvidenceSchema),
  commitments: z.array(CommitmentSchema),
  changes: z.array(ChangeSchema),
  conflicts: z.array(PotentialConflictSchema),
}).strict();

export type AcceptedCanonicalReportV1 = z.infer<typeof SnapshotShapeSchema>;
const AuthoritySchema = z.object({
  reportVersion: ReportVersionSchema,
  records: z.array(SanitizedCanonicalRecordRevisionSchema),
  evidence: z.array(EvidenceSchema),
  commitments: z.array(CommitmentSchema),
  changes: z.array(ChangeSchema),
  conflicts: z.array(PotentialConflictSchema),
  reportVersions: z.array(ReportVersionSchema),
  historicalCommitments: z.array(CommitmentSchema),
}).strict();
export type CanonicalReportAuthority = z.input<typeof AuthoritySchema>;

function reject(): never {
  throw new PersistenceError("PERSISTENCE_INTEGRITY_ERROR", "Canonical report authority or integrity validation failed.");
}

function uniqueSorted(values: readonly string[]): string[] {
  if (new Set(values).size !== values.length) reject();
  return [...values].sort(compareUnicodeCodePoints);
}
function union(...arrays: readonly (readonly string[])[]): string[] {
  return [...new Set(arrays.flat())].sort(compareUnicodeCodePoints);
}
function uniqueMap<T>(values: readonly T[], identify: (value: T) => string): Map<string, T> {
  const map = new Map<string, T>();
  for (const value of values) {
    const id = identify(value);
    if (map.has(id)) reject();
    map.set(id, value);
  }
  return map;
}

/** All text leaves are local safe data; structural schemas exclude raw/vault fields. */
function assertSafeTree(value: unknown): void {
  if (typeof value === "string") {
    const localPath = /(?:[A-Za-z]:[\\/]|\\\\[^\s\\]+\\|file:\/\/|(?:^|[\s("'])\/[^\s/]+(?:\/[^\s]*)?)/u;
    const authorization = /(?:\bAuthorization\s*:|\bBearer\s+\S{8,})/iu;
    if (detectSecrets("rec_canonical_scan", "CONTENT", value).length > 0 || localPath.test(value) || authorization.test(value)) reject();
  } else if (Array.isArray(value)) {
    for (const item of value) assertSafeTree(item);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) assertSafeTree(item);
  }
}

function normalizedObjects(snapshot: AcceptedCanonicalReportV1) {
  const evidence = [...snapshot.evidence].sort((a, b) => a.source_ref.sequence - b.source_ref.sequence || a.source_ref.char_start - b.source_ref.char_start || a.source_ref.char_end - b.source_ref.char_end || compareUnicodeCodePoints(a.evidence_id, b.evidence_id));
  const commitments = snapshot.commitments.map((c) => ({ ...c, evidence_ids: uniqueSorted(c.evidence_ids), status_evidence_ids: uniqueSorted(c.status_evidence_ids) })).sort((a, b) => compareUnicodeCodePoints(a.commitment_id, b.commitment_id));
  const changes = snapshot.changes.map((c) => ({ ...c, evidence_ids: uniqueSorted(c.evidence_ids) })).sort((a, b) => compareUnicodeCodePoints(a.change_id, b.change_id));
  const conflicts = snapshot.conflicts.map((c) => {
    const explanations = c.alternative_explanations.map((item) => ({ ...item }));
    uniqueSorted(explanations.map(stableCanonicalSerialize));
    explanations.sort((a, b) => compareUnicodeCodePoints(stableCanonicalSerialize(a), stableCanonicalSerialize(b)));
    return { ...c, claim_a: { ...c.claim_a, evidence_ids: uniqueSorted(c.claim_a.evidence_ids) }, claim_b: { ...c.claim_b, evidence_ids: uniqueSorted(c.claim_b.evidence_ids) }, counter_evidence_ids: uniqueSorted(c.counter_evidence_ids), missing_evidence: uniqueSorted(c.missing_evidence), alternative_explanations: explanations };
  }).sort((a, b) => compareUnicodeCodePoints(a.conflict_id, b.conflict_id));
  return { evidence, commitments, changes, conflicts };
}

function derivedReport(version: ReportVersion, objects: ReturnType<typeof normalizedObjects>): AuditReport {
  const { evidence, commitments, changes, conflicts } = objects;
  const items: AuditReport["audit_summary"]["items"] = [];
  const unresolved: string[] = [];
  const missing: AuditReport["missing_evidence_and_uncertainty"] = [];
  const timeline: AuditReport["timeline"] = [];
  const addUnknown = (id: string, subject: string, known: string[], question: string): void => {
    missing.push({ item_id: id, subject, question, known_evidence_ids: union(known), missing_information: "Local authority remains unresolved.", epistemic_status: "UNKNOWN" });
    unresolved.push(id);
  };
  for (const e of evidence) {
    const text = `${e.evidence_id}: SOURCE_FACT (source statement only).`;
    items.push({ text, epistemic_status: "FACT", evidence_ids: [e.evidence_id], domain_ids: [], conflicted: false });
    timeline.push({ event_type: "EVIDENCE", occurred_at: e.timestamp, display_summary: text, evidence_ids: [e.evidence_id], epistemic_status: "FACT" });
  }
  for (const c of commitments) {
    const refs = union(c.evidence_ids, c.status_evidence_ids);
    const state = c.lifecycle_status === "UNKNOWN" ? "UNKNOWN" : c.epistemic_status;
    const text = `${c.commitment_id}: ${c.classification}; lifecycle=${c.lifecycle_status}; ${c.action_or_deliverable}`;
    items.push({ text, epistemic_status: state, evidence_ids: refs, domain_ids: [c.commitment_id], conflicted: false });
    timeline.push({ event_type: "COMMITMENT", occurred_at: null, display_summary: text, evidence_ids: refs, epistemic_status: state });
    if (c.classification === "CANDIDATE" || c.lifecycle_status === "UNKNOWN") addUnknown(`commitment:${c.commitment_id}`, c.action_or_deliverable, refs, "Commitment classification or lifecycle remains unresolved.");
  }
  for (const c of changes) {
    const text = `${c.change_id}: ${c.classification}; ${c.change_type}; ${c.subject}`;
    items.push({ text, epistemic_status: c.epistemic_status, evidence_ids: [...c.evidence_ids], domain_ids: [c.change_id], conflicted: false });
    timeline.push({ event_type: "CHANGE", occurred_at: c.timestamp, display_summary: text, evidence_ids: [...c.evidence_ids], epistemic_status: c.epistemic_status });
    if (c.classification === "CANDIDATE") addUnknown(`change:${c.change_id}`, c.subject, c.evidence_ids, "Change authority remains unresolved.");
  }
  for (const c of conflicts) {
    const refs = union(c.claim_a.evidence_ids, c.claim_b.evidence_ids, c.counter_evidence_ids);
    const text = `${c.conflict_id}: POTENTIAL_CONFLICT / UNRESOLVED; ${c.comparable_context.subject}`;
    items.push({ text, epistemic_status: c.epistemic_status, evidence_ids: refs, domain_ids: [c.conflict_id], conflicted: true });
    timeline.push({ event_type: "CONFLICT", occurred_at: null, display_summary: text, evidence_ids: refs, epistemic_status: c.epistemic_status });
    addUnknown(`conflict:${c.conflict_id}`, c.comparable_context.subject, refs, "Potential conflict is unresolved; counter-evidence remains part of the review.");
    c.missing_evidence.forEach((text, i) => addUnknown(`conflict:${c.conflict_id}:${i}`, c.comparable_context.subject, refs, text));
  }
  if (evidence.length === 0) addUnknown("evidence:none", "Source evidence", [], "No local source Evidence is available.");
  timeline.sort((a, b) => {
    const time = a.occurred_at === null ? (b.occurred_at === null ? 0 : 1) : b.occurred_at === null ? -1 : compareUnicodeCodePoints(a.occurred_at, b.occurred_at);
    return time || compareUnicodeCodePoints(a.event_type, b.event_type) || compareUnicodeCodePoints(stableCanonicalSerialize(a), stableCanonicalSerialize(b));
  });
  missing.sort((a, b) => compareUnicodeCodePoints(a.item_id, b.item_id));
  return {
    report_version: { ...version, changes_summary: changes.length === 0 ? null : `Local changes: ${changes.length}.` },
    audit_summary: { items, unresolved_items: uniqueSorted(unresolved) },
    evidence_ledger: uniqueSorted(evidence.map((e) => e.evidence_id)),
    timeline,
    commitment_ledger: commitments.map((c) => c.commitment_id),
    requirement_decision_change_log: changes.map((c) => c.change_id),
    conflict_counter_evidence_review: conflicts.map((c) => c.conflict_id),
    missing_evidence_and_uncertainty: missing,
  };
}

function validateSnapshot(snapshot: AcceptedCanonicalReportV1): void {
  const version = snapshot.report.report_version;
  const binding = snapshot.binding;
  if (version.audit_id !== binding.audit_id || version.report_version_id !== binding.report_version_id || version.privacy_revision_id !== binding.privacy_revision_id || version.status !== "COMPLETED" || version.completed_at === null) reject();
  for (const time of [version.created_at, version.started_at, version.completed_at]) {
    if (time !== null && (!Number.isFinite(Date.parse(time)) || new Date(time).toISOString() !== time)) reject();
  }
  const objects = normalizedObjects(snapshot);
  const evidence = uniqueMap(objects.evidence, (e) => e.evidence_id);
  const commitments = uniqueMap(objects.commitments, (c) => c.commitment_id);
  uniqueMap(objects.changes, (c) => c.change_id);
  uniqueMap(objects.conflicts, (c) => c.conflict_id);
  const refs = (ids: readonly string[]): void => { uniqueSorted(ids); if (ids.some((id) => !evidence.has(id))) reject(); };
  for (const e of objects.evidence) {
    if (e.report_version_id !== binding.report_version_id || e.privacy_revision_id !== binding.privacy_revision_id) reject();
    if (evaluateSourceNamePolicy(e.source_ref.source_name, []).policy !== "SAFE_SIMPLE_LABEL") reject();
  }
  for (const c of objects.commitments) {
    if (c.report_version_id !== binding.report_version_id) reject();
    refs(c.evidence_ids); refs(c.status_evidence_ids);
    const visited = new Set<string>([c.commitment_id]);
    let next = c.supersedes_commitment_id;
    while (next !== null && commitments.has(next)) {
      if (visited.has(next)) reject();
      visited.add(next); next = commitments.get(next)!.supersedes_commitment_id;
    }
    if (next !== null && visited.has(next)) reject();
  }
  for (const c of objects.changes) { if (c.report_version_id !== binding.report_version_id) reject(); refs(c.evidence_ids); }
  for (const c of objects.conflicts) {
    if (c.report_version_id !== binding.report_version_id) reject();
    refs(c.claim_a.evidence_ids); refs(c.claim_b.evidence_ids); refs(c.counter_evidence_ids);
  }
  const normalized = { ...snapshot, ...objects, report: derivedReport(version, objects) };
  if (stableCanonicalSerialize(normalized) !== stableCanonicalSerialize(snapshot)) reject();
  assertSafeTree(snapshot);
}

/** Strict V1 includes normalized order, exact ledgers and local deterministic views. */
export const AcceptedCanonicalReportV1Schema = SnapshotShapeSchema.superRefine((value, context) => {
  try { validateSnapshot(value); } catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid accepted canonical V1 authority or normalization." }); }
});

export function parseAcceptedCanonicalReportV1(input: unknown): AcceptedCanonicalReportV1 {
  const parsed = AcceptedCanonicalReportV1Schema.safeParse(input);
  if (!parsed.success) reject();
  return parsed.data;
}

export function canonicalDigestV1(canonicalJson: string): string {
  return createHash("sha256").update(ACCEPTED_REPORT_DOMAIN_SEPARATOR + canonicalJson, "utf8").digest("hex");
}
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Source records are validation-only; the accepted snapshot retains Evidence excerpts, not whole source records. */
export function buildCanonicalReport(input: unknown) {
  const parsed = AuthoritySchema.safeParse(input);
  if (!parsed.success) reject();
  const a = parsed.data;
  const version = a.reportVersion;
  const reports = uniqueMap(a.reportVersions, (r) => r.report_version_id);
  if (reports.size !== a.reportVersions.length || stableCanonicalSerialize(reports.get(version.report_version_id)) !== stableCanonicalSerialize(version)) reject();
  if (a.reportVersions.some((r) => r.audit_id !== version.audit_id)) reject();
  uniqueSorted(a.reportVersions.map((r) => String(r.version_number)));
  const lineage = (id: string): Set<string> => {
    const ids = new Set<string>();
    let current: string | null = id;
    while (current !== null) {
      if (ids.has(current)) reject();
      ids.add(current);
      const r: ReportVersion | undefined = reports.get(current);
      if (!r || r.audit_id !== version.audit_id) reject();
      if (r.parent_report_version_id !== null) {
        const parent = reports.get(r.parent_report_version_id);
        if (!parent || parent.version_number >= r.version_number) reject();
      }
      current = r.parent_report_version_id;
    }
    return ids;
  };
  const targetLineage = lineage(version.report_version_id);
  const records = uniqueMap(a.records, (r) => r.record_revision_id);
  uniqueSorted(a.records.map((r) => r.record_id));
  if (a.records.some((r) => r.audit_id !== version.audit_id || r.privacy_revision_id !== version.privacy_revision_id)) reject();
  for (const record of a.records) {
    assertSafeTree(record);
    if (evaluateSourceNamePolicy(record.source_name, []).policy !== "SAFE_SIMPLE_LABEL") reject();
  }
  uniqueMap(a.evidence, (e) => e.evidence_id);
  for (const e of a.evidence) {
    const record = records.get(e.record_revision_id);
    if (!record || e.report_version_id !== version.report_version_id || e.privacy_revision_id !== version.privacy_revision_id || !validateEvidenceExcerpt(record, e).ok) reject();
  }
  const allCommitments = uniqueMap([...a.commitments, ...a.historicalCommitments], (c) => c.commitment_id);
  for (const c of a.commitments) {
    const visited = new Set<string>([c.commitment_id]);
    let previous = c;
    let next = c.supersedes_commitment_id;
    while (next !== null) {
      if (visited.has(next)) reject();
      visited.add(next);
      const target = allCommitments.get(next);
      if (!target || !targetLineage.has(target.report_version_id) || !lineage(previous.report_version_id).has(target.report_version_id)) reject();
      previous = target; next = target.supersedes_commitment_id;
    }
  }
  const shell: AcceptedCanonicalReportV1 = {
    canonical_format_version: CANONICAL_FORMAT_VERSION,
    binding: { audit_id: version.audit_id, report_version_id: version.report_version_id, privacy_revision_id: version.privacy_revision_id },
    report: { report_version: version, audit_summary: { items: [], unresolved_items: [] }, evidence_ledger: [], timeline: [], commitment_ledger: [], requirement_decision_change_log: [], conflict_counter_evidence_review: [], missing_evidence_and_uncertainty: [] },
    evidence: a.evidence, commitments: a.commitments, changes: a.changes, conflicts: a.conflicts,
  };
  const objects = normalizedObjects(shell);
  const snapshot = parseAcceptedCanonicalReportV1({ ...shell, ...objects, report: derivedReport(version, objects) });
  const canonicalJson = stableCanonicalSerialize(snapshot);
  return deepFreeze({ canonical_snapshot: snapshot, canonical_json: canonicalJson, canonical_digest: canonicalDigestV1(canonicalJson) });
}
