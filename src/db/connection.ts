import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";

import * as schema from "./schema.js";
import {
  normalizePersistenceError,
  PersistenceError,
} from "./persistence-errors.js";
import { runInTransaction } from "./transaction.js";

const FOREIGN_KEYS_ENABLED = 1;

function verifyForeignKeysEnabled(sqlite: InstanceType<typeof Database>): void {
  const enabled = sqlite.pragma("foreign_keys", { simple: true });

  if (enabled !== FOREIGN_KEYS_ENABLED) {
    throw new PersistenceError(
      "FOREIGN_KEYS_DISABLED",
      "SQLite foreign key enforcement is not enabled.",
    );
  }
}

/**
 * The single production SQLite open entry.
 *
 * The caller must supply the database path. Product storage placement belongs
 * to the application layer; this module does not choose a repository-local
 * default path.
 */
export function openPersistenceConnection(databasePath: string) {
  if (databasePath.length === 0) {
    throw new PersistenceError(
      "PERSISTENCE_INTEGRITY_ERROR",
      "A SQLite database path is required.",
    );
  }

  let sqlite: InstanceType<typeof Database>;

  try {
    sqlite = new Database(databasePath);
  } catch (error: unknown) {
    throw normalizePersistenceError(
      error,
      "PERSISTENCE_INTEGRITY_ERROR",
      "SQLite persistence connection could not be opened.",
    );
  }

  try {
    sqlite.pragma("foreign_keys = ON");
    verifyForeignKeysEnabled(sqlite);
  } catch (error: unknown) {
    if (sqlite.open) {
      sqlite.close();
    }

    if (error instanceof PersistenceError) {
      throw error;
    }

    throw normalizePersistenceError(
      error,
      "PERSISTENCE_INTEGRITY_ERROR",
      "SQLite persistence connection initialization failed.",
    );
  }

  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    transaction<T>(operation: () => T): T {
      return runInTransaction(sqlite, operation);
    },
    close(): void {
      if (sqlite.open) {
        sqlite.close();
      }
    },
  };
}

export type PersistenceConnection = ReturnType<typeof openPersistenceConnection>;
