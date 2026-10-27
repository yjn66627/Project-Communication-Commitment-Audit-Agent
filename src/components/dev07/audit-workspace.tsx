"use client";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { apiClient, toUiError, UiApiError, type Audit, type ReportHistoryItem, type SafeReport } from "../../lib/dev07/api-client";
import { activeStep, restoreWorkspace, transitionWorkflow, type WorkflowUiState } from "../../lib/dev07/workflow-ui-state";
import { PrivacyReviewPanel } from "./privacy-review-panel";
import { ReportPanel } from "./report-panel";
import { HistoryPanel } from "./history-panel";
import { Badge, ErrorNotice, Loading } from "./status-ui";

const STEPS = ["导入沟通内容", "隐私检查", "确认脱敏", "AI 分析", "审计报告"];
const PHASE_LABELS: Record<WorkflowUiState["phase"], string> = { LOADING: "正在加载", INPUT: "等待导入", PRIVACY_REVIEW: "隐私检查中", PRIVACY_CONFIRM: "等待确认脱敏", CONFIRMED: "可以开始分析", ANALYZING: "正在分析", REPORT_PREVIEW: "报告待确认", ACCEPTED: "报告已保存", ERROR: "暂不可用" };

export function AuditWorkspace({ auditId }: { auditId: string }) {
  const [audit, setAudit] = useState<Audit | null>(null);
  const [state, setState] = useState<WorkflowUiState>({ phase: "LOADING" });
  const [history, setHistory] = useState<ReportHistoryItem[]>([]);
  const [historicalReport, setHistoricalReport] = useState<SafeReport | null>(null);
  const [error, setError] = useState<UiApiError | null>(null);
  const [pending, setPending] = useState(false);
  const [text, setText] = useState(""); const [sourceName, setSource] = useState(""); const [author, setAuthor] = useState("");
  const operation = useRef(false); const readSequence = useRef(0);

  const read = useCallback(() => {
    const sequence = ++readSequence.current;
    return restoreWorkspace(apiClient, auditId)
      .then((result) => { if (sequence === readSequence.current) { setAudit(result.audit); setHistory(result.history); setState(result.state); } })
      .catch((cause) => { if (sequence === readSequence.current) setState({ phase: "ERROR", error: toUiError(cause) }); });
  }, [auditId]);
  useEffect(() => { void read(); return () => { readSequence.current += 1; }; }, [read]);

  async function load() {
    setState({ phase: "LOADING" }); setError(null); setHistoricalReport(null);
    await read();
  }

  async function perform(action: () => Promise<void>) {
    if (operation.current) return;
    operation.current = true; setPending(true); setError(null);
    try { await action(); }
    catch (cause) { setError(toUiError(cause)); }
    finally { operation.current = false; setPending(false); }
  }
  function paste(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void perform(async () => {
      const review = await apiClient.paste(auditId, { text, ...(sourceName.trim() ? { sourceName: sourceName.trim() } : {}), ...(author.trim() ? { author: author.trim() } : {}) });
      setText(""); setSource(""); setAuthor("");
      setState((old) => transitionWorkflow(old, { type: "PASTED", review }));
    });
  }
  async function analyze() {
    setState((old) => transitionWorkflow(old, { type: "ANALYZE_REQUESTED" }));
    let completed = false;
    try { const result = await apiClient.run(auditId); completed = true; const report = await apiClient.preview(auditId); if (report.reportVersionId !== result.reportVersionId) throw new UiApiError(409, "REQUEST_CONFLICT"); setState((old) => transitionWorkflow(old, { type: "RUN_COMPLETED", report })); }
    catch (cause) {
      const safeError = toUiError(cause); setError(safeError);
      if (completed) setState({ phase: "ERROR", error: safeError });
      else setState((old) => transitionWorkflow(old, { type: "RUN_FAILED", alreadyActive: safeError.status === 409 && safeError.code === "RUN_ALREADY_ACTIVE" }));
    }
  }
  const selectedId = historicalReport?.reportVersionId ?? ((state.phase === "ACCEPTED" || state.phase === "REPORT_PREVIEW") ? state.report.reportVersionId : undefined);
  const busy = pending || state.phase === "LOADING" || state.phase === "ANALYZING";

  return <><Link className="back-link" href="/">← 返回项目列表</Link>
    <div className="workspace-heading"><div><p className="eyebrow">项目工作台</p><h1>{audit?.displayName ?? "审计项目"}</h1><p>从沟通记录到可追溯报告，每一步由你确认。</p></div><div className="workspace-heading-actions"><Badge tone={state.phase === "ACCEPTED" ? "green" : "blue"}>{PHASE_LABELS[state.phase]}</Badge><button className="button button-small button-secondary" disabled={busy} onClick={() => { void perform(load); }}>刷新项目状态</button></div></div>
    <ol className="stepper" aria-label="审计步骤">{STEPS.map((label, i) => <li key={label} className={i + 1 === activeStep(state) ? "step-active" : i + 1 < activeStep(state) ? "step-complete" : ""} aria-current={i + 1 === activeStep(state) ? "step" : undefined}><span className="step-number" aria-hidden="true">{i + 1 < activeStep(state) ? "✓" : i + 1}</span><span>{label}</span></li>)}</ol>
    <ErrorNotice error={state.phase === "ERROR" ? null : error} />
    <div className="workspace-grid"><div className="workspace-main">
      {historicalReport ? <><div className="history-return"><Badge>历史版本 · 只读</Badge><button className="button button-small button-secondary" disabled={busy} onClick={() => setHistoricalReport(null)}>返回当前流程</button></div><ReportPanel report={historicalReport} mode="history" /></> : <>
        {state.phase === "LOADING" && <div className="card panel"><Loading>正在恢复项目状态……</Loading></div>}
        {state.phase === "ERROR" && <section className="card panel"><h2>暂时无法读取项目</h2><ErrorNotice error={state.error} /><button className="button button-primary" disabled={pending} onClick={() => { void perform(load); }}>重新加载项目</button></section>}
        {state.phase === "INPUT" && <form className="card panel" onSubmit={paste} aria-busy={pending}>
          <div className="panel-heading"><div><p className="eyebrow">步骤 1 · 导入内容</p><h2>导入沟通内容</h2><p>粘贴聊天、会议纪要或项目沟通记录。</p></div></div>
          {state.notice && <div className="notice notice-info">{state.notice}</div>}
          <label htmlFor="communication-text">沟通文本 <span className="required-label">必填</span></label><textarea id="communication-text" rows={12} value={text} onChange={(event) => setText(event.target.value)} disabled={pending} required placeholder="将需要审查的项目沟通粘贴到这里……" aria-describedby="communication-help communication-size" />
          <div className="textarea-meta"><span id="communication-help">支持最多约 256 KiB 文本。</span><span id="communication-size">{Array.from(text).length.toLocaleString("zh-CN")} 个字符</span></div>
          <div className="form-grid"><div><label htmlFor="communication-source">来源名称 <span className="muted">选填</span></label><input id="communication-source" maxLength={512} value={sourceName} onChange={(event) => setSource(event.target.value)} disabled={pending} placeholder="例如：项目周会" /></div><div><label htmlFor="communication-author">作者 <span className="muted">选填</span></label><input id="communication-author" maxLength={256} value={author} onChange={(event) => setAuthor(event.target.value)} disabled={pending} placeholder="沟通记录的作者" /></div></div>
          <p className="privacy-caption"><span aria-hidden="true">✓</span>内容仅在本机进行隐私检查。确认脱敏后，才会进入 AI 分析。</p><div className="panel-actions"><p className="field-hint">未确认的检查不会持久保存。</p><button className="button button-primary" disabled={pending || !text.trim()}>{pending ? "正在检查……" : "开始隐私检查"}<span aria-hidden="true">→</span></button></div>
        </form>}
        {state.phase === "PRIVACY_REVIEW" && <PrivacyReviewPanel review={state.review} busy={pending} onBack={() => { setError(null); setState((old) => transitionWorkflow(old, { type: "EDIT_INPUT" })); }} onCommand={(command) => { void perform(async () => { const review = await apiClient.reviewCommand(auditId, command); setState((old) => transitionWorkflow(old, { type: "REVIEWED", review })); }); }} onFinalize={() => { void perform(async () => { const candidate = await apiClient.finalize(auditId); setState((old) => transitionWorkflow(old, { type: "FINALIZED", candidate })); }); }} />}
        {state.phase === "PRIVACY_CONFIRM" && <section className="card panel"><div className="panel-heading"><div><p className="eyebrow">步骤 3 · 最后核对</p><h2>确认脱敏结果</h2><p>确认后，只有脱敏后的内容才会用于 AI 分析。</p></div><Badge tone="amber">尚未确认</Badge></div><p className="muted">预览 {state.candidate.preview.length} 段脱敏内容 · 已处理 {state.review.detections.length} 个识别项</p>{state.candidate.preview.map((record, i) => <article className="preview-record" key={i}><div className="item-meta"><strong>{record.sourceName}</strong>{record.author && <span>作者：{record.author}</span>}</div><pre>{record.content}</pre></article>)}<div className="panel-actions"><button className="button button-secondary" disabled={pending} onClick={() => setState((old) => transitionWorkflow(old, { type: "BACK_TO_REVIEW" }))}>返回隐私检查</button><button className="button button-primary" disabled={pending} onClick={() => { void perform(async () => { await apiClient.confirm(auditId, state.candidate.reviewCandidateId); setState((old) => transitionWorkflow(old, { type: "CONFIRMED" })); }); }}>{pending ? "正在确认……" : "确认脱敏结果"}</button></div></section>}
        {state.phase === "CONFIRMED" && <section className="card panel confirmed-panel"><div className="confirmation-symbol" aria-hidden="true">✓</div><Badge tone="green">隐私检查已确认</Badge><h2>准备好开始 AI 分析</h2><p>脱敏后的沟通内容可用于整理证据、承诺、变更与潜在冲突。</p>{state.lastRunFailed && <div className="notice notice-info">上一次分析未完成，可以重新分析。</div>}<button className="button button-primary" disabled={pending || state.activeRunConflict} onClick={() => { void perform(analyze); }}>{state.activeRunConflict ? "项目正在分析，请稍候" : "开始 AI 分析"}</button>{state.activeRunConflict && <p className="field-hint">稍候使用上方“刷新项目状态”查看结果。</p>}</section>}
        {state.phase === "ANALYZING" && <section className="card panel analyzing-panel" aria-busy="true"><Loading>正在分析项目沟通……</Loading><p>分析期间请保持页面打开。</p><p className="field-hint">正在整理证据、承诺、变更与潜在冲突。</p><button className="button button-primary" disabled>分析进行中</button></section>}
        {(state.phase === "REPORT_PREVIEW" || state.phase === "ACCEPTED") && <ReportPanel report={state.report} mode={state.phase === "ACCEPTED" ? "accepted" : "preview"} busy={pending} onAccept={() => { if (state.phase !== "REPORT_PREVIEW") return; void perform(async () => { const report = await apiClient.accept(auditId, state.report.reportVersionId, state.report.canonicalDigest); setState((old) => transitionWorkflow(old, { type: "REPORT_ACCEPTED", report })); setHistory(await apiClient.history(auditId)); }); }} />}
      </>}
    </div><HistoryPanel items={history} busy={busy} selectedId={selectedId} onOpen={(reportId) => { void perform(async () => { setHistoricalReport(await apiClient.reopen(auditId, reportId)); }); }} /></div>
  </>;
}
