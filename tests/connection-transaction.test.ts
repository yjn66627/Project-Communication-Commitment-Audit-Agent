import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { openPersistenceConnection } from "../src/db/connection.js";
import {
  normalizePersistenceError,
  PersistenceError,
} from "../src/db/persistence-errors.js";

function withMemoryConnection<T>(operation: (connection: ReturnType<typeof openPersistenceConnection>) => T): T {
  const connection = openPersistenceConnection(":memory:");

  try {
    return operation(connection);
  } finally {
    connection.close();
  }
}

function listTypeScriptFiles(root: string): string[] {
  const files: string[] = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(path));
    } else if (entry.isFile() && path.endsWith(".ts")) {
      files.push(path);
    }
  }

  return files;
}

test("connection: opens an explicit :memory: database", () => {
  withMemoryConnection((connection) => {
    assert.equal(connection.sqlite.open, true);
    assert.equal(connection.sqlite.memory, true);
  });
});

test("connection: PRAGMA foreign_keys is enabled and verified", () => {
  withMemoryConnection((connection) => {
    assert.equal(connection.sqlite.pragma("foreign_keys", { simple: true }), 1);
  });
});

test("connection: close closes the underlying SQLite handle", () => {
  const connection = openPersistenceConnection(":memory:");
  connection.close();
  assert.equal(connection.sqlite.open, false);
});

test("transaction: successful aggregate operation commits", () => {
  withMemoryConnection((connection) => {
    connection.sqlite.exec("CREATE TABLE cp3c1_tx (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");

    connection.transaction(() => {
      connection.sqlite.prepare("INSERT INTO cp3c1_tx (value) VALUES (?)").run("committed");
    });

    const count = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM cp3c1_tx")
      .get() as { count: number };
    assert.equal(count.count, 1);
  });
});

test("transaction: thrown failure rolls back the aggregate operation", () => {
  withMemoryConnection((connection) => {
    connection.sqlite.exec("CREATE TABLE cp3c1_tx (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");

    assert.throws(() => {
      connection.transaction(() => {
        connection.sqlite.prepare("INSERT INTO cp3c1_tx (value) VALUES (?)").run("rolled-back");
        throw new Error("synthetic transaction failure");
      });
    });

    const count = connection.sqlite
      .prepare("SELECT COUNT(*) AS count FROM cp3c1_tx")
      .get() as { count: number };
    assert.equal(count.count, 0);
  });
});

test("transaction: original thrown error identity is preserved", () => {
  withMemoryConnection((connection) => {
    const sentinel = new Error("synthetic sentinel");

    assert.throws(
      () => connection.transaction(() => {
        throw sentinel;
      }),
      (error: unknown) => error === sentinel,
    );
  });
});

test("errors: normalization does not echo sensitive lower-level content", () => {
  const lowerLevel = new Error(
    "original_value=synthetic-local revision_salt=synthetic-salt Authorization=synthetic-token",
  );
  const normalized = normalizePersistenceError(
    lowerLevel,
    "TRANSACTION_FAILED",
    "Persistence transaction failed.",
  );

  assert.ok(normalized instanceof PersistenceError);
  assert.equal(normalized.code, "TRANSACTION_FAILED");
  assert.equal(normalized.message, "Persistence transaction failed.");
  assert.equal(normalized.message.includes("synthetic-local"), false);
  assert.equal(normalized.message.includes("synthetic-salt"), false);
  assert.equal(normalized.message.includes("synthetic-token"), false);
});

test("architecture: production SQLite open expression has exactly one entry", () => {
  const productionFiles = listTypeScriptFiles(join(process.cwd(), "src"));
  const openExpression = /new\s+Database\s*\(/g;
  let count = 0;

  for (const file of productionFiles) {
    const source = readFileSync(file, "utf8");
    count += source.match(openExpression)?.length ?? 0;
  }

  assert.equal(count, 1);
});
