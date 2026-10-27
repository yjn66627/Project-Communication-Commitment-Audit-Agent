import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const packageJson = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
);

test("foundation dependency baseline is frozen", () => {
  assert.equal(packageJson.dependencies["better-sqlite3"], "12.11.1");
  assert.equal(packageJson.dependencies["drizzle-orm"], "0.45.2");
  assert.equal(packageJson.dependencies["next"], "16.2.11");
  assert.equal(packageJson.dependencies["@langchain/langgraph"], "1.4.13");
  assert.equal(packageJson.dependencies["zod"], "3.25.76");
});

test("Node 22 and 24 are allowed without opening Node 25+", () => {
  assert.equal(packageJson.engines.node, ">=22 <25");
});

test("foundation uses npm scripts and does not declare alternate package managers", () => {
  assert.match(packageJson.packageManager, /^npm@/);
  assert.ok(packageJson.scripts.dev);
  assert.ok(packageJson.scripts.build);
  assert.ok(packageJson.scripts.lint);
  assert.ok(packageJson.scripts.typecheck);
  assert.ok(packageJson.scripts.test);
});
