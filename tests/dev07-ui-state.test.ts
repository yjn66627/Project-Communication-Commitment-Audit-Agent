import assert from "node:assert/strict";
import test from "node:test";
import { createApiClient, UiApiError, type ApiClient, type PrivacyReview, type SafeReport, type WorkflowMetadata } from "../src/lib/dev07/api-client.js";
import { activeStep, restoreWorkspace, transitionWorkflow, TRANSIENT_REVIEW_NOTICE, type WorkflowUiState } from "../src/lib/dev07/workflow-ui-state.js";

const audit = { auditId: "aud_ui_fixture", displayName: "Synthetic UI audit", createdAt: "2026-10-05T10:00:00.000Z" };
const review: PrivacyReview = { stage: "REVIEW_REQUIRED", detections: [], entities: [], seedPlaceholders: [], counters: { mergeCount: 0, splitCount: 0, falsePositiveCount: 0 } };
const report: SafeReport = { reportVersionId: "rpt_ui_fixture", canonicalDigest: "a".repeat(64), versionNumber: 1, completedAt: "2026-10-05T10:00:00.000Z", accepted: false, summary: { items: [], unresolvedItems: [] }, evidence: [], commitments: [], changes: [], conflicts: [] };
const candidate = { reviewCandidateId: `rcand_${"b".repeat(64)}`, preview: [] };
function api(workflow: WorkflowMetadata, overrides: Partial<ApiClient> = {}) {
  const calls: string[] = [];
  const value: ApiClient = { ...createApiClient(async () => { throw new Error("Unexpected mutation/network call."); }),
    async getAudit() { calls.push("audit"); return audit; }, async getWorkflow() { calls.push("workflow"); return workflow; },
    async history() { calls.push("history"); return []; }, async getReview() { calls.push("review"); throw new UiApiError(409, "REQUEST_CONFLICT"); },
    async preview() { calls.push("preview"); return report; }, async reopen() { calls.push("reopen"); return { ...report, acceptedAt: "2026-10-05T11:00:00.000Z" }; }, ...overrides };
  return { value, calls };
}
const metadata: WorkflowMetadata = { auditId: audit.auditId, privacyConfirmed: false, privacyConfirmedAt: null, latestSettledReport: null };

test("UI-state unconfirmed missing transient Review recovers INPUT with an ordinary explanation", async () => {
  const { value, calls } = api(metadata);
  const restored = await restoreWorkspace(value, audit.auditId);
  assert.deepEqual(restored.state, { phase: "INPUT", notice: TRANSIENT_REVIEW_NOTICE });
  assert.deepEqual(calls, ["audit", "workflow", "history", "review"]);
});
test("UI-state current transient Review recovers PRIVACY_REVIEW without finalize/confirm", async () => {
  const { value } = api(metadata, { async getReview() { return review; } });
  assert.deepEqual((await restoreWorkspace(value, audit.auditId)).state, { phase: "PRIVACY_REVIEW", review });
});
test("UI-state confirmed Privacy without current report recovers CONFIRMED; no automatic Run", async () => {
  const { value, calls } = api({ ...metadata, privacyConfirmed: true, privacyConfirmedAt: audit.createdAt });
  assert.deepEqual((await restoreWorkspace(value, audit.auditId)).state, { phase: "CONFIRMED", lastRunFailed: false });
  assert.deepEqual(calls, ["audit", "workflow", "history"]);
});
test("UI-state FAILED is retryable and never presented as an accepted report", async () => {
  const { value } = api({ ...metadata, privacyConfirmed: true, latestSettledReport: { reportVersionId: report.reportVersionId, versionNumber: 1, status: "FAILED" } });
  assert.deepEqual((await restoreWorkspace(value, audit.auditId)).state, { phase: "CONFIRMED", lastRunFailed: true });
});
test("UI-state COMPLETED unaccepted fetches Preview only; never automatically Accepts", async () => {
  const { value, calls } = api({ ...metadata, privacyConfirmed: true, latestSettledReport: { reportVersionId: report.reportVersionId, versionNumber: 1, status: "COMPLETED" } });
  assert.deepEqual((await restoreWorkspace(value, audit.auditId)).state, { phase: "REPORT_PREVIEW", report });
  assert.deepEqual(calls, ["audit", "workflow", "history", "preview"]);
});
test("UI-state accepted current version reopens immutable safe report without Run or Preview", async () => {
  const { value, calls } = api({ ...metadata, privacyConfirmed: true, latestSettledReport: { reportVersionId: report.reportVersionId, versionNumber: 1, status: "COMPLETED" } }, { async history() { return [{ reportVersionId: report.reportVersionId, versionNumber: 1, acceptedAt: audit.createdAt }]; } });
  assert.equal((await restoreWorkspace(value, audit.auditId)).state.phase, "ACCEPTED");
  assert.deepEqual(calls, ["audit", "workflow", "reopen"]);
});
test("UI-state old accepted history cannot supply current Privacy workflow authority", async () => {
  const { value, calls } = api({ ...metadata, privacyConfirmed: true }, { async history() { return [{ reportVersionId: "rpt_old", versionNumber: 1, acceptedAt: audit.createdAt }]; } });
  assert.equal((await restoreWorkspace(value, audit.auditId)).state.phase, "CONFIRMED");
  assert.deepEqual(calls, ["audit", "workflow"]);
});
test("UI-state mismatched Audit identity fails closed", async () => {
  const { value } = api({ ...metadata, auditId: "aud_other" });
  await assert.rejects(restoreWorkspace(value, audit.auditId), UiApiError);
});
test("UI-state latest report mismatch fails closed", async () => {
  const { value } = api({ ...metadata, privacyConfirmed: true, latestSettledReport: { reportVersionId: "rpt_other", versionNumber: 2, status: "COMPLETED" } });
  await assert.rejects(restoreWorkspace(value, audit.auditId), UiApiError);
});
test("UI-state network/server Review error is not silently classified as a missing transient session", async () => {
  const { value } = api(metadata, { async getReview() { throw new UiApiError(0, "NETWORK_ERROR"); } });
  await assert.rejects(restoreWorkspace(value, audit.auditId), (error: unknown) => error instanceof UiApiError && error.code === "NETWORK_ERROR");
});
test("UI-state every normal transition requires a distinct explicit event", () => {
  let state: WorkflowUiState = { phase: "INPUT" };
  state = transitionWorkflow(state, { type: "PASTED", review });
  state = transitionWorkflow(state, { type: "FINALIZED", candidate });
  assert.equal(state.phase, "PRIVACY_CONFIRM");
  state = transitionWorkflow(state, { type: "CONFIRMED" });
  assert.equal(state.phase, "CONFIRMED");
  state = transitionWorkflow(state, { type: "ANALYZE_REQUESTED" });
  state = transitionWorkflow(state, { type: "RUN_COMPLETED", report });
  assert.equal(state.phase, "REPORT_PREVIEW");
  state = transitionWorkflow(state, { type: "REPORT_ACCEPTED", report: { ...report, acceptedAt: audit.createdAt } });
  assert.equal(state.phase, "ACCEPTED");
});
test("UI-state no invalid early Run or early report Acceptance transition", () => {
  for (const state of [{ phase: "INPUT" }, { phase: "PRIVACY_REVIEW", review }, { phase: "PRIVACY_CONFIRM", review, candidate }] satisfies WorkflowUiState[]) {
    assert.throws(() => transitionWorkflow(state, { type: "ANALYZE_REQUESTED" }), UiApiError);
    assert.throws(() => transitionWorkflow(state, { type: "REPORT_ACCEPTED", report }), UiApiError);
  }
});
test("UI-state returning to Review discards finalized candidate authority", () => {
  const state = transitionWorkflow({ phase: "PRIVACY_CONFIRM", review, candidate }, { type: "BACK_TO_REVIEW" });
  assert.deepEqual(state, { phase: "PRIVACY_REVIEW", review });
  assert.equal("candidate" in state, false);
});
test("UI-state RUN_ALREADY_ACTIVE blocks repeated analysis until explicit state refresh", () => {
  const state = transitionWorkflow({ phase: "ANALYZING" }, { type: "RUN_FAILED", alreadyActive: true });
  assert.deepEqual(state, { phase: "CONFIRMED", lastRunFailed: false, activeRunConflict: true });
  assert.throws(() => transitionWorkflow(state, { type: "ANALYZE_REQUESTED" }), UiApiError);
});
test("UI-state generic analysis failure permits an explicit retry", () => {
  const state = transitionWorkflow({ phase: "ANALYZING" }, { type: "RUN_FAILED", alreadyActive: false });
  assert.equal(transitionWorkflow(state, { type: "ANALYZE_REQUESTED" }).phase, "ANALYZING");
});
test("UI-state Acceptance requires matching report and accepted timestamp", () => {
  const state: WorkflowUiState = { phase: "REPORT_PREVIEW", report };
  assert.throws(() => transitionWorkflow(state, { type: "REPORT_ACCEPTED", report }), UiApiError);
  assert.throws(() => transitionWorkflow(state, { type: "REPORT_ACCEPTED", report: { ...report, reportVersionId: "rpt_other", acceptedAt: audit.createdAt } }), UiApiError);
});
test("UI-state visible step sequence uses product stages rather than technical identifiers", () => {
  const states: WorkflowUiState[] = [{ phase: "INPUT" }, { phase: "PRIVACY_REVIEW", review }, { phase: "PRIVACY_CONFIRM", review, candidate }, { phase: "CONFIRMED", lastRunFailed: false }, { phase: "REPORT_PREVIEW", report }];
  assert.deepEqual(states.map(activeStep), [1, 2, 3, 4, 5]);
});
