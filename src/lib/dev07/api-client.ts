import { z } from "zod";

// Browser contracts mirror only the safe HTTP DTOs. No server module is imported.
const AuditSchema = z.object({ auditId: z.string().startsWith("aud_"), displayName: z.string(), createdAt: z.string() });
const HistorySchema = z.object({ reportVersionId: z.string().startsWith("rpt_"), versionNumber: z.number().int().positive(), acceptedAt: z.string() });
const ReviewSchema = z.object({
  stage: z.string(),
  detections: z.array(z.object({ itemId: z.string(), category: z.string(), surface: z.string(), sanitizedPreview: z.string(), decision: z.string(), replacementPolicy: z.string(), urlVisibility: z.string().nullable(), candidateToken: z.string().nullable() })),
  entities: z.array(z.object({ candidateToken: z.string(), category: z.string(), state: z.string(), placeholder: z.string().nullable(), itemTokens: z.array(z.string()) })),
  seedPlaceholders: z.array(z.string()),
  counters: z.object({ mergeCount: z.number(), splitCount: z.number(), falsePositiveCount: z.number() }),
});
const CandidateSchema = z.object({ reviewCandidateId: z.string().regex(/^rcand_[0-9a-f]{64}$/u), preview: z.array(z.object({ sourceType: z.string(), sourceName: z.string(), author: z.string().nullable(), timestamp: z.string().nullable(), content: z.string(), sequence: z.number() })) });
const WorkflowSchema = z.object({ auditId: z.string().startsWith("aud_"), privacyConfirmed: z.boolean(), privacyConfirmedAt: z.string().nullable(), latestSettledReport: z.object({ reportVersionId: z.string().startsWith("rpt_"), versionNumber: z.number().int().positive(), status: z.enum(["COMPLETED", "FAILED"]) }).nullable() });
const ReportSchema = z.object({
  reportVersionId: z.string().startsWith("rpt_"), canonicalDigest: z.string().regex(/^[0-9a-f]{64}$/u), versionNumber: z.number().int().positive(), completedAt: z.string().nullable(),
  accepted: z.literal(false).optional(), acceptedAt: z.string().optional(),
  summary: z.object({ items: z.array(z.object({ text: z.string(), epistemicStatus: z.string(), conflicted: z.boolean() })), unresolvedItems: z.array(z.string()) }),
  evidence: z.array(z.object({ sourceName: z.string(), excerpt: z.string(), timestamp: z.string().nullable(), evidenceType: z.string() })),
  commitments: z.array(z.object({ classification: z.string(), actor: z.string().nullable(), actionOrDeliverable: z.string(), deadline: z.string().nullable(), condition: z.string().nullable(), recipient: z.string().nullable(), lifecycleStatus: z.string(), epistemicStatus: z.string() })),
  changes: z.array(z.object({ changeType: z.string(), subject: z.string(), beforeSummary: z.string().nullable(), afterSummary: z.string(), timestamp: z.string().nullable(), classification: z.string(), epistemicStatus: z.string() })),
  conflicts: z.array(z.object({ claimA: z.string(), claimB: z.string(), subject: z.string(), timeContext: z.string().nullable(), versionContext: z.string().nullable(), conditionContext: z.string().nullable(), reason: z.string(), alternatives: z.array(z.object({ text: z.string(), epistemicStatus: z.string() })), missingEvidence: z.array(z.string()) })),
});
export type Audit = z.infer<typeof AuditSchema>;
export type ReportHistoryItem = z.infer<typeof HistorySchema>;
export type PrivacyReview = z.infer<typeof ReviewSchema>;
export type PrivacyCandidate = z.infer<typeof CandidateSchema>;
export type WorkflowMetadata = z.infer<typeof WorkflowSchema>;
export type SafeReport = z.infer<typeof ReportSchema>;

const PasteSchema = z.object({ text: z.string().min(1).max(256 * 1024).refine((text) => new TextEncoder().encode(text).byteLength <= 256 * 1024), sourceName: z.string().min(1).max(512).optional(), author: z.string().min(1).max(256).optional() }).strict();
const CommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ACCEPT_DETECTION"), detection_id: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("MARK_FALSE_POSITIVE"), detection_id: z.string().min(1).max(128) }).strict(),
  z.object({ type: z.literal("SET_REPLACEMENT_POLICY"), detection_id: z.string().min(1).max(128), policy: z.enum(["PSEUDONYMIZE", "REDACT"]) }).strict(),
  z.object({ type: z.literal("SET_URL_VISIBILITY"), detection_id: z.string().min(1).max(128), visibility: z.enum(["HIDDEN", "RESTORED"]) }).strict(),
]);
export type ReviewCommand = z.infer<typeof CommandSchema>;
export type PasteInput = z.infer<typeof PasteSchema>;

const MESSAGES: Readonly<Record<string, string>> = {
  INVALID_REQUEST: "输入内容或操作无效，请检查后再试。",
  PAYLOAD_TOO_LARGE: "内容过长，请缩短后再试。",
  LOCAL_ACCESS_REQUIRED: "请从本机地址打开工作区后重试。",
  AUDIT_NOT_FOUND: "未找到这个审计项目，请返回项目列表。",
  RESOURCE_NOT_FOUND: "所需内容暂不可用，请刷新项目状态。",
  REQUEST_CONFLICT: "项目状态已变化，请刷新状态后重试。",
  RUN_ALREADY_ACTIVE: "这个项目已经在分析中，请稍候。",
  PROVIDER_REQUEST_FAILED: "AI 服务暂时请求失败，请稍后重试。",
  PROVIDER_UNAVAILABLE: "AI 服务当前不可用，请检查本机配置后重试。",
  RUN_REJECTED: "本次分析未能生成可用报告，请检查内容后重试。",
  NETWORK_ERROR: "无法连接本机服务，请确认服务正在运行后重试。",
  INTERNAL_ERROR: "操作未完成，请稍后重试。",
};
export class UiApiError extends Error {
  readonly code: string;
  readonly requestId: string | null;
  constructor(readonly status: number, code: string, requestId: unknown = null) {
    const safeCode = status === 502 ? "PROVIDER_REQUEST_FAILED" : status === 503 ? "PROVIDER_UNAVAILABLE" : status === 413 ? "PAYLOAD_TOO_LARGE" : Object.hasOwn(MESSAGES, code) ? code : "INTERNAL_ERROR";
    super(MESSAGES[safeCode]);
    this.name = "UiApiError"; this.code = safeCode;
    this.requestId = typeof requestId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(requestId) ? requestId : null;
  }
}
export function toUiError(error: unknown): UiApiError { return error instanceof UiApiError ? error : new UiApiError(0, "INTERNAL_ERROR"); }

type FetchPort = (url: string, init: RequestInit) => Promise<Response>;
function pathId(id: string, prefix: string): string {
  if (!id.startsWith(prefix) || !/^[A-Za-z0-9_-]{1,128}$/u.test(id)) throw new UiApiError(400, "INVALID_REQUEST");
  return encodeURIComponent(id);
}
function body<T>(schema: z.ZodType<T>, value: unknown, errorCode = "INVALID_REQUEST"): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new UiApiError(400, errorCode);
  return result.data;
}

export function createApiClient(fetchPort: FetchPort = (url, init) => fetch(url, init)) {
  async function request<S extends z.ZodTypeAny>(url: string, schema: S, method = "GET", data?: unknown): Promise<z.infer<S>> {
    let response: Response;
    try { response = await fetchPort(url, { method, cache: "no-store", credentials: "same-origin", redirect: "error", headers: data === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) }); }
    catch { throw new UiApiError(0, "NETWORK_ERROR"); }
    const requestId = response.headers.get("X-Request-ID");
    let decoded: unknown;
    try { decoded = await response.json(); }
    catch { throw new UiApiError(response.status, "INTERNAL_ERROR", requestId); }
    if (!response.ok) {
      const envelope = z.object({ error: z.object({ code: z.string(), request_id: z.string().optional() }) }).safeParse(decoded);
      throw new UiApiError(response.status, envelope.success ? envelope.data.error.code : "INTERNAL_ERROR", requestId ?? (envelope.success ? envelope.data.error.request_id : null));
    }
    const result = schema.safeParse(decoded);
    if (!result.success) throw new UiApiError(response.status, "INTERNAL_ERROR", requestId);
    return result.data;
  }
  const auditPath = (id: string) => `/api/audits/${pathId(id, "aud_")}`;
  return {
    async listAudits() { return (await request("/api/audits", z.object({ audits: z.array(AuditSchema) }))).audits; },
    async createAudit(input: { displayName: string }) { return (await request("/api/audits", z.object({ audit: AuditSchema }), "POST", body(z.object({ displayName: z.string().trim().min(1).max(256) }).strict(), input))).audit; },
    async getAudit(id: string) { return (await request(auditPath(id), z.object({ audit: AuditSchema }))).audit; },
    getWorkflow(id: string) { return request(`${auditPath(id)}/workflow`, WorkflowSchema); },
    async getReview(id: string) { return (await request(`${auditPath(id)}/privacy/review`, z.object({ review: ReviewSchema }))).review; },
    async paste(id: string, input: PasteInput) {
      const size = new TextEncoder().encode(input.text).byteLength;
      if (size > 256 * 1024 || input.text.length > 256 * 1024) throw new UiApiError(413, "PAYLOAD_TOO_LARGE");
      return (await request(`${auditPath(id)}/input`, z.object({ review: ReviewSchema }), "POST", body(PasteSchema, input))).review;
    },
    async reviewCommand(id: string, input: ReviewCommand) { return (await request(`${auditPath(id)}/privacy/review`, z.object({ review: ReviewSchema }), "PATCH", body(CommandSchema, input))).review; },
    finalize(id: string) { return request(`${auditPath(id)}/privacy/review/finalize`, CandidateSchema, "POST", {}); },
    confirm(id: string, reviewCandidateId: string) { return request(`${auditPath(id)}/privacy/confirm`, z.object({ auditId: z.string(), recordCount: z.number(), mappingCount: z.number(), confirmedAt: z.string(), idempotent: z.boolean() }), "POST", body(z.object({ reviewCandidateId: z.string().regex(/^rcand_[0-9a-f]{64}$/u) }).strict(), { reviewCandidateId })); },
    run(id: string) { return request(`${auditPath(id)}/runs`, z.object({ status: z.literal("COMPLETED"), reportVersionId: z.string().startsWith("rpt_"), failureCategory: z.null() }), "POST", {}); },
    async preview(id: string) { return (await request(`${auditPath(id)}/reports/latest/preview`, z.object({ preview: ReportSchema }))).preview; },
    async accept(id: string, reportId: string, expectedCanonicalDigest: string) { const report = (await request(`${auditPath(id)}/reports/${pathId(reportId, "rpt_")}/accept`, z.object({ outcome: z.enum(["INSERTED", "IDEMPOTENT_EXISTING"]), report: ReportSchema }), "POST", body(z.object({ expectedCanonicalDigest: z.string().regex(/^[0-9a-f]{64}$/u) }).strict(), { expectedCanonicalDigest }))).report; if (report.reportVersionId !== reportId || !report.acceptedAt) throw new UiApiError(409, "REQUEST_CONFLICT"); return report; },
    async history(id: string) { return (await request(`${auditPath(id)}/reports/accepted`, z.object({ reports: z.array(HistorySchema) }))).reports; },
    async reopen(id: string, reportId: string) { const report = (await request(`${auditPath(id)}/reports/accepted/${pathId(reportId, "rpt_")}`, z.object({ report: ReportSchema }))).report; if (report.reportVersionId !== reportId || !report.acceptedAt) throw new UiApiError(409, "REQUEST_CONFLICT"); return report; },
  };
}
export type ApiClient = ReturnType<typeof createApiClient>;
export const apiClient = createApiClient();
