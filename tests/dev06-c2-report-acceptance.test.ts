import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { openPersistenceConnection, type PersistenceConnection } from "../src/db/connection.js";
import { PersistenceError } from "../src/db/persistence-errors.js";
import { AuditRepository } from "../src/db/repositories/audit-repository.js";
import { PrivacyRepository } from "../src/db/repositories/privacy-repository.js";
import { ReportVersionRepository } from "../src/db/repositories/report-version-repository.js";
import { ReportContentRepository } from "../src/db/repositories/report-content-repository.js";
import { ReportAcceptanceRepository, ReportAcceptanceRowSchema } from "../src/db/repositories/report-acceptance-repository.js";
import { ReportAcceptanceService } from "../src/application/reports/report-acceptance-service.js";
import { CanonicalReportReadAdapter } from "../src/application/reports/canonical-report-read-adapter.js";
import { canonicalDigestV1 } from "../src/application/reports/canonical-report-builder.js";
import { stableCanonicalSerialize } from "../src/shared/ids/stable-serialization.js";

const A = "aud_c2_accept"; const P = "prv_c2_accept"; const R = "rpt_c2_accept";
const T = "2026-09-29T00:00:00.000Z";
const migrations = join(process.cwd(), "drizzle");
function acceptanceCount(c: PersistenceConnection): number {
  return (c.sqlite.prepare("SELECT count(*) AS n FROM report_acceptances").get() as { n: number }).n;
}
function isPersistenceIntegrityError(error: unknown): boolean {
  return error instanceof PersistenceError && error.code === "PERSISTENCE_INTEGRITY_ERROR";
}
function audit(c: PersistenceConnection, id: string): void {
  const n = (c.sqlite.prepare("SELECT count(*) AS n FROM audits").get() as { n: number }).n + 1;
  new AuditRepository(c).createAudit({ audit_id: id, revision_salt: Buffer.alloc(32, n).toString("base64url"), created_at: T });
}
function privacy(c: PersistenceConnection, auditId: string, privacyId: string, confirmedAt = T): void {
  new PrivacyRepository(c, () => confirmedAt).saveConfirmedPrivacyAggregate({
    revision: { privacy_revision_id: privacyId, audit_id: auditId, confirmation_state: "CONFIRMED", algorithm: "privacy-revision-v1", confirmed_at: confirmedAt, record_count: 1, mapping_count: 0 },
    records: [{ record_revision_id: `rr_${privacyId}`, audit_id: auditId, record_id: `rec_${privacyId}`, privacy_revision_id: privacyId, source_type: "PASTE", source_name: "Synthetic Source", author: null, timestamp: null, sanitized_content: "Alpha beta gamma.", sequence: 1 }],
    mappings: [],
  });
}
function report(c: PersistenceConnection, auditId: string, privacyId: string, reportId: string, number = 1, parent: string | null = null): void {
  const versions = new ReportVersionRepository(c);
  versions.createReportVersion({ report_version_id: reportId, audit_id: auditId, privacy_revision_id: privacyId, parent_report_version_id: parent, version_number: number, status: "DRAFT", changes_summary: "PRESENTATION_ONLY_SENTINEL", created_at: T, started_at: null, completed_at: null });
  c.transaction(() => versions.transitionLifecycle(reportId, "RUNNING", T));
  const evidence = [
    { evidence_id: `ev_${reportId}_A`, report_version_id: reportId, privacy_revision_id: privacyId, record_revision_id: `rr_${privacyId}`, record_id: `rec_${privacyId}`, source_ref: { source_name: "Synthetic Source", sequence: 1, char_start: 0, char_end: 5 }, excerpt: "Alpha", actor: null, timestamp: T, evidence_type: "STATEMENT", epistemic_status: "FACT", fact_scope: "SOURCE_FACT" },
    { evidence_id: `ev_${reportId}_B`, report_version_id: reportId, privacy_revision_id: privacyId, record_revision_id: `rr_${privacyId}`, record_id: `rec_${privacyId}`, source_ref: { source_name: "Synthetic Source", sequence: 1, char_start: 6, char_end: 10 }, excerpt: "beta", actor: null, timestamp: null, evidence_type: "STATUS", epistemic_status: "FACT", fact_scope: "SOURCE_FACT" },
  ];
  new ReportContentRepository(c).persistReportContent({
    report_version_id: reportId, evidence,
    commitments: [
      { commitment_id: `com_${reportId}_A`, report_version_id: reportId, action_or_deliverable: "Unresolved delivery", evidence_ids: [evidence[0]!.evidence_id], deadline: null, condition: null, recipient: null, lifecycle_status: "UNKNOWN", supersedes_commitment_id: null, status_evidence_ids: [], classification: "CANDIDATE", actor: null, epistemic_status: "UNKNOWN" },
      { commitment_id: `com_${reportId}_B`, report_version_id: reportId, action_or_deliverable: "Confirmed delivery", evidence_ids: [evidence[1]!.evidence_id, evidence[0]!.evidence_id], deadline: null, condition: null, recipient: null, lifecycle_status: "FULFILLED", supersedes_commitment_id: null, status_evidence_ids: [evidence[1]!.evidence_id], classification: "CONFIRMED", actor: "PERSON_1", epistemic_status: "FACT" },
    ],
    changes: [{ change_id: `chg_${reportId}`, report_version_id: reportId, classification: "CONFIRMED", epistemic_status: "FACT", change_type: "CLARIFY", subject: "Delivery", before_summary: null, after_summary: "Local clarification", evidence_ids: [evidence[1]!.evidence_id, evidence[0]!.evidence_id], timestamp: null }],
    conflicts: [{ conflict_id: `cfl_${reportId}`, report_version_id: reportId, conflict_type: "POTENTIAL_CONFLICT", claim_a: { text: "Local A", evidence_ids: [evidence[0]!.evidence_id] }, claim_b: { text: "Local B", evidence_ids: [evidence[1]!.evidence_id] }, comparable_context: { subject: "Delivery", time_context: null, version_context: null, condition_context: null }, conflict_reason: "Potential incompatibility", counter_evidence_ids: [evidence[1]!.evidence_id], alternative_explanations: [{ text: "Different conditions", epistemic_status: "INFERENCE" }], missing_evidence: ["Need context"], epistemic_status: "UNKNOWN", conflicted: true }],
    completeReport: true, completionTimestamp: T,
  });
}
function seeded(path = ":memory:") {
  const connection = openPersistenceConnection(path);
  migrate(connection.db, { migrationsFolder: migrations });
  audit(connection, A); privacy(connection, A, P); report(connection, A, P, R);
  return { connection, service: new ReportAcceptanceService(connection, () => T), reads: new CanonicalReportReadAdapter(connection) };
}
type Fixture = ReturnType<typeof seeded>;
function withFixture(run: (f: Fixture) => void): void {
  const f = seeded(); try { run(f); } finally { f.connection.close(); }
}
function command(f: Fixture, auditId = A, reportId = R) {
  return { auditId, reportVersionId: reportId, expectedCanonicalDigest: f.service.preview({ auditId, reportVersionId: reportId }).canonical_digest };
}
function temporaryDirectory(): string { return mkdtempSync(join(tmpdir(), "dev06-c2-accept-")); }
function cleanTemporary(dir: string): void {
  assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(dir.includes("dev06-c2-accept-")); rmSync(dir, { recursive: true, force: true });
}

test("C2-02/C2-03/C2-13 LOCAL_RUNTIME: COMPLETED/preview are not acceptance; explicit command inserts one safe immutable snapshot", () => withFixture((f) => {
  assert.equal(acceptanceCount(f.connection), 0); assert.equal(f.reads.getAcceptedSafe(A, R), undefined);
  const c = command(f); assert.equal(acceptanceCount(f.connection), 0);
  const result = f.service.accept(c); assert.equal(result.outcome, "INSERTED"); assert.equal(acceptanceCount(f.connection), 1);
  assert.equal(result.acceptance.report_version_id, R); assert.equal(result.acceptance.canonical_digest, c.expectedCanonicalDigest);
  assert.deepEqual(Object.keys(result.acceptance).sort(), ["accepted_at", "audit_id", "canonical_digest", "canonical_format_version", "canonical_json", "canonical_snapshot", "privacy_revision_id", "report_version_id"]);
  assert.ok(Object.isFrozen(result.acceptance.canonical_snapshot.report.timeline));
  assert.ok(!result.acceptance.canonical_json.includes("sanitized_content")); assert.ok(!result.acceptance.canonical_json.includes("PRESENTATION_ONLY_SENTINEL"));
  assert.throws(() => new ReportAcceptanceRepository(f.connection).insertImmutable({}));
  f.connection.transaction(() => assert.throws(() => new ReportAcceptanceRepository(f.connection).insertImmutable(new ReportAcceptanceRepository(f.connection).getByReportVersionId(R))));
}));

test("R1-01 LOCAL_RUNTIME: a valid caller-built acceptance row cannot create SafeAcceptedReport", () => withFixture((f) => {
  const preview = f.service.preview({ auditId: A, reportVersionId: R });
  const fakeRow = {
    reportVersionId: R,
    auditId: A,
    privacyRevisionId: preview.canonical_snapshot.binding.privacy_revision_id,
    canonicalFormatVersion: 1,
    canonicalDigest: preview.canonical_digest,
    canonicalJson: preview.canonical_json,
    acceptedAt: T,
  };
  assert.equal(ReportAcceptanceRowSchema.safeParse(fakeRow).success, true);
  assert.equal(canonicalDigestV1(fakeRow.canonicalJson), fakeRow.canonicalDigest);
  assert.equal(acceptanceCount(f.connection), 0);
  assert.throws(() => f.service.accept(fakeRow));
  assert.equal(Reflect.get(f.reads, "decodeStoredAcceptance"), undefined);
  assert.equal(Reflect.get(Object.getPrototypeOf(f.reads), "decodeStoredAcceptance"), undefined);
  assert.equal(f.reads.getAcceptedSafe(A, R), undefined);

  const result = f.service.accept({ auditId: A, reportVersionId: R, expectedCanonicalDigest: preview.canonical_digest });
  assert.equal(result.outcome, "INSERTED");
  assert.equal(acceptanceCount(f.connection), 1);
  assert.equal(f.reads.getAcceptedSafe(A, R)?.canonical_digest, preview.canonical_digest);
}));

test("C2-03/C2-07 LOCAL_RUNTIME: explicit command rejects caller JSON/report, malformed digest and nonnormalized acceptance time", () => withFixture((f) => {
  const c = command(f);
  for (const input of [{ ...c, canonical_json: "{}" }, { ...c, report: {} }, { ...c, expectedCanonicalDigest: c.expectedCanonicalDigest.toUpperCase() }, { ...c, expectedCanonicalDigest: "short" }, { ...c, raw_prompt: "SYNTHETIC_RAW_PROMPT_SENTINEL" }, { ...c, raw_provider_response: "SYNTHETIC_RESPONSE_SENTINEL" }]) assert.throws(() => f.service.accept(input));
  assert.throws(() => new ReportAcceptanceService(f.connection, () => "2026-09-29T00:00:00Z").accept(c));
  assert.equal(acceptanceCount(f.connection), 0);
}));

test("C2-06 LOCAL_RUNTIME: newer confirmed privacy after preview rejects first acceptance with zero writes", () => withFixture((f) => {
  const c = command(f); privacy(f.connection, A, "prv_new", "2026-09-29T00:10:00.000Z");
  assert.throws(() => f.service.accept(c)); assert.equal(acceptanceCount(f.connection), 0);
}));

test("C2-07 LOCAL_RUNTIME: newer target version after preview rejects old first acceptance", () => withFixture((f) => {
  const c = command(f); report(f.connection, A, P, "rpt_v2", 2, R);
  assert.throws(() => f.service.accept(c)); assert.equal(acceptanceCount(f.connection), 0);
}));

test("C2-07 LOCAL_RUNTIME: lifecycle and digest changes are reread at first acceptance", () => {
  for (const status of ["DRAFT", "RUNNING", "FAILED", "CANCELLED"]) withFixture((f) => {
    const c = command(f); f.connection.sqlite.prepare("UPDATE report_versions SET status=? WHERE report_version_id=?").run(status, R);
    assert.throws(() => f.service.accept(c)); assert.equal(acceptanceCount(f.connection), 0);
  });
  withFixture((f) => {
    const c = command(f); f.connection.sqlite.prepare("UPDATE changes SET after_summary=? WHERE report_version_id=?").run("Different local authority", R);
    assert.throws(() => f.service.accept(c)); assert.equal(acceptanceCount(f.connection), 0);
    assert.throws(() => f.service.accept({ ...c, expectedCanonicalDigest: "0".repeat(64) }));
  });
});

test("C2-07 LOCAL_RUNTIME: same digest retry succeeds historically; different digest rejects without overwrite", () => withFixture((f) => {
  const c = command(f); const original = f.service.accept(c).acceptance;
  privacy(f.connection, A, "prv_future", "2026-09-29T00:10:00.000Z"); report(f.connection, A, "prv_future", "rpt_future", 2, R);
  const retry = f.service.accept(c); assert.equal(retry.outcome, "IDEMPOTENT_EXISTING"); assert.deepEqual(retry.acceptance, original);
  assert.throws(() => f.service.accept({ ...c, expectedCanonicalDigest: "0".repeat(64) }));
  assert.equal(acceptanceCount(f.connection), 1); assert.deepEqual(f.reads.getAcceptedSafe(A, R), original);
}));

test("C2-04/C2-05/C2-17 LOCAL_RUNTIME: nested/source/reference corruption rejects and inserts no acceptance", () => {
  const updates = [
    ["UPDATE evidence SET excerpt='Wrong' WHERE report_version_id=?", R],
    ["UPDATE canonical_records SET sanitized_content='Other source text' WHERE privacy_revision_id=?", P],
    ["UPDATE commitments SET status_evidence_ids_json='[\"ev_missing\"]' WHERE report_version_id=?", R],
    ["UPDATE commitments SET evidence_ids_json='[\"ev_missing\"]' WHERE report_version_id=?", R],
    ["UPDATE changes SET evidence_ids_json='[\"ev_missing\"]' WHERE report_version_id=?", R],
    ["UPDATE conflicts SET claim_a_evidence_ids_json='[\"ev_missing\"]' WHERE report_version_id=?", R],
    ["UPDATE conflicts SET claim_b_evidence_ids_json='[\"ev_missing\"]' WHERE report_version_id=?", R],
    ["UPDATE conflicts SET counter_evidence_ids_json='[\"ev_missing\"]' WHERE report_version_id=?", R],
    [`UPDATE commitments SET status_evidence_ids_json='["ev_${R}_B","ev_${R}_B"]' WHERE report_version_id=?`, R],
    ["UPDATE commitments SET supersedes_commitment_id=commitment_id WHERE report_version_id=?", R],
  ];
  for (const [sql, value] of updates) withFixture((f) => {
    const c = command(f); f.connection.sqlite.prepare(sql!).run(value!);
    assert.throws(() => f.service.accept(c)); assert.equal(acceptanceCount(f.connection), 0); assert.equal(f.connection.sqlite.inTransaction, false);
  });
});

test("C2-04/C2-05 LOCAL_RUNTIME: cross-Audit/report references cannot pass schema-only validation", () => withFixture((f) => {
  const c = command(f); audit(f.connection, "aud_other"); privacy(f.connection, "aud_other", "prv_other"); report(f.connection, "aud_other", "prv_other", "rpt_other");
  f.connection.sqlite.prepare("UPDATE commitments SET status_evidence_ids_json=? WHERE report_version_id=?").run(JSON.stringify(["ev_rpt_other_A"]), R);
  assert.throws(() => f.service.accept(c)); assert.equal(acceptanceCount(f.connection), 0);
  assert.throws(() => f.service.accept({ ...c, auditId: "aud_other" }));
}));

test("C2-04 LOCAL_RUNTIME: ancestor supersession is valid but sibling and chain-cycle are rejected", () => {
  for (const mode of ["ancestor", "sibling", "cycle"] as const) {
    const connection = openPersistenceConnection(":memory:");
    try {
      migrate(connection.db, { migrationsFolder: migrations }); audit(connection, A); privacy(connection, A, P);
      report(connection, A, P, "rpt_root", 1); report(connection, A, P, "rpt_sibling", 2, "rpt_root"); report(connection, A, P, R, 3, "rpt_root");
      const target = mode === "sibling" ? "com_rpt_sibling_A" : "com_rpt_root_A";
      connection.sqlite.prepare("UPDATE commitments SET supersedes_commitment_id=? WHERE commitment_id=?").run(target, `com_${R}_A`);
      if (mode === "cycle") connection.sqlite.prepare("UPDATE commitments SET supersedes_commitment_id=? WHERE commitment_id=?").run(`com_${R}_A`, "com_rpt_root_A");
      const service = new ReportAcceptanceService(connection, () => T);
      if (mode === "ancestor") {
        const digest = service.preview({ auditId: A, reportVersionId: R }).canonical_digest;
        assert.equal(service.accept({ auditId: A, reportVersionId: R, expectedCanonicalDigest: digest }).outcome, "INSERTED");
      } else { assert.throws(() => service.accept({ auditId: A, reportVersionId: R, expectedCanonicalDigest: "0".repeat(64) })); assert.equal(acceptanceCount(connection), 0); }
    } finally { connection.close(); }
  }
});

test("C2-17 LOCAL_RUNTIME: transaction error after INSERT rolls everything back and returns safe error", () => withFixture((f) => {
  const c = command(f);
  f.connection.sqlite.exec("CREATE TRIGGER synthetic_accept_abort AFTER INSERT ON report_acceptances BEGIN SELECT RAISE(ABORT, 'SYNTHETIC_PRIVATE_ERROR_SENTINEL'); END;");
  assert.throws(() => f.service.accept(c), (error: unknown) => error instanceof Error && !error.message.includes("SYNTHETIC_PRIVATE_ERROR_SENTINEL"));
  assert.equal(acceptanceCount(f.connection), 0); assert.equal(f.connection.sqlite.inTransaction, false);
  assert.equal(new ReportVersionRepository(f.connection).getReportVersionById(R).status, "COMPLETED");
}));

test("W01 LOCAL_RUNTIME: all authority reads and INSERT execute inside one same-connection transaction", () => withFixture((f) => {
  const c = command(f); const original = f.connection.sqlite.prepare.bind(f.connection.sqlite); const observed = new Set<string>();
  Object.assign(f.connection.sqlite, { prepare(sql: string) {
    for (const table of ["report_versions", "privacy_revisions", "canonical_records", "evidence", "commitments", "changes", "conflicts", "report_acceptances"]) {
      if (new RegExp(`\\b${table}\\b`, "u").test(sql)) { assert.equal(f.connection.sqlite.inTransaction, true); observed.add(table); }
    }
    return original(sql);
  } });
  try { f.service.accept(c); } finally { Object.assign(f.connection.sqlite, { prepare: original }); }
  assert.deepEqual([...observed].sort(), ["canonical_records", "changes", "commitments", "conflicts", "evidence", "privacy_revisions", "report_acceptances", "report_versions"]);
  f.connection.transaction(() => assert.throws(() => f.service.accept(c)));
}));

test("C2-14 LOCAL_RUNTIME: close/reopen and future version/privacy preserve original accepted bytes", () => {
  const dir = temporaryDirectory(); const path = join(dir, "fixture.sqlite"); let f: Fixture | undefined;
  try {
    f = seeded(path); const c = command(f); const original = f.service.accept(c).acceptance;
    privacy(f.connection, A, "prv_next", "2026-09-29T00:10:00.000Z"); report(f.connection, A, "prv_next", "rpt_next", 2, R);
    f.connection.close(); const connection = openPersistenceConnection(path);
    try {
      migrate(connection.db, { migrationsFolder: migrations });
      const reopened = new CanonicalReportReadAdapter(connection).getAcceptedSafe(A, R)!;
      assert.equal(reopened.canonical_json, original.canonical_json); assert.equal(reopened.canonical_digest, original.canonical_digest); assert.deepEqual(reopened, original);
      assert.equal(new ReportAcceptanceService(connection).accept(c).outcome, "IDEMPOTENT_EXISTING");
    } finally { connection.close(); }
  } finally { f?.connection.close(); cleanTemporary(dir); }
});

test("C2-15 LOCAL_RUNTIME: latest accepted uses version number rather than time and is Audit-bound", () => withFixture((f) => {
  const first = command(f); new ReportAcceptanceService(f.connection, () => "2026-09-29T00:20:00.000Z").accept(first);
  report(f.connection, A, P, "rpt_v2", 2, R); const second = command(f, A, "rpt_v2"); f.service.accept(second);
  audit(f.connection, "aud_other"); privacy(f.connection, "aud_other", "prv_other"); report(f.connection, "aud_other", "prv_other", "rpt_other", 9);
  f.service.accept(command(f, "aud_other", "rpt_other"));
  assert.equal(f.reads.getLatestAcceptedSafe(A)!.report_version_id, "rpt_v2");
  assert.equal(f.reads.getLatestAcceptedSafe("aud_other")!.report_version_id, "rpt_other");
  assert.throws(() => f.reads.getAcceptedSafe("aud_other", R)); assert.equal(f.reads.getLatestAcceptedSafe("aud_absent"), undefined);
}));

test("C2-16 LOCAL_RUNTIME: canonical string/digest/binding corruption fails closed including idempotent retry", () => {
  for (const kind of ["pretty", "digest", "binding", "unknown", "ledger", "format", "time"] as const) withFixture((f) => {
    const c = command(f); const accepted = f.service.accept(c).acceptance;
    if (kind === "pretty") f.connection.sqlite.prepare("UPDATE report_acceptances SET canonical_json=?").run(JSON.stringify(accepted.canonical_snapshot, null, 2));
    if (kind === "digest") f.connection.sqlite.prepare("UPDATE report_acceptances SET canonical_digest=?").run("f".repeat(64));
    if (kind === "binding") { f.connection.sqlite.pragma("foreign_keys = OFF"); f.connection.sqlite.prepare("UPDATE report_acceptances SET audit_id=?").run("aud_other"); f.connection.sqlite.pragma("foreign_keys = ON"); }
    if (kind === "unknown" || kind === "ledger") {
      const snapshot = structuredClone(accepted.canonical_snapshot);
      if (kind === "unknown") (snapshot as unknown as Record<string, unknown>).raw_prompt = "SYNTHETIC_RAW_PROMPT_SENTINEL";
      else snapshot.report.evidence_ledger.pop();
      const json = stableCanonicalSerialize(snapshot);
      f.connection.sqlite.prepare("UPDATE report_acceptances SET canonical_json=?, canonical_digest=?").run(json, canonicalDigestV1(json));
    }
    if (kind === "format") { f.connection.sqlite.pragma("ignore_check_constraints = ON"); f.connection.sqlite.exec("UPDATE report_acceptances SET canonical_format_version=2"); }
    if (kind === "time") f.connection.sqlite.prepare("UPDATE report_acceptances SET accepted_at=?").run("2026-09-29T00:00:00Z");
    assert.throws(() => f.reads.getAcceptedSafe(A, R)); assert.throws(() => f.service.accept(c));
    if (kind === "binding") {
      assert.throws(() => f.reads.getLatestAcceptedSafe(A), isPersistenceIntegrityError);
      assert.equal(f.reads.getLatestAcceptedSafe("aud_other"), undefined);
    } else {
      assert.throws(() => f.reads.getLatestAcceptedSafe(A));
    }
    assert.equal(acceptanceCount(f.connection), 1);
  });
});

test("R1-02 LOCAL_RUNTIME: original Audit latest read fails closed after stored acceptance Audit binding is tampered", () => withFixture((f) => {
  const c = command(f);
  f.service.accept(c);
  assert.equal(acceptanceCount(f.connection), 1);
  assert.equal((f.connection.sqlite.prepare("SELECT report_version_id FROM report_acceptances WHERE report_version_id=?").get(R) as { report_version_id: string } | undefined)?.report_version_id, R);

  f.connection.sqlite.pragma("foreign_keys = OFF");
  try {
    f.connection.sqlite.prepare("UPDATE report_acceptances SET audit_id=? WHERE report_version_id=?").run("aud_tampered", R);
  } finally {
    f.connection.sqlite.pragma("foreign_keys = ON");
  }
  assert.equal(acceptanceCount(f.connection), 1);

  assert.throws(() => f.reads.getLatestAcceptedSafe(A), isPersistenceIntegrityError);
  assert.equal(f.reads.getLatestAcceptedSafe("aud_tampered"), undefined);
  assert.throws(() => f.reads.getAcceptedSafe(A, R), isPersistenceIntegrityError);
  assert.throws(() => f.reads.getAcceptedSafe("aud_tampered", R), isPersistenceIntegrityError);
}));

test("C2-11/C2-12/C2-13 LOCAL_RUNTIME: raw persistence contains only allowlisted acceptance columns/data", () => withFixture((f) => {
  const c = command(f); f.service.accept(c);
  const columns = f.connection.sqlite.prepare("PRAGMA table_info(report_acceptances)").all() as { name: string }[];
  assert.deepEqual(columns.map((v) => v.name), ["report_version_id", "audit_id", "privacy_revision_id", "canonical_format_version", "canonical_digest", "canonical_json", "accepted_at"]);
  const row = f.connection.sqlite.prepare("SELECT * FROM report_acceptances").get() as Record<string, unknown>;
  const raw = JSON.stringify(row);
  for (const forbidden of ["raw_prompt", "raw_provider_response", "SYNTHETIC_RAW_PROMPT_SENTINEL", "SYNTHETIC_RESPONSE_SENTINEL", "PRESENTATION_ONLY_SENTINEL", "original_value", "revision_salt", "sanitized_content", "Authorization", "api_key", "acceptance_id"]) assert.ok(!raw.includes(forbidden));
  assert.equal((f.connection.sqlite.prepare("SELECT count(*) AS n FROM provider_calls").get() as { n: number }).n, 0);
  assert.equal(new ReportVersionRepository(f.connection).getReportVersionById(R).status, "COMPLETED");
}));

test("C2-18 FIXTURE/LOCAL_RUNTIME: fresh 0002 migration has zero acceptances and enforces composite FKs/CHECKs", () => withFixture((f) => {
  assert.equal(acceptanceCount(f.connection), 0);
  const insert = f.connection.sqlite.prepare("INSERT INTO report_acceptances VALUES (?,?,?,?,?,?,?)");
  for (const values of [[R, "aud_other", P, 1, "0".repeat(64), "{}", T], [R, A, "prv_other", 1, "0".repeat(64), "{}", T], [R, A, P, 2, "0".repeat(64), "{}", T], [R, A, P, 1, "short", "{}", T], [R, A, P, 1, "0".repeat(64), "", T]]) assert.throws(() => insert.run(...values));
  assert.equal(acceptanceCount(f.connection), 0);
  assert.equal((f.connection.sqlite.pragma("foreign_key_check") as unknown[]).length, 0);
}));

test("C2-18 FIXTURE/LOCAL_RUNTIME: 0001 to 0002 leaves every historical row unchanged and never backfills COMPLETED", () => {
  const dir = temporaryDirectory(); const oldFolder = join(dir, "old-migrations"); let connection: PersistenceConnection | undefined;
  try {
    mkdirSync(join(oldFolder, "meta"), { recursive: true });
    for (const name of ["0000_robust_cloak.sql", "0001_audit_metadata.sql"]) copyFileSync(join(migrations, name), join(oldFolder, name));
    const journal = JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8")) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, 2); writeFileSync(join(oldFolder, "meta", "_journal.json"), JSON.stringify(journal));
    connection = openPersistenceConnection(join(dir, "upgrade.sqlite")); migrate(connection.db, { migrationsFolder: oldFolder });
    audit(connection, A); privacy(connection, A, P); report(connection, A, P, R);
    const tables = (connection.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    const dump = () => Object.fromEntries(tables.map((name) => [name, connection!.sqlite.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()]));
    const before = stableCanonicalSerialize(dump()); migrate(connection.db, { migrationsFolder: migrations });
    assert.equal(stableCanonicalSerialize(dump()), before); assert.equal(acceptanceCount(connection), 0);
    assert.equal(new ReportVersionRepository(connection).getReportVersionById(R).status, "COMPLETED"); assert.equal(new CanonicalReportReadAdapter(connection).getAcceptedSafe(A, R), undefined);
    assert.equal((connection.sqlite.pragma("foreign_key_check") as unknown[]).length, 0);
    const f = { connection, service: new ReportAcceptanceService(connection, () => T), reads: new CanonicalReportReadAdapter(connection) };
    f.service.accept(command(f)); assert.equal(acceptanceCount(connection), 1);
  } finally { connection?.close(); cleanTemporary(dir); }
});

test("C2-18 STATIC: snapshot metadata preserves old table definitions and journal only appends 0002", () => {
  const old = JSON.parse(readFileSync(join(migrations, "meta", "0001_snapshot.json"), "utf8")) as { id: string; tables: Record<string, unknown> };
  const next = JSON.parse(readFileSync(join(migrations, "meta", "0002_snapshot.json"), "utf8")) as { prevId: string; tables: Record<string, unknown> };
  assert.equal(next.prevId, old.id); for (const [name, table] of Object.entries(old.tables)) assert.deepEqual(next.tables[name], table);
  assert.deepEqual(Object.keys(next.tables).filter((name) => !(name in old.tables)), ["report_acceptances"]);
  const journal = JSON.parse(readFileSync(join(migrations, "meta", "_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  assert.deepEqual(journal.entries.map((entry) => [entry.idx, entry.tag]), [[0, "0000_robust_cloak"], [1, "0001_audit_metadata"], [2, "0002_report_acceptance"]]);
  const sql = readFileSync(join(migrations, "0002_report_acceptance.sql"), "utf8"); assert.ok(!/(?:^|;)\s*(?:INSERT|UPDATE|DELETE|ALTER|DROP)\b/iu.test(sql));
});

test("W01/C2-17 LOCAL_RUNTIME: competing writer lock fails without partial write and permits explicit retry", () => {
  const dir = temporaryDirectory(); let f: Fixture | undefined; let other: PersistenceConnection | undefined;
  try {
    const path = join(dir, "locked.sqlite"); f = seeded(path); const c = command(f); other = openPersistenceConnection(path); f.connection.sqlite.pragma("busy_timeout = 1");
    other.sqlite.transaction(() => { assert.throws(() => f!.service.accept(c)); assert.equal(acceptanceCount(other!), 0); }).immediate();
    assert.equal(f.service.accept(c).outcome, "INSERTED"); assert.equal(acceptanceCount(f.connection), 1);
  } finally { other?.close(); f?.connection.close(); cleanTemporary(dir); }
});

test("C2-07 FIXTURE/LOCAL_RUNTIME: two synchronized processes race and return one insert plus one idempotent success", async () => {
  const dir = temporaryDirectory(); let f: Fixture | undefined;
  try {
    const path = join(dir, "concurrent.sqlite"); f = seeded(path); const c = command(f); f.connection.close();
    const serviceModule = require.resolve("../src/application/reports/report-acceptance-service.js");
    const connectionModule = require.resolve("../src/db/connection.js");
    const code = `const {openPersistenceConnection}=require(process.argv[1]); const {ReportAcceptanceService}=require(process.argv[2]); const connection=openPersistenceConnection(process.argv[3]); console.log('READY'); process.stdin.once('data',()=>{try{const result=new ReportAcceptanceService(connection).accept(JSON.parse(process.argv[4])); console.log(result.outcome);}catch{process.exitCode=1;}finally{connection.close();}});`;
    const children = [0, 1].map(() => spawn(process.execPath, ["-e", code, connectionModule, serviceModule, path, JSON.stringify(c)], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: process.env }));
    const ready = children.map((child) => new Promise<void>((resolveReady, reject) => {
      let text = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("Concurrency fixture readiness timeout.")); }, 15000);
      child.stdout.on("data", (data: Buffer) => { text += data.toString(); if (text.includes("READY")) { clearTimeout(timer); resolveReady(); } }); child.on("error", reject);
    }));
    const completed = children.map((child) => new Promise<string>((resolveDone, reject) => {
      let text = ""; const timer = setTimeout(() => { child.kill(); reject(new Error("Concurrency fixture completion timeout.")); }, 20000);
      child.stdout.on("data", (data: Buffer) => { text += data.toString(); }); child.on("error", reject);
      child.on("close", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error("Concurrency fixture failed.")); else resolveDone(text); });
    }));
    await Promise.all(ready); children.forEach((child) => child.stdin.end("GO\n"));
    const outcomes = (await Promise.all(completed)).map((text) => text.split(/\r?\n/u).find((line) => line === "INSERTED" || line === "IDEMPOTENT_EXISTING")).sort();
    assert.deepEqual(outcomes, ["IDEMPOTENT_EXISTING", "INSERTED"]);
    const reopened = openPersistenceConnection(path); try { assert.equal(acceptanceCount(reopened), 1); assert.equal(new CanonicalReportReadAdapter(reopened).getAcceptedSafe(A, R)!.canonical_digest, c.expectedCanonicalDigest); } finally { reopened.close(); }
  } finally { f?.connection.close(); cleanTemporary(dir); }
});
