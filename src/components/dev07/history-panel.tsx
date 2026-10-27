import type { ReportHistoryItem } from "../../lib/dev07/api-client";
import { formatDate } from "./status-ui";

export function HistoryPanel({ items, busy, selectedId, onOpen }: { items: ReportHistoryItem[]; busy: boolean; selectedId?: string; onOpen(id: string): void }) {
  return <aside className="card history-panel" aria-labelledby="history-title"><div className="section-heading"><h2 id="history-title" tabIndex={-1}>历史报告</h2><span className="muted">{items.length}</span></div><p className="field-hint">仅显示已确认保存的版本。</p>{items.length ? <ol className="history-list">{[...items].reverse().map((item) => <li key={item.reportVersionId}><button className={`history-button ${selectedId === item.reportVersionId ? "is-selected" : ""}`} disabled={busy} onClick={() => onOpen(item.reportVersionId)} aria-pressed={selectedId === item.reportVersionId}><strong>版本 {item.versionNumber}<span aria-hidden="true">↗</span></strong><span>接受于 {formatDate(item.acceptedAt)}</span></button></li>)}</ol> : <div className="history-empty"><span aria-hidden="true">▤</span><p>还没有已保存的报告</p><small>完成分析并确认报告后，<br />版本将显示在这里。</small></div>}</aside>;
}
