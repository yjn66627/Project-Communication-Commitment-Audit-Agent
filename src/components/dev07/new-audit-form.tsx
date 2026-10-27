"use client";
import { useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiClient, toUiError, type UiApiError } from "../../lib/dev07/api-client";
import { ErrorNotice } from "./status-ui";

export function NewAuditForm() {
  const router = useRouter();
  const [displayName, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<UiApiError | null>(null);
  const submitting = useRef(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (submitting.current) return;
    submitting.current = true; setPending(true); setError(null);
    try { const audit = await apiClient.createAudit({ displayName }); router.push(`/audits/${encodeURIComponent(audit.auditId)}`); }
    catch (cause) { setError(toUiError(cause)); submitting.current = false; setPending(false); }
  }
  return <form className="card form-card" onSubmit={(event) => { void submit(event); }} aria-busy={pending}>
    <div className="form-card-heading"><h2>为这次审计命名</h2><p>用项目或协作事项的名称，方便日后查找报告。</p></div>
    <ErrorNotice error={error} />
    <label htmlFor="audit-name">项目名称 <span className="required-label">必填</span></label>
    <input id="audit-name" value={displayName} onChange={(event) => setName(event.target.value)} maxLength={256} required autoFocus disabled={pending} placeholder="例如：产品上线协作项目" aria-describedby="audit-name-help" />
    <p id="audit-name-help" className="field-hint">可以稍后在项目内导入沟通内容。</p>
    <div className="form-actions"><Link className="button button-secondary" href="/">取消</Link><button className="button button-primary" disabled={pending || !displayName.trim()}>{pending ? "正在创建……" : "创建项目"}<span aria-hidden="true">→</span></button></div>
  </form>;
}
