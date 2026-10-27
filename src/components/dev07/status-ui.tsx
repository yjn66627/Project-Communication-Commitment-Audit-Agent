import type { ReactNode } from "react";
import type { UiApiError } from "../../lib/dev07/api-client";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "blue" | "green" | "amber" }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}
export function Loading({ children = "正在加载项目……" }: { children?: ReactNode }) {
  return <div className="loading-message" role="status" aria-live="polite"><span className="spinner" aria-hidden="true" />{children}</div>;
}
export function ErrorNotice({ error }: { error: UiApiError | null }) {
  if (!error) return null;
  return <div className="notice notice-error" role="alert"><strong>操作未完成</strong><p>{error.message}</p>{error.requestId && <small>问题编号：<span className="problem-id">{error.requestId}</span></small>}</div>;
}
export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty-state"><span className="empty-icon" aria-hidden="true">◇</span><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}
export function formatDate(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "未提供";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}
export function EpistemicBadge({ value }: { value: string }) {
  if (value === "FACT") return <Badge tone="blue">有事实依据</Badge>;
  if (value === "INFERENCE") return <Badge tone="amber">推断 · 待确认</Badge>;
  return <Badge tone="amber">信息不足 · 待确认</Badge>;
}
