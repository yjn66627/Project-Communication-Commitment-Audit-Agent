"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { apiClient, toUiError, type Audit, type UiApiError } from "../../lib/dev07/api-client";
import { EmptyState, ErrorNotice, Loading, formatDate } from "./status-ui";

export function AuditList() {
  const [audits, setAudits] = useState<Audit[] | null>(null);
  const [error, setError] = useState<UiApiError | null>(null);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let alive = true;
    void apiClient.listAudits().then((items) => { if (alive) setAudits(items); }, (cause: unknown) => { if (alive) setError(toUiError(cause)); });
    return () => { alive = false; };
  }, [reload]);
  return <section className="project-list-section" aria-labelledby="projects-title">
    <div className="section-heading"><h2 id="projects-title">审计项目</h2>{audits && <span className="muted">共 {audits.length} 个项目</span>}</div>
    <ErrorNotice error={error} />
    {error ? <button className="button button-secondary" onClick={() => { setError(null); setAudits(null); setReload((n) => n + 1); }}>重新加载</button> : audits === null ? <Loading>正在读取本机项目……</Loading> : audits.length === 0 ?
      <div className="card"><EmptyState title="还没有审计项目">从一段项目沟通开始，整理值得跟进的证据与承诺。</EmptyState><div className="empty-action"><Link className="button button-secondary" href="/audits/new">创建第一个项目</Link></div></div> :
      <div className="project-list">{audits.map((audit) => <Link className="project-row" key={audit.auditId} href={`/audits/${encodeURIComponent(audit.auditId)}`}>
        <span className="project-symbol" aria-hidden="true">▤</span><span className="project-description"><strong>{audit.displayName}</strong><span>创建于 {formatDate(audit.createdAt)}</span></span><span className="project-enter">进入项目 <span aria-hidden="true">→</span></span>
      </Link>)}</div>}
  </section>;
}
