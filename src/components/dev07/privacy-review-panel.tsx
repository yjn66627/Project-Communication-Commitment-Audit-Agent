"use client";
import type { PrivacyReview, ReviewCommand } from "../../lib/dev07/api-client";
import { Badge, EmptyState } from "./status-ui";

const CATEGORIES: Readonly<Record<string, string>> = { PERSON: "人名", ORG: "组织名称", ORGANIZATION: "组织名称", PHONE: "电话号码", EMAIL: "邮箱地址", URL: "网址", ADDRESS: "地址", ID_CARD: "身份信息", SECRET: "凭据与密钥" };
const SURFACES: Readonly<Record<string, string>> = { CONTENT: "沟通正文", AUTHOR: "作者字段", SOURCE_NAME: "来源名称" };
const DECISIONS: Readonly<Record<string, string>> = { PENDING_REVIEW: "待检查", ACCEPTED: "已选择脱敏", FALSE_POSITIVE: "按非敏感内容保留", LOCKED_REDACTION: "强制隐藏" };

export function PrivacyReviewPanel({ review, busy, onCommand, onBack, onFinalize }: { review: PrivacyReview; busy: boolean; onCommand(command: ReviewCommand): void; onBack(): void; onFinalize(): void }) {
  const pending = review.detections.filter((item) => ["PENDING_REVIEW", "UNREVIEWED", "REVIEW_REQUIRED"].includes(item.decision)).length;
  return <section className="card panel" aria-labelledby="privacy-title" aria-busy={busy}>
    <div className="panel-heading"><div><p className="eyebrow">步骤 2 · 本地审查</p><h2 id="privacy-title">隐私检查</h2><p>以下内容仍只保留在本机。请确认哪些信息需要脱敏。</p></div><Badge tone={pending ? "amber" : "green"}>{pending ? `${pending} 项待检查` : "识别项已处理"}</Badge></div>
    <div className="notice notice-info">识别项的原始值已隐藏。如需核对原文，请重新输入内容，并再次进行隐私检查。完成检查后，还需单独确认脱敏结果。</div>
    {review.detections.length === 0 ? <EmptyState title="没有发现需要逐项处理的信息">仍请在下一步检查脱敏预览，再确认是否用于分析。</EmptyState> : <div className="review-items">{review.detections.map((item, index) => {
      const locked = item.category === "SECRET" || item.decision === "LOCKED_REDACTION";
      const entity = review.entities.find((value) => value.candidateToken === item.candidateToken);
      return <article className="review-item" key={item.itemId}><div className="review-item-heading"><strong>{index + 1}. {CATEGORIES[item.category] ?? "敏感信息"}</strong><Badge tone={item.decision === "PENDING_REVIEW" ? "amber" : "neutral"}>{DECISIONS[item.decision] ?? "待检查"}</Badge></div>
        <p className="field-hint">位置：{SURFACES[item.surface] ?? "沟通内容"}</p><div className="safe-placeholder">{entity?.placeholder ?? (item.sanitizedPreview === "[Sensitive value withheld during review.]" ? "[敏感内容已隐藏]" : item.sanitizedPreview)}</div>
        {locked ? <p className="field-hint">此项会被隐藏，不会展示原始凭据。</p> : <div className="review-controls">
          <div className="button-group"><button className="button button-small button-secondary" type="button" disabled={busy || item.decision === "ACCEPTED" || !item.candidateToken} onClick={() => onCommand({ type: "ACCEPT_DETECTION", detection_id: item.itemId })}>脱敏</button><button className="button button-small button-secondary" type="button" disabled={busy || item.decision === "FALSE_POSITIVE"} onClick={() => onCommand({ type: "MARK_FALSE_POSITIVE", detection_id: item.itemId })}>不是敏感信息，保留</button></div>
          <label className="compact-label">替换方式<select value={item.replacementPolicy} disabled={busy || item.decision === "FALSE_POSITIVE"} onChange={(event) => onCommand({ type: "SET_REPLACEMENT_POLICY", detection_id: item.itemId, policy: event.target.value as "PSEUDONYMIZE" | "REDACT" })}>{!["PSEUDONYMIZE", "REDACT"].includes(item.replacementPolicy) && <option value={item.replacementPolicy} disabled>请选择替换方式</option>}<option value="PSEUDONYMIZE">使用占位符</option><option value="REDACT">隐藏内容</option></select></label>
          {item.category === "URL" && <label className="compact-label">网址显示<select value={item.urlVisibility ?? "HIDDEN"} disabled={busy || item.decision === "FALSE_POSITIVE"} onChange={(event) => onCommand({ type: "SET_URL_VISIBILITY", detection_id: item.itemId, visibility: event.target.value as "HIDDEN" | "RESTORED" })}><option value="HIDDEN">隐藏网址</option><option value="RESTORED">保留网址</option></select></label>}
        </div>}
      </article>;
    })}</div>}
    <div className="panel-actions"><button className="button button-secondary" disabled={busy} onClick={onBack}>重新输入内容</button><div>{pending > 0 && <p className="field-hint">请先处理所有待检查项。</p>}<button className="button button-primary" disabled={busy || pending > 0} onClick={onFinalize}>{busy ? "正在处理……" : "完成隐私检查"}</button></div></div>
  </section>;
}
