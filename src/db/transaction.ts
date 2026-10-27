import type Database from "better-sqlite3";

/**
 * Runs one synchronous aggregate operation inside one SQLite transaction.
 *
 * Ownership rule: the outer aggregate/repository method owns the transaction;
 * child helpers must not independently open nested transactions.
 *
 * better-sqlite3 commits when the callback returns and rolls back when it
 * throws. The original thrown value is intentionally preserved.
 */
export function runInTransaction<T>(
  sqlite: InstanceType<typeof Database>,
  operation: () => T,
): T {
  const transaction = sqlite.transaction(operation);
  return transaction();
}
