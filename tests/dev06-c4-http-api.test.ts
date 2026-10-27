import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, test } from "node:test";
import { ApplicationError } from "../src/application/errors.js";
import { PrivacyReviewService } from "../src/application/privacy/privacy-review-service.js";
import { ApplicationStore } from "../src/application/storage/application-store.js";
import type { ReviewCommand } from "../src/privacy/review/types.js";
import type { SafeAcceptedReport } from "../src/application/reports/canonical-report-read-adapter.js";
import { APPLICATION_DIRECTORY_NAME } from "../src/application/storage/data-directory.js";
import { getSharedApplicationStore, closeSharedApplicationStore, resetSharedApplicationStoreForTests } from "../src/server/application-store.js";
import { mapSafeHttpError, SafeRunHttpError } from "../src/server/http/safe-http-error-mapper.js";
import { MAX_HTTP_JSON_BODY, readBoundedJson } from "../src/server/http/bounded-json.js";
import { EmptyRequestSchema } from "../src/server/http/http-dtos.js";
import { GET as listAudits, POST as createAudit } from "../src/app/api/audits/route.js";
import { GET as openAudit } from "../src/app/api/audits/[auditId]/route.js";
import { POST as pasteInput } from "../src/app/api/audits/[auditId]/input/route.js";
import { GET as getPrivacyReview, PATCH as patchPrivacyReview } from "../src/app/api/audits/[auditId]/privacy/review/route.js";
import { POST as finalizePrivacyReview } from "../src/app/api/audits/[auditId]/privacy/review/finalize/route.js";
import { POST as confirmPrivacy } from "../src/app/api/audits/[auditId]/privacy/confirm/route.js";
import { POST as runAudit } from "../src/app/api/audits/[auditId]/runs/route.js";
import { GET as previewLatest } from "../src/app/api/audits/[auditId]/reports/latest/preview/route.js";
import { POST as acceptReport } from "../src/app/api/audits/[auditId]/reports/[reportVersionId]/accept/route.js";
import { GET as acceptedHistory } from "../src/app/api/audits/[auditId]/reports/accepted/route.js";
import { GET as reopenAccepted } from "../src/app/api/audits/[auditId]/reports/accepted/[reportVersionId]/route.js";

const auditId = "aud_c4_fixture";
const reportVersionId = "rpt_c4_fixture";
const digest = "a".repeat(64);
let activeClose: Promise<void> | undefined;

function acceptedFixture(): SafeAcceptedReport {
  return {
    report_version_id: reportVersionId,
    audit_id: auditId,
    privacy_revision_id: "prv_private_fixture",
    canonical_format_version: 1,
    canonical_digest: digest,
    canonical_json: "CANONICAL_STORAGE_SENTINEL",
    accepted_at: "2026-10-03T10:00:00.000Z",
    canonical_snapshot: {
      canonical_format_version: 1,
      binding: { audit_id: auditId, report_version_id: reportVersionId, privacy_revision_id: "prv_private_fixture" },
      report: { report_version: { version_number: 1, completed_at: "2026-10-03T09:00:00.000Z" }, audit_summary: { items: [{ text: "Synthetic safe summary", epistemic_status: "FACT", conflicted: false }], unresolved_items: [] } },
      evidence: [], commitments: [], changes: [], conflicts: [],
    },
  } as unknown as SafeAcceptedReport;
}

function makeStore(overrides: Record<string, unknown> = {}): ApplicationStore {
  const calls = { create: 0, run: 0, preview: 0, accept: 0, confirm: 0, reviewApply: 0, close: 0 };
  const reviews = new PrivacyReviewService(() => {}, () => {}, () => []);
  const reviewApi = {
    beginPaste: reviews.beginPaste.bind(reviews),
    getSessionLocal: reviews.getSessionLocal.bind(reviews),
    finalize: reviews.finalize.bind(reviews),
    apply(audit: string, command: ReviewCommand) { calls.reviewApply += 1; return reviews.apply(audit, command); },
    get memoryUsage() { return reviews.memoryUsage; },
  };
  const accepted = acceptedFixture();
  const store = {
    calls,
    audits: {
      create(input: { displayName: string }) { calls.create += 1; return { auditId, displayName: input.displayName, createdAt: "2026-10-03T10:00:00.000Z" }; },
      list() { return [{ auditId, displayName: "Synthetic audit", createdAt: "2026-10-03T10:00:00.000Z" }]; },
      open(id: string) { if (id !== auditId) throw new ApplicationError("AUDIT_NOT_FOUND", "safe"); return { auditId, displayName: "Synthetic audit", createdAt: "2026-10-03T10:00:00.000Z" }; },
    },
    reviews: reviewApi,
    confirmation: { async confirm(input: { auditId: string }) { calls.confirm += 1; return { audit_id: input.auditId, privacy_revision_id: "prv_private_fixture", record_count: 1, mapping_count: 1, confirmed_at: "2026-10-03T10:00:00.000Z", idempotent: false }; } },
    runs: { async run(input: { auditId: string }) { calls.run += 1; return { status: "COMPLETED", context: { auditId: input.auditId, reportVersionId, privacyRevisionId: "prv_private_fixture" }, failureCategory: null }; } },
    reports: {
      previewLatest() { calls.preview += 1; return { canonical_snapshot: accepted.canonical_snapshot, canonical_json: "CANONICAL_STORAGE_SENTINEL", canonical_digest: digest }; },
      accept(_audit: string, _report: string, _expected: string) { calls.accept += 1; return { outcome: "INSERTED", acceptance: accepted }; },
      getAccepted() { return accepted; },
      listAccepted() { return [{ reportVersionId, versionNumber: 1, acceptedAt: accepted.accepted_at }]; },
      getLatestAccepted() { return accepted; },
    },
    async close() { calls.close += 1; await activeClose; },
    ...overrides,
  };
  return store as unknown as ApplicationStore;
}

function request(path: string, method = "GET", body?: string, extraHeaders: Record<string, string> = {}): Request {
  const headers = new Headers({ host: "127.0.0.1:3210", ...extraHeaders });
  if (["POST", "PATCH", "PUT", "DELETE"].includes(method)) {
    headers.set("content-type", "application/json");
    headers.set("origin", "http://127.0.0.1:3210");
  }
  return new Request(`http://127.0.0.1:3210${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

function context<T extends object>(params: T) { return { params: Promise.resolve(params) }; }

async function withStore<T>(operation: (store: ApplicationStore & { calls: Record<string, number> }) => Promise<T>, store = makeStore()): Promise<T> {
  resetSharedApplicationStoreForTests(async () => store);
  try { return await operation(store as ApplicationStore & { calls: Record<string, number> }); }
  finally { activeClose = undefined; await closeSharedApplicationStore(); }
}

afterEach(async () => {
  activeClose = undefined;
  await closeSharedApplicationStore();
});

test("C4-01 Audit create/list/open return explicit safe DTOs with server request IDs and no-store", async () => withStore(async (store) => {
  const created = await createAudit(request("/api/audits", "POST", JSON.stringify({ displayName: " Synthetic audit " }), { "x-request-id": "caller-controlled" }));
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  assert.notEqual(created.headers.get("x-request-id"), "caller-controlled");
  assert.deepEqual(await created.json(), { audit: { auditId, displayName: "Synthetic audit", createdAt: "2026-10-03T10:00:00.000Z" } });
  assert.deepEqual(await (await listAudits(request("/api/audits"))).json(), { audits: [{ auditId, displayName: "Synthetic audit", createdAt: "2026-10-03T10:00:00.000Z" }] });
  assert.deepEqual(await (await openAudit(request(`/api/audits/${auditId}`), context({ auditId }))).json(), { audit: { auditId, displayName: "Synthetic audit", createdAt: "2026-10-03T10:00:00.000Z" } });
  assert.equal(store.calls.create, 1);
}));

test("C4-21 request Authority injection and malformed DTOs are rejected before Application calls", async () => withStore(async (store) => {
  const response = await createAudit(request("/api/audits", "POST", JSON.stringify({ displayName: "ok", provider: "caller", apiKey: "fixture" })));
  assert.equal(response.status, 400);
  const body = await response.json() as { error: { code: string; message: string; request_id: string } };
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "request_id"]);
  assert.equal(body.error.code, "INVALID_REQUEST");
  assert.equal(body.error.message, "Invalid request.");
  assert.ok(body.error.request_id);
  assert.equal(JSON.stringify(body).includes("fixture"), false);
  assert.equal(store.calls.create, 0);
}));

test("C4-02 Paste uses the 1 MiB envelope cap, keeps the C1 256 KiB text limit, and never echoes raw text", async () => withStore(async (store) => {
  const raw = "synthetic.fixture+1@example.com";
  const response = await pasteInput(request(`/api/audits/${auditId}/input`, "POST", JSON.stringify({ text: `Contact ${raw}` })), context({ auditId }));
  assert.equal(response.status, 201);
  const body = await response.text();
  assert.equal(body.includes(raw), false);
  assert.equal(body.includes("raw_value"), false);
  assert.equal(body.includes("normalized_key"), false);
  assert.equal(body.includes("Sensitive value withheld during review."), true);
  assert.equal(store.reviews.memoryUsage.sessions, 1);
  const oversizedText = "x".repeat(256 * 1024 + 1);
  const rejected = await pasteInput(request(`/api/audits/${auditId}/input`, "POST", JSON.stringify({ text: oversizedText })), context({ auditId }));
  assert.equal(rejected.status, 400);
  assert.equal((await rejected.text()).includes(oversizedText), false);
}));

test("C4-03 privacy review GET/PATCH only return safe decisions and sanitized placeholders", async () => withStore(async (store) => {
  const raw = "synthetic.review@example.com";
  const created = await pasteInput(request(`/api/audits/${auditId}/input`, "POST", JSON.stringify({ text: raw })), context({ auditId }));
  assert.equal(created.status, 201);
  const read = await getPrivacyReview(request(`/api/audits/${auditId}/privacy/review`), context({ auditId }));
  const body = await read.text();
  assert.equal(body.includes(raw), false);
  assert.equal(body.includes("normalized_key"), false);
  assert.equal(body.includes("raw_value"), false);
  const session = store.reviews.getSessionLocal(auditId);
  const detectionId = Object.keys(session.detections)[0]!;
  const changed = await patchPrivacyReview(request(`/api/audits/${auditId}/privacy/review`, "PATCH", JSON.stringify({ type: "MARK_FALSE_POSITIVE", detection_id: detectionId })), context({ auditId }));
  assert.equal(changed.status, 200);
  assert.equal(store.calls.reviewApply, 1);
  const invalidFinalize = await patchPrivacyReview(request(`/api/audits/${auditId}/privacy/review`, "PATCH", JSON.stringify({ type: "FINALIZE_REVIEW_CANDIDATE" })), context({ auditId }));
  assert.equal(invalidFinalize.status, 400);
}));

test("privacy finalize returns safe sanitized record metadata and confirm hides revision authority", async () => withStore(async (store) => {
  store.reviews.beginPaste(auditId, { text: "synthetic.person@example.com" });
  const session = store.reviews.getSessionLocal(auditId);
  for (const detectionId of Object.keys(session.detections)) store.reviews.apply(auditId, { type: "ACCEPT_DETECTION", detection_id: detectionId });
  const finalized = await finalizePrivacyReview(request(`/api/audits/${auditId}/privacy/review/finalize`, "POST", "{}"), context({ auditId }));
  assert.equal(finalized.status, 200);
  const finalizedText = await finalized.text();
  assert.equal(finalizedText.includes("synthetic.person@example.com"), false);
  const candidateId = JSON.parse(finalizedText).reviewCandidateId as string;
  const confirmed = await confirmPrivacy(request(`/api/audits/${auditId}/privacy/confirm`, "POST", JSON.stringify({ reviewCandidateId: candidateId })), context({ auditId }));
  assert.equal(confirmed.status, 200);
  const confirmedBody = await confirmed.text();
  assert.equal(confirmedBody.includes("privacy_revision_id"), false);
  assert.equal(confirmedBody.includes("prv_private_fixture"), false);
  assert.equal(store.calls.confirm, 1);
}));

test("C4-05/07 Run endpoint delegates only to C3 and returns a narrow DTO", async () => withStore(async (store) => {
  const response = await runAudit(request(`/api/audits/${auditId}/runs`, "POST", "{}"), context({ auditId }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "COMPLETED", reportVersionId, failureCategory: null });
  assert.equal(store.calls.run, 1);
}));

test("C4-06 same-Audit concurrent Run maps to 409 without a second C3 call", async () => {
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const enteredWait = new Promise<void>((resolve) => { entered = resolve; });
  let inFlight = false;
  let c3Calls = 0;
  const store = makeStore({ runs: { async run(input: { auditId: string }) {
    if (inFlight) throw new ApplicationError("RUN_ALREADY_ACTIVE", "safe");
    c3Calls += 1; inFlight = true; entered(); await wait; inFlight = false;
    return { status: "COMPLETED", context: { auditId: input.auditId, reportVersionId, privacyRevisionId: "prv_hidden" }, failureCategory: null };
  } } });
  await withStore(async (current) => {
    const first = runAudit(request(`/api/audits/${auditId}/runs`, "POST", "{}"), context({ auditId }));
    await enteredWait;
    const second = await runAudit(request(`/api/audits/${auditId}/runs`, "POST", "{}"), context({ auditId }));
    assert.equal(second.status, 409);
    const conflict = await second.json();
    assert.equal(conflict.error.code, "RUN_ALREADY_ACTIVE");
    assert.equal(conflict.error.message, "Analysis is already running.");
    assert.deepEqual(Object.keys(conflict.error).sort(), ["code", "message", "request_id"]);
    assert.equal(conflict.error.request_id, second.headers.get("X-Request-ID"));
    assert.equal(/stack|provider|secret|"safe"/iu.test(JSON.stringify(conflict)), false);
    release();
    assert.equal((await first).status, 200);
    assert.equal(current.calls.run, 0);
    assert.equal(c3Calls, 1);
  }, store);
});

test("C4-14 Run failure categories map to fixed 503/502/409/500 responses", () => {
  assert.deepEqual(mapSafeHttpError(new SafeRunHttpError("CONFIG_MISSING")), { status: 503, code: "PROVIDER_UNAVAILABLE", message: "AI provider is unavailable." });
  assert.deepEqual(mapSafeHttpError(new SafeRunHttpError("PROVIDER_STAGE_FAILURE")), { status: 502, code: "PROVIDER_REQUEST_FAILED", message: "AI provider request failed." });
  assert.equal(mapSafeHttpError(new SafeRunHttpError("STALE_PRIVACY")).status, 409);
  assert.equal(mapSafeHttpError(new SafeRunHttpError("PERSISTENCE_FAILURE")).status, 500);
});

test("C4-08 latest preview never auto-accepts and excludes canonical storage JSON", async () => withStore(async (store) => {
  const response = await previewLatest(request(`/api/audits/${auditId}/reports/latest/preview`), context({ auditId }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("CANONICAL_STORAGE_SENTINEL"), false);
  assert.equal(text.includes("privacy_revision_id"), false);
  assert.equal(store.calls.preview, 1);
  assert.equal(store.calls.accept, 0);
}));

test("C4-09 explicit Accept requires only digest and response omits canonical JSON and revision IDs", async () => withStore(async (store) => {
  const injected = await acceptReport(request(`/api/audits/${auditId}/reports/${reportVersionId}/accept`, "POST", JSON.stringify({ expectedCanonicalDigest: digest, canonical_json: "caller" })), context({ auditId, reportVersionId }));
  assert.equal(injected.status, 400);
  assert.equal(store.calls.accept, 0);
  const response = await acceptReport(request(`/api/audits/${auditId}/reports/${reportVersionId}/accept`, "POST", JSON.stringify({ expectedCanonicalDigest: digest })), context({ auditId, reportVersionId }));
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("CANONICAL_STORAGE_SENTINEL"), false);
  assert.equal(text.includes("privacy_revision_id"), false);
  assert.equal(store.calls.accept, 1);
}));

test("C4-10/C4-25 accepted history is metadata-only and reopen calls safe-acceptance capability", async () => withStore(async (store) => {
  const list = await acceptedHistory(request(`/api/audits/${auditId}/reports/accepted`), context({ auditId }));
  assert.deepEqual(await list.json(), { reports: [{ reportVersionId, versionNumber: 1, acceptedAt: "2026-10-03T10:00:00.000Z" }] });
  const reopened = await reopenAccepted(request(`/api/audits/${auditId}/reports/accepted/${reportVersionId}`), context({ auditId, reportVersionId }));
  assert.equal(reopened.status, 200);
  const text = await reopened.text();
  assert.equal(text.includes("CANONICAL_STORAGE_SENTINEL"), false);
  assert.equal(text.includes("privacy_revision_id"), false);
  assert.equal(text.includes("Synthetic safe summary"), true);
  assert.deepEqual(store.reports.listAccepted(auditId), [{ reportVersionId, versionNumber: 1, acceptedAt: "2026-10-03T10:00:00.000Z" }]);
}));

test("C4-26 shared Store bootstraps once for concurrent and later route requests", async () => {
  let bootstrapCount = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = makeStore();
  resetSharedApplicationStoreForTests(async () => { bootstrapCount += 1; await gate; return store; });
  try {
    const one = listAudits(request("/api/audits"));
    const two = listAudits(request("/api/audits"));
    await Promise.resolve();
    assert.equal(bootstrapCount, 1);
    release();
    assert.equal((await one).status, 200);
    assert.equal((await two).status, 200);
    assert.equal((await listAudits(request("/api/audits"))).status, 200);
    assert.equal(bootstrapCount, 1);
  } finally { await closeSharedApplicationStore(); }
});

test("failed shared Store bootstrap is retried and its original error is never returned", async () => {
  let count = 0;
  const store = makeStore();
  resetSharedApplicationStoreForTests(async () => { count += 1; if (count === 1) throw new Error("synthetic private path"); return store; });
  try {
    const failed = await listAudits(request("/api/audits"));
    assert.equal(failed.status, 500);
    assert.equal((await failed.text()).includes("synthetic private path"), false);
    assert.equal((await listAudits(request("/api/audits"))).status, 200);
    assert.equal(count, 2);
  } finally { await closeSharedApplicationStore(); }
});

test("closeSharedApplicationStore blocks new Stores and awaits Store.close drain idempotently", async () => {
  let release!: () => void;
  let started!: () => void;
  const drain = new Promise<void>((resolve) => { release = resolve; });
  const closeStarted = new Promise<void>((resolve) => { started = resolve; });
  let closeCount = 0;
  let drained = false;
  const store = makeStore({ async close() { closeCount += 1; started(); await drain; drained = true; } });
  resetSharedApplicationStoreForTests(async () => store);
  await getSharedApplicationStore();
  const firstClose = closeSharedApplicationStore();
  const secondClose = closeSharedApplicationStore();
  await closeStarted;
  assert.throws(() => getSharedApplicationStore(), ApplicationError);
  assert.equal(drained, false);
  release();
  await Promise.all([firstClose, secondClose]);
  assert.equal(drained, true);
  assert.equal(closeCount, 1);
});

test("R2 production Store lazily composes the real Provider adapter through the Run Route", async () => {
  const providerEnvironmentKeys = ["AUDIT_PROVIDER_NAME", "AUDIT_PROVIDER_BASE_URL", "AUDIT_PROVIDER_MODEL", "AUDIT_PROVIDER_API_KEY"] as const;
  const environmentKeys = [...providerEnvironmentKeys, "LOCALAPPDATA"] as const;
  const previousEnvironment = new Map<string, string | undefined>(
    environmentKeys.map((key) => [key, process.env[key]] as [string, string | undefined]),
  );
  const temporaryLocalAppData = mkdtempSync(path.join(tmpdir(), "dev06-c4-r2-provider-composition-"));
  const syntheticApiKey = "synthetic-" + randomUUID();
  const originalFetch = globalThis.fetch;
  let bootstrapFetchCalls = 0;
  let fakeTransportFetchCalls = 0;
  let fakeTransportUrl = "";
  let fakeTransportAuthorizationMatches = false;

  try {
    for (const key of providerEnvironmentKeys) delete process.env[key];
    process.env.LOCALAPPDATA = temporaryLocalAppData;
    globalThis.fetch = (async () => {
      bootstrapFetchCalls += 1;
      throw new Error("Unexpected fetch before the actual Provider stage.");
    }) as typeof fetch;
    resetSharedApplicationStoreForTests();

    const store = await getSharedApplicationStore();
    assert.ok(store instanceof ApplicationStore);
    assert.equal(providerEnvironmentKeys.every((key) => process.env[key] === undefined), true);
    assert.equal(bootstrapFetchCalls, 0, "Store bootstrap must not attempt Provider transport.");

    const audit = store.audits.create({ displayName: "R2 production composition fixture" });
    store.reviews.beginPaste(audit.auditId, { text: "Contact synthetic.person@example.com about the delivery schedule." });
    const review = store.reviews.getSessionLocal(audit.auditId);
    for (const detectionId of Object.keys(review.detections)) {
      store.reviews.apply(audit.auditId, { type: "ACCEPT_DETECTION", detection_id: detectionId });
    }
    const candidate = store.reviews.finalize(audit.auditId);
    await store.confirmation.confirm({ auditId: audit.auditId, reviewCandidateId: candidate.reviewCandidateId });
    assert.equal(bootstrapFetchCalls, 0, "Audit and privacy setup must not require Provider configuration.");

    process.env.AUDIT_PROVIDER_NAME = "synthetic-test-provider";
    process.env.AUDIT_PROVIDER_BASE_URL = "https://provider-fixture.invalid/v1";
    process.env.AUDIT_PROVIDER_MODEL = "synthetic-test-model";
    process.env.AUDIT_PROVIDER_API_KEY = syntheticApiKey;
    globalThis.fetch = (async (input, init) => {
      fakeTransportFetchCalls += 1;
      fakeTransportUrl = String(input);
      fakeTransportAuthorizationMatches = new Headers(init?.headers).get("authorization") === "Bearer " + syntheticApiKey;
      return new Response("synthetic upstream failure", { status: 500 });
    }) as typeof fetch;

    const response = await runAudit(
      request("/api/audits/" + encodeURIComponent(audit.auditId) + "/runs", "POST", "{}"),
      context({ auditId: audit.auditId }),
    );
    const responseText = await response.text();
    const payload = JSON.parse(responseText) as { error?: { code?: string } };

    assert.equal(response.status, 502);
    assert.equal(payload.error?.code, "PROVIDER_REQUEST_FAILED");
    assert.equal(responseText.includes("CONFIG_MISSING"), false);
    assert.equal(responseText.includes(syntheticApiKey), false);
    assert.ok(fakeTransportFetchCalls >= 1, "The real Provider adapter must reach the fake transport.");
    assert.equal(fakeTransportUrl, "https://provider-fixture.invalid/v1/chat/completions");
    assert.equal(fakeTransportAuthorizationMatches, true);
    assert.equal(bootstrapFetchCalls, 0);
    await closeSharedApplicationStore();

    const privateDataDirectory = path.join(temporaryLocalAppData, APPLICATION_DIRECTORY_NAME);
    const databasePath = path.join(privateDataDirectory, "audit.sqlite");
    assert.equal(existsSync(databasePath), true);
    const privateFileBytes = readdirSync(privateDataDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(path.join(privateDataDirectory, entry.name)));
    assert.equal(
      privateFileBytes.some((bytes) => bytes.includes(Buffer.from(syntheticApiKey))),
      false,
      "The synthetic test credential must not persist in isolated Store files.",
    );
  } finally {
    try {
      await closeSharedApplicationStore();
    } finally {
      globalThis.fetch = originalFetch;
      for (const key of environmentKeys) {
        const value = previousEnvironment.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(temporaryLocalAppData, { recursive: true, force: true });
    }
  }
});

test("C4 error mapper uses fixed messages and never copies persistence details", () => {
  const mapped = mapSafeHttpError(new ApplicationError("UNKNOWN_PRIVATE", "C:\\secret\\db.sqlite synthetic-key"));
  assert.deepEqual(mapped, { status: 500, code: "INTERNAL_ERROR", message: "Internal application error." });
  assert.equal(MAX_HTTP_JSON_BODY, 16 * 1024);
});
