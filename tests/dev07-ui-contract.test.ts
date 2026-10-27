import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createApiClient, UiApiError, toUiError, type PasteInput, type ReviewCommand, type SafeReport } from "../src/lib/dev07/api-client.js";
import { ReportPanel } from "../src/components/dev07/report-panel.js";
import { ErrorNotice } from "../src/components/dev07/status-ui.js";

const requestId = "12345678-1234-1234-1234-123456789abc";
const report: SafeReport = { reportVersionId: "rpt_ui_contract", canonicalDigest: "a".repeat(64), versionNumber: 1, completedAt: "2026-10-05T10:00:00.000Z", summary: { items: [{ text: "<script>SYNTHETIC_TEXT</script>", epistemicStatus: "UNKNOWN", conflicted: true }], unresolvedItems: ["确认最终交付日期。"] }, evidence: [{ sourceName: "测试记录", excerpt: "Delivery is due Friday.", timestamp: null, evidenceType: "STATEMENT" }], commitments: [{ classification: "CANDIDATE", actor: null, actionOrDeliverable: "完成交付", deadline: null, condition: null, recipient: null, lifecycleStatus: "UNKNOWN", epistemicStatus: "UNKNOWN" }], changes: [{ changeType: "MODIFY", subject: "交付日期", beforeSummary: null, afterSummary: "交付时间需要重新确认。", timestamp: null, classification: "CANDIDATE", epistemicStatus: "INFERENCE" }], conflicts: [{ claimA: "周五交付", claimB: "周一交付", subject: "交付日期", timeContext: null, versionContext: null, conditionContext: null, reason: "日期表述不同。", alternatives: [{ text: "可能是不同批次。", epistemicStatus: "UNKNOWN" }], missingEvidence: ["批准日期的记录。"] }] };

for (const [status, code, message] of [[413, "PAYLOAD_TOO_LARGE", "内容过长"], [409, "RUN_ALREADY_ACTIVE", "这个项目已经在分析中"], [409, "REQUEST_CONFLICT", "项目状态已变化"], [502, "PROVIDER_REQUEST_FAILED", "AI 服务暂时请求失败"], [503, "PROVIDER_UNAVAILABLE", "AI 服务当前不可用"]] as const) {
  test(`UI-contract safe Chinese error ${status}/${code}; preserves problem ID, never raw message`, async () => {
    const api = createApiClient(async () => Response.json({ error: { code, message: "SYNTHETIC_PRIVATE_RAW_MESSAGE", stack: "SYNTHETIC_STACK", request_id: requestId } }, { status }));
    await assert.rejects(api.listAudits(), (error: unknown) => error instanceof UiApiError && error.message.includes(message) && error.requestId === requestId && !JSON.stringify(error).includes("SYNTHETIC"));
  });
}
test("UI-contract invalid JSON and forged request IDs become safe errors", async () => {
  const api = createApiClient(async () => new Response("SYNTHETIC_PRIVATE_NOT_JSON", { status: 500, headers: { "X-Request-ID": "SYNTHETIC_PRIVATE_PATH" } }));
  await assert.rejects(api.listAudits(), (error: unknown) => error instanceof UiApiError && error.requestId === null && !error.message.includes("SYNTHETIC"));
});
test("UI-contract network rejection never exposes thrown body, stack, endpoint or credential", async () => {
  const api = createApiClient(async () => { throw new Error("SYNTHETIC_PRIVATE_TRANSPORT_ERROR"); });
  await assert.rejects(api.listAudits(), (error: unknown) => error instanceof UiApiError && error.code === "NETWORK_ERROR" && !error.message.includes("SYNTHETIC"));
  assert.equal(toUiError(new Error("SYNTHETIC_PRIVATE_ERROR")).message, "操作未完成，请稍后重试。");
});
test("UI-contract requests are relative HTTP only, same-origin and no-store", async () => {
  const api = createApiClient(async (url, init) => {
    assert.equal(url, "/api/audits"); assert.equal(init.method, "GET"); assert.equal(init.cache, "no-store"); assert.equal(init.credentials, "same-origin"); assert.equal(init.body, undefined);
    return Response.json({ audits: [] });
  });
  assert.deepEqual(await api.listAudits(), []);
});
test("UI-contract extra Authority fields are rejected before any browser request", async () => {
  let calls = 0;
  const api = createApiClient(async () => { calls += 1; return Response.json({}); });
  await assert.rejects(api.createAudit({ displayName: "测试", databasePath: "SYNTHETIC_PRIVATE" } as unknown as { displayName: string }), UiApiError);
  await assert.rejects(api.paste("aud_test", { text: "text", privacyRevisionId: "prv_injected", canonical_json: "injected" } as PasteInput), UiApiError);
  await assert.rejects(api.reviewCommand("aud_test", { type: "ACCEPT_DETECTION", detection_id: "det_test", revision_salt: "injected" } as ReviewCommand), UiApiError);
  assert.throws(() => api.run("aud_test/../other"), UiApiError);
  assert.equal(calls, 0);
});
test("UI-contract byte limit handles multibyte text separately from character count", async () => {
  let calls = 0;
  const api = createApiClient(async () => { calls += 1; return Response.json({}); });
  await assert.rejects(api.paste("aud_test", { text: "中".repeat(90_000) }), (error: unknown) => error instanceof UiApiError && error.code === "PAYLOAD_TOO_LARGE");
  assert.equal(calls, 0);
});
test("UI-contract Run body is empty; Accept body contains only the digest", async () => {
  const calls: { url: string; body: unknown }[] = [];
  const api = createApiClient(async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/runs")) return Response.json({ status: "COMPLETED", reportVersionId: report.reportVersionId, failureCategory: null });
    return Response.json({ outcome: "INSERTED", report: { ...report, acceptedAt: "2026-10-05T11:00:00.000Z" } });
  });
  await api.run("aud_test"); await api.accept("aud_test", report.reportVersionId, report.canonicalDigest);
  assert.deepEqual(calls, [{ url: "/api/audits/aud_test/runs", body: {} }, { url: "/api/audits/aud_test/reports/rpt_ui_contract/accept", body: { expectedCanonicalDigest: report.canonicalDigest } }]);
});
test("UI-contract Finalize and Confirm are separate requests, Confirm body is candidate token only", async () => {
  const calls: unknown[] = [];
  const token = `rcand_${"b".repeat(64)}`;
  const api = createApiClient(async (url, init) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return url.endsWith("finalize") ? Response.json({ reviewCandidateId: token, preview: [] }) : Response.json({ auditId: "aud_test", recordCount: 1, mappingCount: 0, confirmedAt: "2026-10-05T10:00:00.000Z", idempotent: false });
  });
  const candidate = await api.finalize("aud_test"); assert.equal(calls.length, 1);
  await api.confirm("aud_test", candidate.reviewCandidateId);
  assert.deepEqual(calls, [{ url: "/api/audits/aud_test/privacy/review/finalize", body: {} }, { url: "/api/audits/aud_test/privacy/confirm", body: { reviewCandidateId: token } }]);
});
test("UI-contract immutable history reopen is GET-only and strips unexpected internal response fields", async () => {
  const api = createApiClient(async (url, init) => {
    assert.equal(url, "/api/audits/aud_test/reports/accepted/rpt_ui_contract"); assert.equal(init.method, "GET"); assert.equal(init.body, undefined);
    return Response.json({ report: { ...report, acceptedAt: "2026-10-05T11:00:00.000Z", canonical_json: "SYNTHETIC_PRIVATE_CANONICAL", privacyRevisionId: "prv_hidden" } });
  });
  const reopened = await api.reopen("aud_test", report.reportVersionId);
  assert.equal("canonical_json" in reopened, false); assert.equal("privacyRevisionId" in reopened, false);
});
test("UI-contract Preview is clearly unsaved, semantically labeled and escaped; no internal IDs rendered", () => {
  const html = renderToStaticMarkup(createElement(ReportPanel, { report, mode: "preview" }));
  assert.ok(html.includes("尚未确认保存")); assert.ok(html.includes("确认并保存报告")); assert.ok(html.includes("候选承诺")); assert.ok(html.includes("待确认")); assert.ok(html.includes("潜在冲突")); assert.ok(html.includes("事实证据"));
  assert.ok(html.includes("&lt;script&gt;")); assert.equal(html.includes("<script>"), false);
  assert.equal(html.includes(report.reportVersionId), false); assert.equal(html.includes(report.canonicalDigest), false);
});
test("UI-contract Accepted and historical panels never offer Accept action", () => {
  for (const mode of ["accepted", "history"] as const) {
    const html = renderToStaticMarkup(createElement(ReportPanel, { report: { ...report, acceptedAt: "2026-10-05T11:00:00.000Z" }, mode }));
    assert.ok(html.includes("已确认保存")); assert.equal(html.includes("确认并保存报告</button>"), false);
  }
});
test("UI-contract error UI has a readable alert and only a safe problem ID", () => {
  const html = renderToStaticMarkup(createElement(ErrorNotice, { error: new UiApiError(409, "RUN_ALREADY_ACTIVE", requestId) }));
  assert.ok(html.includes('role="alert"')); assert.ok(html.includes("问题编号")); assert.ok(html.includes(requestId)); assert.ok(html.includes("这个项目已经在分析中"));
});
test("UI-contract frontend source has no server imports, persistent browser authority or remote resource dependency", () => {
  const roots = [path.resolve("src/components/dev07"), path.resolve("src/lib/dev07")];
  const files = roots.flatMap((root) => readdirSync(root).map((name) => path.join(root, name)));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.equal(/(?:from|import\s*\()\s*["'][^"']*(?:application\/|db\/|providers\/|server\/|node:|better-sqlite3)/u.test(source), false, file);
    assert.equal(/localStorage|sessionStorage|indexedDB|dangerouslySetInnerHTML|next\/font|https:\/\//u.test(source), false, file);
  }
});
