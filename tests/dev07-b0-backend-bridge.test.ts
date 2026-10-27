import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { openPersistenceConnection } from "../src/db/connection.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";
import { bootstrapApplicationStore, type ApplicationStore, type ServerStorageConfiguration } from "../src/application/storage/application-store.js";
import { resolveApplicationDataDirectory } from "../src/application/storage/data-directory.js";
import { ApplicationError } from "../src/application/errors.js";
import type { FourFamilyProviderPort, ProviderCallMetadata } from "../src/application/runs/four-family-run-ports.js";
import type { WorkflowState } from "../src/application/workflow/workflow-state-read-adapter.js";
import { closeSharedApplicationStore, resetSharedApplicationStoreForTests } from "../src/server/application-store.js";
import { toWorkflowStateResponseDTO } from "../src/server/http/http-dtos.js";
import { mapSafeHttpError, SafeRunHttpError } from "../src/server/http/safe-http-error-mapper.js";
import { GET as getWorkflow, OPTIONS as workflowOptions } from "../src/app/api/audits/[auditId]/workflow/route.js";
import { POST as runAudit } from "../src/app/api/audits/[auditId]/runs/route.js";

const TEXT = "Delivery is due Friday.";
const FORBIDDEN = /privacyRevisionId|privacy_revision_id|recordRevisionId|record_revision_id|raw_value|original_value|normalized_key|mapping|canonical_json|sanitized_content|prompt|provider|api.?key|sqlite|[A-Z]:\\|SYNTHETIC_PRIVATE/iu;
type Fixture = {
  store: ApplicationStore;
  database: string;
  reopen(): Promise<ApplicationStore>;
};

async function fixture(action: (value: Fixture) => Promise<void>, factory?: ServerStorageConfiguration["fourFamilyProviderPortFactory"]): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "dev07-b0-"));
  const config: ServerStorageConfiguration = { environment: { LOCALAPPDATA: root }, fourFamilyProviderPortFactory: factory };
  const stores: ApplicationStore[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("Network is forbidden in B0 isolated tests."); };
  try {
    const store = await bootstrapApplicationStore(config);
    stores.push(store);
    resetSharedApplicationStoreForTests(async () => store);
    const value: Fixture = {
      store, database: path.join(resolveApplicationDataDirectory(config.environment), "audit.sqlite"),
      async reopen() {
        await closeSharedApplicationStore();
        await value.store.close();
        value.store = await bootstrapApplicationStore(config);
        stores.push(value.store);
        resetSharedApplicationStoreForTests(async () => value.store);
        return value.store;
      },
    };
    await action(value);
  } finally {
    await closeSharedApplicationStore();
    for (const store of stores.reverse()) await store.close();
    globalThis.fetch = originalFetch;
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  }
}

function request(auditId: string, suffix = "workflow", method = "GET"): Request {
  return new Request(`http://127.0.0.1:3210/api/audits/${auditId}/${suffix}`, {
    method, headers: { host: "127.0.0.1:3210", "x-request-id": "caller-controlled",
      ...(method === "POST" ? { origin: "http://127.0.0.1:3210", "content-type": "application/json" } : {}) },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
}
function context(auditId: string) { return { params: Promise.resolve({ auditId }) }; }

async function workflow(auditId: string): Promise<WorkflowState> {
  const response = await getWorkflow(request(auditId), context(auditId));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("X-Request-ID")!, /^[0-9a-f-]{36}$/u);
  assert.notEqual(response.headers.get("X-Request-ID"), "caller-controlled");
  const value = await response.json() as WorkflowState;
  assert.deepEqual(Object.keys(value).sort(), ["auditId", "latestSettledReport", "privacyConfirmed", "privacyConfirmedAt"]);
  if (value.latestSettledReport) assert.deepEqual(Object.keys(value.latestSettledReport).sort(), ["reportVersionId", "status", "versionNumber"]);
  assert.equal(FORBIDDEN.test(JSON.stringify(value)), false);
  return value;
}

async function confirm(store: ApplicationStore, auditId: string, text = TEXT) {
  store.reviews.beginPaste(auditId, { text });
  const candidate = store.reviews.finalize(auditId);
  return store.confirmation.confirm({ auditId, reviewCandidateId: candidate.reviewCandidateId });
}

function report(database: string, auditId: string, privacyId: string, number: number, status: "RUNNING" | "DRAFT" | "COMPLETED" | "FAILED" | "CANCELLED") {
  const connection = openPersistenceConnection(database);
  const id = `rpt_${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    const repository = new ReportVersionRepository(connection);
    repository.createReportVersion({ report_version_id: id, audit_id: auditId, privacy_revision_id: privacyId,
      parent_report_version_id: null, version_number: number, status: status === "DRAFT" ? "DRAFT" : "RUNNING",
      changes_summary: null, created_at: now, started_at: status === "DRAFT" ? null : now, completed_at: null });
    if (status !== "RUNNING" && status !== "DRAFT") connection.transaction(() => repository.transitionLifecycle(id, status, now));
    return id;
  } finally { connection.close(); }
}

function mutate(database: string, sql: string, ...parameters: unknown[]): void {
  const db = new Database(database);
  try { db.pragma("foreign_keys = OFF"); db.pragma("ignore_check_constraints = ON"); db.prepare(sql).run(...parameters); }
  finally { db.close(); }
}

async function internalError(auditId: string) {
  const response = await getWorkflow(request(auditId), context(auditId));
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, "INTERNAL_ERROR");
  assert.equal(body.error.message, "Internal application error.");
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "request_id"]);
  assert.equal(FORBIDDEN.test(JSON.stringify(body)), false);
}

test("B0-01 unconfirmed and transient Review return only INPUT metadata", async () => fixture(async ({ store }) => {
  const { auditId } = store.audits.create({ displayName: "Synthetic B0" });
  assert.deepEqual(await workflow(auditId), { auditId, privacyConfirmed: false, privacyConfirmedAt: null, latestSettledReport: null });
  store.reviews.beginPaste(auditId, { text: TEXT });
  store.reviews.finalize(auditId);
  assert.equal((await workflow(auditId)).privacyConfirmed, false);
}));

test("B0-02 formal Paste/Review/Finalize/Confirm survives Store restart without Review memory", async () => fixture(async (value) => {
  const { auditId } = value.store.audits.create({ displayName: "Synthetic confirmed" });
  const result = await confirm(value.store, auditId);
  assert.equal(value.store.reviews.memoryUsage.sessions, 0);
  const transient = value.store.audits.create({ displayName: "Synthetic transient" });
  value.store.reviews.beginPaste(transient.auditId, { text: TEXT });
  const reopened = await value.reopen();
  assert.equal(reopened.reviews.memoryUsage.sessions, 0);
  assert.deepEqual(await workflow(auditId), { auditId, privacyConfirmed: true, privacyConfirmedAt: result.confirmed_at, latestSettledReport: null });
  assert.equal((await workflow(transient.auditId)).privacyConfirmed, false);
  assert.throws(() => reopened.reviews.getSessionLocal(transient.auditId), (error: unknown) => error instanceof ApplicationError && error.code === "REVIEW_UNAVAILABLE");
}));

test("B0-03 current Privacy COMPLETED report returns only settled metadata", async () => fixture(async ({ store, database }) => {
  const { auditId } = store.audits.create({ displayName: "Synthetic completed" });
  const privacy = await confirm(store, auditId);
  const id = report(database, auditId, privacy.privacy_revision_id, 1, "COMPLETED");
  assert.deepEqual((await workflow(auditId)).latestSettledReport, { reportVersionId: id, versionNumber: 1, status: "COMPLETED" });
}));

test("B0-04 Privacy B confirmation invalidates settled workflow from Privacy A", async () => fixture(async ({ store, database }) => {
  const { auditId } = store.audits.create({ displayName: "Synthetic freshness" });
  const a = await confirm(store, auditId);
  report(database, auditId, a.privacy_revision_id, 1, "COMPLETED");
  assert.ok((await workflow(auditId)).latestSettledReport);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const b = await confirm(store, auditId, "Delivery is due Monday.");
  assert.notEqual(a.privacy_revision_id, b.privacy_revision_id);
  assert.deepEqual(await workflow(auditId), { auditId, privacyConfirmed: true, privacyConfirmedAt: b.confirmed_at, latestSettledReport: null });
}));

test("B0-05 latest FAILED settles; newer RUNNING/DRAFT/CANCELLED remain ignored after restart", async () => fixture(async (value) => {
  const { auditId } = value.store.audits.create({ displayName: "Synthetic settled" });
  const privacy = await confirm(value.store, auditId);
  report(value.database, auditId, privacy.privacy_revision_id, 1, "COMPLETED");
  const failed = report(value.database, auditId, privacy.privacy_revision_id, 2, "FAILED");
  report(value.database, auditId, privacy.privacy_revision_id, 3, "RUNNING");
  report(value.database, auditId, privacy.privacy_revision_id, 4, "DRAFT");
  report(value.database, auditId, privacy.privacy_revision_id, 5, "CANCELLED");
  await value.reopen();
  assert.deepEqual((await workflow(auditId)).latestSettledReport, { reportVersionId: failed, versionNumber: 2, status: "FAILED" });
}));

test("B0-06 valid other-Audit Privacy and reports never appear in this Audit", async () => fixture(async ({ store, database }) => {
  const a = store.audits.create({ displayName: "Synthetic A" });
  const b = store.audits.create({ displayName: "Synthetic B" });
  const privacyB = await confirm(store, b.auditId);
  report(database, b.auditId, privacyB.privacy_revision_id, 1, "COMPLETED");
  assert.equal((await workflow(a.auditId)).privacyConfirmed, false);
  await confirm(store, a.auditId);
  assert.equal((await workflow(a.auditId)).latestSettledReport, null);
}));

test("B0-07 unknown Audit is 404; malformed Audit path is 400", async () => fixture(async () => {
  const unknown = await getWorkflow(request("aud_missing"), context("aud_missing"));
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "AUDIT_NOT_FOUND");
  const malformed = await getWorkflow(request("invalid"), context("invalid"));
  assert.equal(malformed.status, 400);
}));

for (const direction of ["report-audit", "privacy-audit", "missing-privacy"] as const) {
  test(`B0-08 binding corruption ${direction} fails closed`, async () => fixture(async ({ store, database }) => {
    const a = store.audits.create({ displayName: "Synthetic corruption A" });
    const b = store.audits.create({ displayName: "Synthetic corruption B" });
    const pa = await confirm(store, a.auditId);
    const pb = await confirm(store, b.auditId);
    const id = report(database, a.auditId, pa.privacy_revision_id, 1, "COMPLETED");
    if (direction === "report-audit") mutate(database, "UPDATE report_versions SET audit_id=? WHERE report_version_id=?", b.auditId, id);
    else mutate(database, "UPDATE report_versions SET privacy_revision_id=? WHERE report_version_id=?", direction === "privacy-audit" ? pb.privacy_revision_id : "prv_missing", id);
    await internalError(a.auditId);
  }));
}

test("B0-09 invalid confirmed metadata fails closed", async () => fixture(async ({ store, database }) => {
  const { auditId } = store.audits.create({ displayName: "Synthetic bad time" });
  const privacy = await confirm(store, auditId);
  mutate(database, "UPDATE privacy_revisions SET confirmed_at=? WHERE privacy_revision_id=?", "SYNTHETIC_PRIVATE_TIME", privacy.privacy_revision_id);
  await internalError(auditId);
}));

test("B0-10 invalid report version metadata fails closed", async () => fixture(async ({ store, database }) => {
  const { auditId } = store.audits.create({ displayName: "Synthetic bad version" });
  const privacy = await confirm(store, auditId);
  const id = report(database, auditId, privacy.privacy_revision_id, 1, "COMPLETED");
  mutate(database, "UPDATE report_versions SET version_number=? WHERE report_version_id=?", 1.5, id);
  await internalError(auditId);
}));

test("B0-11 invalid Audit identity fails closed without returning salt", async () => fixture(async ({ store, database }) => {
  const { auditId } = store.audits.create({ displayName: "Synthetic bad salt" });
  mutate(database, "UPDATE audits SET revision_salt=? WHERE audit_id=?", "SYNTHETIC_PRIVATE_SALT", auditId);
  await internalError(auditId);
}));

test("B0-12 HTTP DTO projects explicit keys even when internal values carry extra properties", () => {
  const value = { auditId: "aud_fixture", privacyConfirmed: true, privacyConfirmedAt: "2026-10-05T10:00:00.000Z",
    privacyRevisionId: "SYNTHETIC_PRIVATE_AUTHORITY", mapping: "SYNTHETIC_PRIVATE_MAPPING",
    latestSettledReport: { reportVersionId: "rpt_fixture", versionNumber: 2, status: "FAILED", canonical_json: "SYNTHETIC_PRIVATE_BODY" } };
  const projected = toWorkflowStateResponseDTO(value as WorkflowState);
  assert.equal(FORBIDDEN.test(JSON.stringify(projected)), false);
  assert.deepEqual(Object.keys(projected).sort(), ["auditId", "latestSettledReport", "privacyConfirmed", "privacyConfirmedAt"]);
  assert.deepEqual(Object.keys(projected.latestSettledReport!).sort(), ["reportVersionId", "status", "versionNumber"]);
});

test("B0-13 actual same-Audit concurrent C3 Run returns fixed public code; fake Provider only", async () => {
  let release!: () => void;
  let entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let calls = 0;
  const factory = (): FourFamilyProviderPort => ({
    async extractEvidence() {
      calls += 1; entered(); await wait;
      const now = new Date().toISOString();
      const providerCall: ProviderCallMetadata = { provider_call_id: `pcall_${randomUUID()}`, stage: "EVIDENCE_EXTRACTION",
        provider_name: "fixture", model_name: "fixture", started_at: now, completed_at: now, latency_ms: 0, status: "FAILED",
        input_record_count: 1, input_size_chars: TEXT.length, input_tokens: null, output_tokens: null, total_tokens: null,
        cost_amount_micros: null, cost_currency: null, retry_count: 0, schema_valid: false,
        error_category: "PROVIDER_TRANSPORT_FAILURE", output_counts: null };
      return { ok: false, failureCategory: "PROVIDER_TRANSPORT_FAILURE", providerCall };
    },
    async commitmentChange() { throw new Error("Unreachable fixture stage."); },
    async conflictCounterEvidence() { throw new Error("Unreachable fixture stage."); },
    async proposeReportPresentation() { throw new Error("Unreachable fixture stage."); },
  });
  await fixture(async ({ store }) => {
    const { auditId } = store.audits.create({ displayName: "Synthetic concurrent" });
    await confirm(store, auditId);
    const first = runAudit(request(auditId, "runs", "POST"), context(auditId));
    try {
      await started;
      assert.equal((await workflow(auditId)).latestSettledReport, null);
      const second = await runAudit(request(auditId, "runs", "POST"), context(auditId));
      assert.equal(second.status, 409);
      const body = await second.json();
      assert.deepEqual(body.error, { code: "RUN_ALREADY_ACTIVE", message: "Analysis is already running.", request_id: second.headers.get("X-Request-ID") });
      assert.equal(/stack|Run is already active|provider|secret/iu.test(JSON.stringify(body)), false);
      assert.equal(calls, 1);
    } finally { release(); await first; }
    assert.equal((await first).status, 502);
    assert.equal((await workflow(auditId)).latestSettledReport?.status, "FAILED");
  }, factory);
});

test("B0-14 only RUN_ALREADY_ACTIVE changes public code; raw messages and ordinary conflicts remain safe", () => {
  assert.deepEqual(mapSafeHttpError(new ApplicationError("RUN_ALREADY_ACTIVE", "SYNTHETIC_PRIVATE_RAW_ERROR")), {
    status: 409, code: "RUN_ALREADY_ACTIVE", message: "Analysis is already running.",
  });
  for (const category of ["STALE_PRIVACY", "LIFECYCLE_DRIFT"] as const) {
    assert.deepEqual(mapSafeHttpError(new SafeRunHttpError(category)), { status: 409, code: "REQUEST_CONFLICT", message: "Request conflicts with current local state." });
  }
  for (const code of ["STORE_CLOSED", "REVIEW_UNAVAILABLE", "REVIEW_CONFIRMING"] as const) {
    assert.equal(mapSafeHttpError(new ApplicationError(code, "SYNTHETIC_PRIVATE_RAW_ERROR")).code, "REQUEST_CONFLICT");
  }
});

test("B0-15 Workflow inherits local Host guard and rejects OPTIONS without CORS permission", async () => fixture(async ({ store }) => {
  const { auditId } = store.audits.create({ displayName: "Synthetic guard" });
  const remote = new Request("http://example.invalid/workflow", { headers: { host: "example.invalid" } });
  assert.equal((await getWorkflow(remote, context(auditId))).status, 403);
  const options = workflowOptions(request(auditId, "workflow", "OPTIONS"));
  assert.equal(options.status, 405);
  assert.equal(options.headers.has("Access-Control-Allow-Origin"), false);
}));
