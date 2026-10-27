import { UiApiError, type ApiClient, type Audit, type PrivacyCandidate, type PrivacyReview, type ReportHistoryItem, type SafeReport } from "./api-client.js";

export const TRANSIENT_REVIEW_NOTICE = "未完成的隐私检查没有保存，请重新粘贴内容开始。";
export type WorkflowUiState =
  | { phase: "LOADING" }
  | { phase: "INPUT"; notice?: string }
  | { phase: "PRIVACY_REVIEW"; review: PrivacyReview }
  | { phase: "PRIVACY_CONFIRM"; review: PrivacyReview; candidate: PrivacyCandidate }
  | { phase: "CONFIRMED"; lastRunFailed: boolean; activeRunConflict?: boolean }
  | { phase: "ANALYZING" }
  | { phase: "REPORT_PREVIEW"; report: SafeReport }
  | { phase: "ACCEPTED"; report: SafeReport }
  | { phase: "ERROR"; error: UiApiError };

export type WorkflowEvent =
  | { type: "RESTORED"; state: WorkflowUiState }
  | { type: "EDIT_INPUT" }
  | { type: "PASTED"; review: PrivacyReview }
  | { type: "REVIEWED"; review: PrivacyReview }
  | { type: "FINALIZED"; candidate: PrivacyCandidate }
  | { type: "BACK_TO_REVIEW" }
  | { type: "CONFIRMED" }
  | { type: "ANALYZE_REQUESTED" }
  | { type: "RUN_FAILED"; alreadyActive: boolean }
  | { type: "RUN_COMPLETED"; report: SafeReport }
  | { type: "REPORT_ACCEPTED"; report: SafeReport };

export function transitionWorkflow(state: WorkflowUiState, event: WorkflowEvent): WorkflowUiState {
  if (event.type === "RESTORED") return event.state;
  if (event.type === "EDIT_INPUT" && (state.phase === "INPUT" || state.phase === "PRIVACY_REVIEW" || state.phase === "PRIVACY_CONFIRM")) return { phase: "INPUT" };
  if (event.type === "PASTED" && state.phase === "INPUT") return { phase: "PRIVACY_REVIEW", review: event.review };
  if (event.type === "REVIEWED" && state.phase === "PRIVACY_REVIEW") return { phase: "PRIVACY_REVIEW", review: event.review };
  if (event.type === "FINALIZED" && state.phase === "PRIVACY_REVIEW") return { phase: "PRIVACY_CONFIRM", review: state.review, candidate: event.candidate };
  if (event.type === "BACK_TO_REVIEW" && state.phase === "PRIVACY_CONFIRM") return { phase: "PRIVACY_REVIEW", review: state.review };
  if (event.type === "CONFIRMED" && state.phase === "PRIVACY_CONFIRM") return { phase: "CONFIRMED", lastRunFailed: false };
  if (event.type === "ANALYZE_REQUESTED" && state.phase === "CONFIRMED" && !state.activeRunConflict) return { phase: "ANALYZING" };
  if (event.type === "RUN_FAILED" && state.phase === "ANALYZING") return { phase: "CONFIRMED", lastRunFailed: !event.alreadyActive, activeRunConflict: event.alreadyActive };
  if (event.type === "RUN_COMPLETED" && state.phase === "ANALYZING") return { phase: "REPORT_PREVIEW", report: event.report };
  if (event.type === "REPORT_ACCEPTED" && state.phase === "REPORT_PREVIEW" && event.report.reportVersionId === state.report.reportVersionId && event.report.acceptedAt) return { phase: "ACCEPTED", report: event.report };
  throw new UiApiError(409, "REQUEST_CONFLICT");
}

/** GET-only recovery. Browser storage and write endpoints are never authorities here. */
export async function restoreWorkspace(api: ApiClient, auditId: string): Promise<{ audit: Audit; state: WorkflowUiState; history: ReportHistoryItem[] }> {
  const [audit, workflow] = await Promise.all([api.getAudit(auditId), api.getWorkflow(auditId)]);
  if (audit.auditId !== auditId || workflow.auditId !== auditId) throw new UiApiError(409, "REQUEST_CONFLICT");
  const history = await api.history(auditId);
  let state: WorkflowUiState;
  if (!workflow.privacyConfirmed) {
    try { state = { phase: "PRIVACY_REVIEW", review: await api.getReview(auditId) }; }
    catch (error) {
      if (!(error instanceof UiApiError) || !["REQUEST_CONFLICT", "RESOURCE_NOT_FOUND"].includes(error.code)) throw error;
      state = { phase: "INPUT", notice: TRANSIENT_REVIEW_NOTICE };
    }
  } else if (!workflow.latestSettledReport || workflow.latestSettledReport.status === "FAILED") {
    state = { phase: "CONFIRMED", lastRunFailed: workflow.latestSettledReport?.status === "FAILED" };
  } else {
    const reportId = workflow.latestSettledReport.reportVersionId;
    const accepted = history.some((item) => item.reportVersionId === reportId);
    const report = accepted ? await api.reopen(auditId, reportId) : await api.preview(auditId);
    if (report.reportVersionId !== reportId || (accepted && !report.acceptedAt)) throw new UiApiError(409, "REQUEST_CONFLICT");
    state = accepted ? { phase: "ACCEPTED", report } : { phase: "REPORT_PREVIEW", report };
  }
  return { audit, state, history };
}

export function activeStep(state: WorkflowUiState): number {
  if (state.phase === "PRIVACY_REVIEW") return 2;
  if (state.phase === "PRIVACY_CONFIRM") return 3;
  if (state.phase === "CONFIRMED" || state.phase === "ANALYZING") return 4;
  if (state.phase === "REPORT_PREVIEW" || state.phase === "ACCEPTED") return 5;
  return 1;
}
