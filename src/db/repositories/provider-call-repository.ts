import { asc, eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import {
  providerCallRowToDomain,
  providerCallToRow,
} from "../persistence/row-mappers.js";
import {
  ProviderCallPersistenceSchema,
  type ProviderCallPersistence,
} from "../persistence/persistence-types.js";
import {
  audits,
  providerCalls,
  reportVersions,
} from "../schema.js";
import {
  semanticEqual,
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

export class ProviderCallRepository {
  constructor(private readonly connection: PersistenceConnection) {}

  insertProviderCall(input: unknown): RepositoryWriteResult<ProviderCallPersistence> {
    const parsed = ProviderCallPersistenceSchema.safeParse(input);
    if (!parsed.success) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "ProviderCall metadata does not satisfy the frozen persistence contract.",
      );
    }

    const value = parsed.data;

    try {
      this.validateTemporalOrder(value);
      const row = providerCallToRow(value);
      const existing = this.connection.db
        .select()
        .from(providerCalls)
        .where(eq(providerCalls.providerCallId, value.provider_call_id))
        .get();

      if (existing !== undefined) {
        if (!semanticEqual(existing, row)) {
          throw new PersistenceError(
            "IMMUTABILITY_VIOLATION",
            "ProviderCall identity already exists with different immutable metadata.",
          );
        }

        return {
          outcome: "IDEMPOTENT_EXISTING",
          value: providerCallRowToDomain(existing),
        };
      }

      this.validateRelations(value);
      this.connection.db.insert(providerCalls).values(row).run();

      const inserted = this.connection.db
        .select()
        .from(providerCalls)
        .where(eq(providerCalls.providerCallId, value.provider_call_id))
        .get();

      if (inserted === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "ProviderCall insert completed without a readable persisted row.",
        );
      }

      return {
        outcome: "INSERTED",
        value: providerCallRowToDomain(inserted),
      };
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "ProviderCall persistence operation failed.",
      );
    }
  }

  getProviderCallById(providerCallId: string): ProviderCallPersistence {
    try {
      const row = this.connection.db
        .select()
        .from(providerCalls)
        .where(eq(providerCalls.providerCallId, providerCallId))
        .get();

      if (row === undefined) {
        throw new PersistenceError("PERSISTENCE_NOT_FOUND", "ProviderCall was not found.");
      }

      return providerCallRowToDomain(row);
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "ProviderCall read operation failed.",
      );
    }
  }

  getProviderCallsByAudit(auditId: string): readonly ProviderCallPersistence[] {
    try {
      return this.connection.db
        .select()
        .from(providerCalls)
        .where(eq(providerCalls.auditId, auditId))
        .orderBy(asc(providerCalls.startedAt), asc(providerCalls.providerCallId))
        .all()
        .map((row) => providerCallRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "ProviderCall Audit history read failed.",
      );
    }
  }

  getProviderCallsByReportVersion(reportVersionId: string): readonly ProviderCallPersistence[] {
    try {
      return this.connection.db
        .select()
        .from(providerCalls)
        .where(eq(providerCalls.reportVersionId, reportVersionId))
        .orderBy(asc(providerCalls.startedAt), asc(providerCalls.providerCallId))
        .all()
        .map((row) => providerCallRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "ProviderCall ReportVersion history read failed.",
      );
    }
  }

  private validateRelations(value: ProviderCallPersistence): void {
    const audit = this.connection.db
      .select({ auditId: audits.auditId })
      .from(audits)
      .where(eq(audits.auditId, value.audit_id))
      .get();

    if (audit === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_NOT_FOUND",
        "ProviderCall requires an existing Audit.",
      );
    }

    if (value.report_version_id === null) {
      return;
    }

    const report = this.connection.db
      .select({ auditId: reportVersions.auditId })
      .from(reportVersions)
      .where(eq(reportVersions.reportVersionId, value.report_version_id))
      .get();

    if (report === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_NOT_FOUND",
        "ProviderCall references a ReportVersion that does not exist.",
      );
    }

    if (report.auditId !== value.audit_id) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ProviderCall ReportVersion belongs to a different Audit.",
      );
    }
  }

  private validateTemporalOrder(value: ProviderCallPersistence): void {
    if (value.completed_at === null) {
      return;
    }

    if (new Date(value.completed_at).getTime() < new Date(value.started_at).getTime()) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "ProviderCall completion timestamp cannot precede its start timestamp.",
      );
    }
  }
}
