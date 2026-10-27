import { eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import { audits } from "../schema.js";
import {
  auditRowToLocalIdentity,
  auditRowToSafeView,
  auditToRow,
} from "../persistence/row-mappers.js";
import type {
  AuditPersistenceInput,
  SafeAuditView,
} from "../persistence/persistence-types.js";
import {
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

export class AuditRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  createAudit(input: unknown): RepositoryWriteResult<SafeAuditView> {
    try {
      const row = auditToRow(input);
      const existing = this.connection.db
        .select()
        .from(audits)
        .where(eq(audits.auditId, row.auditId))
        .get();

      if (existing !== undefined) {
        const same =
          existing.auditId === row.auditId &&
          existing.revisionSalt === row.revisionSalt &&
          existing.createdAt === row.createdAt;

        if (!same) {
          throw new PersistenceError(
            "IMMUTABILITY_VIOLATION",
            "Audit identity already exists with different immutable content.",
          );
        }

        return {
          outcome: "IDEMPOTENT_EXISTING",
          value: auditRowToSafeView(existing),
        };
      }

      this.connection.db.insert(audits).values(row).run();

      const inserted = this.connection.db
        .select()
        .from(audits)
        .where(eq(audits.auditId, row.auditId))
        .get();

      if (inserted === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Audit insert completed without a readable persisted row.",
        );
      }

      return {
        outcome: "INSERTED",
        value: auditRowToSafeView(inserted),
      };
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "CONFLICTING_EXISTING_ROW",
        "Audit persistence operation failed.",
      );
    }
  }

  getAuditById(auditId: string): SafeAuditView {
    try {
      const row = this.connection.db
        .select()
        .from(audits)
        .where(eq(audits.auditId, auditId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Audit was not found.");
      }

      return auditRowToSafeView(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Audit read operation failed.",
      );
    }
  }

  /** Explicit local-only identity path. Do not use for ordinary DTOs/logs/exports. */
  getAuditLocalIdentity(auditId: string): AuditPersistenceInput {
    try {
      const row = this.connection.db
        .select()
        .from(audits)
        .where(eq(audits.auditId, auditId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "Audit was not found.");
      }

      return auditRowToLocalIdentity(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Local Audit identity read failed.",
      );
    }
  }
}
