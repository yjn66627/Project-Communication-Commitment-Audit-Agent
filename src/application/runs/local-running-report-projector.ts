import type { RequirementDecisionChange } from "../../domain/schemas/change.js";
import type { Commitment } from "../../domain/schemas/commitment.js";
import type { PotentialConflict } from "../../domain/schemas/conflict.js";
import type { Evidence } from "../../domain/schemas/evidence.js";
import { AuditReportSchema, type AuditReport, type MissingEvidence, type ReportVersion } from "../../domain/schemas/report.js";
import { compareUnicodeCodePoints } from "../../shared/ids/stable-serialization.js";

function union(...groups: readonly (readonly string[])[]): string[] {
  return [...new Set(groups.flat())].sort(compareUnicodeCodePoints);
}

function addUnresolved(
  missing: MissingEvidence[],
  unresolved: string[],
  itemId: string,
  subject: string,
  knownEvidenceIds: readonly string[],
  question: string,
): void {
  missing.push({
    item_id: itemId,
    subject,
    question,
    known_evidence_ids: union(knownEvidenceIds),
    missing_information: "Local authority remains unresolved.",
    epistemic_status: "UNKNOWN",
  });
  unresolved.push(itemId);
}

/** A transient, report-version-bound view for Report Finalize Egress only. */
export function projectLocalRunningReport(input: Readonly<{
  reportVersion: ReportVersion;
  evidence: readonly Evidence[];
  commitments: readonly Commitment[];
  changes: readonly RequirementDecisionChange[];
  conflicts: readonly PotentialConflict[];
}>): AuditReport {
  const { reportVersion, evidence, commitments, changes, conflicts } = input;
  if (reportVersion.status !== "RUNNING") throw new Error("RUNNING_REPORT_REQUIRED");

  const items: AuditReport["audit_summary"]["items"] = [];
  const unresolved: string[] = [];
  const missing: MissingEvidence[] = [];
  const timeline: AuditReport["timeline"] = [];

  for (const item of evidence) {
    const text = `${item.evidence_id}: SOURCE_FACT (source statement only).`;
    items.push({ text, epistemic_status: "FACT", evidence_ids: [item.evidence_id], domain_ids: [], conflicted: false });
    timeline.push({ event_type: "EVIDENCE", occurred_at: item.timestamp, display_summary: text, evidence_ids: [item.evidence_id], epistemic_status: "FACT" });
  }

  for (const item of commitments) {
    const refs = union(item.evidence_ids, item.status_evidence_ids);
    const status = item.lifecycle_status === "UNKNOWN" ? "UNKNOWN" : item.epistemic_status;
    const text = `${item.commitment_id}: ${item.classification}; lifecycle=${item.lifecycle_status}; ${item.action_or_deliverable}`;
    items.push({ text, epistemic_status: status, evidence_ids: refs, domain_ids: [item.commitment_id], conflicted: false });
    timeline.push({ event_type: "COMMITMENT", occurred_at: null, display_summary: text, evidence_ids: refs, epistemic_status: status });
    if (item.classification === "CANDIDATE" || item.lifecycle_status === "UNKNOWN") {
      addUnresolved(missing, unresolved, `commitment:${item.commitment_id}`, item.action_or_deliverable, refs, "Commitment classification or lifecycle remains unresolved.");
    }
  }

  for (const item of changes) {
    const text = `${item.change_id}: ${item.classification}; ${item.change_type}; ${item.subject}`;
    items.push({ text, epistemic_status: item.epistemic_status, evidence_ids: [...item.evidence_ids], domain_ids: [item.change_id], conflicted: false });
    timeline.push({ event_type: "CHANGE", occurred_at: item.timestamp, display_summary: text, evidence_ids: [...item.evidence_ids], epistemic_status: item.epistemic_status });
    if (item.classification === "CANDIDATE") {
      addUnresolved(missing, unresolved, `change:${item.change_id}`, item.subject, item.evidence_ids, "Change authority remains unresolved.");
    }
  }

  for (const item of conflicts) {
    const refs = union(item.claim_a.evidence_ids, item.claim_b.evidence_ids, item.counter_evidence_ids);
    const text = `${item.conflict_id}: POTENTIAL_CONFLICT / UNRESOLVED; ${item.comparable_context.subject}`;
    items.push({ text, epistemic_status: item.epistemic_status, evidence_ids: refs, domain_ids: [item.conflict_id], conflicted: true });
    timeline.push({ event_type: "CONFLICT", occurred_at: null, display_summary: text, evidence_ids: refs, epistemic_status: item.epistemic_status });
    addUnresolved(missing, unresolved, `conflict:${item.conflict_id}`, item.comparable_context.subject, refs, "Potential conflict is unresolved; counter-evidence remains part of the review.");
    item.missing_evidence.forEach((question, index) => addUnresolved(missing, unresolved, `conflict:${item.conflict_id}:${index}`, item.comparable_context.subject, refs, question));
  }

  if (evidence.length === 0) {
    addUnresolved(missing, unresolved, "evidence:none", "Source evidence", [], "No local source Evidence is available.");
  }

  timeline.sort((left, right) => {
    const time = left.occurred_at === null
      ? (right.occurred_at === null ? 0 : 1)
      : right.occurred_at === null ? -1 : compareUnicodeCodePoints(left.occurred_at, right.occurred_at);
    return time || compareUnicodeCodePoints(left.event_type, right.event_type) || compareUnicodeCodePoints(JSON.stringify(left), JSON.stringify(right));
  });
  missing.sort((left, right) => compareUnicodeCodePoints(left.item_id, right.item_id));

  const report = {
    report_version: reportVersion,
    audit_summary: { items, unresolved_items: [...new Set(unresolved)].sort(compareUnicodeCodePoints) },
    evidence_ledger: union(evidence.map((item) => item.evidence_id)),
    timeline,
    commitment_ledger: commitments.map((item) => item.commitment_id),
    requirement_decision_change_log: changes.map((item) => item.change_id),
    conflict_counter_evidence_review: conflicts.map((item) => item.conflict_id),
    missing_evidence_and_uncertainty: missing,
  };
  const parsed = AuditReportSchema.safeParse(report);
  if (!parsed.success) throw new Error("LOCAL_REPORT_PROJECTION_INVALID");
  return parsed.data;
}
