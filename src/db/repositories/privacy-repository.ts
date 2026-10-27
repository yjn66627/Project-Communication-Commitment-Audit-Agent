import { asc, eq } from "drizzle-orm";

import type { PersistenceConnection } from "../connection.js";
import { PersistenceError } from "../persistence-errors.js";
import {
  audits,
  canonicalRecords,
  privacyMappings,
  privacyRevisions,
} from "../schema.js";
import {
  canonicalRecordRowToDomain,
  canonicalRecordToRow,
  confirmedPrivacyRevisionToRow,
  privacyMappingRowToDomain,
  privacyMappingToRow,
  privacyRevisionRowToDomain,
} from "../persistence/row-mappers.js";
import {
  SanitizedCanonicalRecordRevisionSchema,
  type SanitizedCanonicalRecordRevision,
} from "../../domain/schemas/canonical.js";
import {
  ConfirmedPrivacyRevisionSchema,
  PrivacyMappingSchema,
  type ConfirmedPrivacyRevision,
  type PrivacyMapping,
} from "../../domain/schemas/privacy.js";
import {
  semanticEqual,
  toRepositoryError,
  type RepositoryWriteResult,
} from "./repository-utils.js";

export type ConfirmedPrivacyAggregateInput = Readonly<{
  revision: unknown;
  records: readonly unknown[];
  mappings: readonly unknown[];
}>;

export type SafeConfirmedPrivacyAggregate = Readonly<{
  revision: ConfirmedPrivacyRevision;
  records: readonly SanitizedCanonicalRecordRevision[];
}>;

export type LocalConfirmedPrivacyAggregate = Readonly<{
  revision: ConfirmedPrivacyRevision;
  records: readonly SanitizedCanonicalRecordRevision[];
  mappings: readonly PrivacyMapping[];
}>;

function sortRecords(
  records: readonly SanitizedCanonicalRecordRevision[],
): SanitizedCanonicalRecordRevision[] {
  return [...records].sort(
    (left, right) =>
      left.sequence - right.sequence || left.record_id.localeCompare(right.record_id),
  );
}

function sortMappings(mappings: readonly PrivacyMapping[]): PrivacyMapping[] {
  return [...mappings].sort(
    (left, right) =>
      left.entity_type.localeCompare(right.entity_type) ||
      left.placeholder.localeCompare(right.placeholder) ||
      left.mapping_id.localeCompare(right.mapping_id),
  );
}

export class PrivacyRepository {
  constructor(
    private readonly connection: PersistenceConnection,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  saveConfirmedPrivacyAggregate(
    input: ConfirmedPrivacyAggregateInput,
  ): RepositoryWriteResult<SafeConfirmedPrivacyAggregate> {
    try {
      const normalized = this.normalizeAggregateInput(input);
      const existing = this.tryReadExistingAggregate(normalized.revision.privacy_revision_id);

      if (existing !== undefined) {
        this.assertExistingAggregateMatches(normalized, existing);
        return {
          outcome: "IDEMPOTENT_EXISTING",
          value: {
            revision: existing.revision,
            records: existing.records,
          },
        };
      }

      const audit = this.connection.db
        .select({ auditId: audits.auditId })
        .from(audits)
        .where(eq(audits.auditId, normalized.revision.audit_id))
        .get();

      if (audit === undefined) {
        throw new PersistenceError(
          "PERSISTENCE_NOT_FOUND",
          "Confirmed privacy aggregate requires an existing Audit.",
        );
      }

      this.connection.transaction(() => {
        // Immutable record revision IDs are globally unique. A pre-existing row
        // under a new aggregate is an integrity/immutability violation, never an UPDATE target.
        for (const record of normalized.records) {
          const existingRecord = this.connection.db
            .select()
            .from(canonicalRecords)
            .where(eq(canonicalRecords.recordRevisionId, record.record_revision_id))
            .get();

          if (existingRecord !== undefined) {
            const existingDomain = canonicalRecordRowToDomain(existingRecord);
            if (!semanticEqual(existingDomain, record)) {
              throw new PersistenceError(
                "IMMUTABILITY_VIOLATION",
                "Canonical record revision already exists with different immutable content.",
              );
            }

            throw new PersistenceError(
              "PERSISTENCE_INTEGRITY_ERROR",
              "Canonical record revision exists without its expected confirmed aggregate.",
            );
          }
        }

        this.connection.db
          .insert(privacyRevisions)
          .values(confirmedPrivacyRevisionToRow(normalized.revision))
          .run();

        for (const record of normalized.records) {
          this.connection.db.insert(canonicalRecords).values(canonicalRecordToRow(record)).run();
        }

        const mappingCreatedAt = this.now();
        for (const mapping of normalized.mappings) {
          this.connection.db
            .insert(privacyMappings)
            .values(privacyMappingToRow(mapping, mappingCreatedAt))
            .run();
        }
      });

      return {
        outcome: "INSERTED",
        value: this.getConfirmedPrivacyAggregateSafe(normalized.revision.privacy_revision_id),
      };
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "TRANSACTION_FAILED",
        "Confirmed privacy aggregate transaction failed.",
      );
    }
  }

  getConfirmedPrivacyRevision(privacyRevisionId: string): ConfirmedPrivacyRevision {
    try {
      return privacyRevisionRowToDomain(this.requireRevisionRow(privacyRevisionId));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Confirmed privacy revision read failed.",
      );
    }
  }

  getCanonicalRecordsByPrivacyRevision(
    privacyRevisionId: string,
  ): readonly SanitizedCanonicalRecordRevision[] {
    try {
      const revision = privacyRevisionRowToDomain(this.requireRevisionRow(privacyRevisionId));
      const rows = this.connection.db
        .select()
        .from(canonicalRecords)
        .where(eq(canonicalRecords.privacyRevisionId, privacyRevisionId))
        .orderBy(asc(canonicalRecords.sequence), asc(canonicalRecords.recordId))
        .all();

      if (rows.length !== revision.record_count) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Canonical snapshot row count does not match the confirmed revision.",
        );
      }

      return rows.map((row) => canonicalRecordRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Canonical snapshot read failed.",
      );
    }
  }

  /** Local-only mapping-vault access; returned values contain original_value. */
  getLocalMappingsByPrivacyRevision(privacyRevisionId: string): readonly PrivacyMapping[] {
    try {
      const revision = privacyRevisionRowToDomain(this.requireRevisionRow(privacyRevisionId));
      const rows = this.connection.db
        .select()
        .from(privacyMappings)
        .where(eq(privacyMappings.privacyRevisionId, privacyRevisionId))
        .orderBy(
          asc(privacyMappings.entityType),
          asc(privacyMappings.placeholder),
          asc(privacyMappings.mappingId),
        )
        .all();

      if (rows.length !== revision.mapping_count) {
        throw new PersistenceError(
          "PERSISTENCE_INTEGRITY_ERROR",
          "Local mapping-vault row count does not match the confirmed revision.",
        );
      }

      return rows.map((row) => privacyMappingRowToDomain(row));
    } catch (error: unknown) {
      throw toRepositoryError(
        error,
        "PERSISTENCE_INTEGRITY_ERROR",
        "Local privacy mapping read failed.",
      );
    }
  }

  /** Safe aggregate path: intentionally excludes all reversible mapping-vault data. */
  getConfirmedPrivacyAggregateSafe(privacyRevisionId: string): SafeConfirmedPrivacyAggregate {
    return {
      revision: this.getConfirmedPrivacyRevision(privacyRevisionId),
      records: this.getCanonicalRecordsByPrivacyRevision(privacyRevisionId),
    };
  }

  /** Explicit local-only aggregate path; contains original_value via mappings. */
  getConfirmedPrivacyAggregateLocal(privacyRevisionId: string): LocalConfirmedPrivacyAggregate {
    return {
      ...this.getConfirmedPrivacyAggregateSafe(privacyRevisionId),
      mappings: this.getLocalMappingsByPrivacyRevision(privacyRevisionId),
    };
  }

  private normalizeAggregateInput(input: ConfirmedPrivacyAggregateInput): LocalConfirmedPrivacyAggregate {
    const revisionResult = ConfirmedPrivacyRevisionSchema.safeParse(input.revision);
    if (!revisionResult.success) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "Confirmed privacy revision input does not satisfy the frozen Domain contract.",
      );
    }
    const revision = revisionResult.data;

    const records = sortRecords(
      input.records.map((record) => {
        const result = SanitizedCanonicalRecordRevisionSchema.safeParse(record);
        if (!result.success) {
          throw new PersistenceError(
            "DOMAIN_VALIDATION_ERROR",
            "Canonical record input does not satisfy the frozen Domain contract.",
          );
        }
        return result.data;
      }),
    );

    const mappings = sortMappings(
      input.mappings.map((mapping) => {
        const result = PrivacyMappingSchema.safeParse(mapping);
        if (!result.success) {
          throw new PersistenceError(
            "DOMAIN_VALIDATION_ERROR",
            "Privacy mapping input does not satisfy the frozen Domain contract.",
          );
        }
        return result.data;
      }),
    );

    if (revision.record_count !== records.length || revision.mapping_count !== mappings.length) {
      throw new PersistenceError(
        "DOMAIN_VALIDATION_ERROR",
        "Confirmed privacy aggregate counts do not match its supplied members.",
      );
    }

    for (const record of records) {
      if (
        record.audit_id !== revision.audit_id ||
        record.privacy_revision_id !== revision.privacy_revision_id
      ) {
        throw new PersistenceError(
          "DOMAIN_VALIDATION_ERROR",
          "Canonical record does not belong to the confirmed privacy aggregate.",
        );
      }
    }

    for (const mapping of mappings) {
      if (
        mapping.audit_id !== revision.audit_id ||
        mapping.privacy_revision_id !== revision.privacy_revision_id
      ) {
        throw new PersistenceError(
          "DOMAIN_VALIDATION_ERROR",
          "Privacy mapping does not belong to the confirmed privacy aggregate.",
        );
      }
    }

    return { revision, records, mappings };
  }

  private requireRevisionRow(privacyRevisionId: string) {
    const row = this.connection.db
      .select()
      .from(privacyRevisions)
      .where(eq(privacyRevisions.privacyRevisionId, privacyRevisionId))
      .get();

    if (row === undefined) {
      throw new PersistenceError(
        "PERSISTENCE_NOT_FOUND",
        "Confirmed privacy revision was not found.",
      );
    }

    return row;
  }

  private tryReadExistingAggregate(
    privacyRevisionId: string,
  ): LocalConfirmedPrivacyAggregate | undefined {
    const revisionRow = this.connection.db
      .select()
      .from(privacyRevisions)
      .where(eq(privacyRevisions.privacyRevisionId, privacyRevisionId))
      .get();

    if (revisionRow === undefined) {
      return undefined;
    }

    const revision = privacyRevisionRowToDomain(revisionRow);
    const records = this.connection.db
      .select()
      .from(canonicalRecords)
      .where(eq(canonicalRecords.privacyRevisionId, privacyRevisionId))
      .orderBy(asc(canonicalRecords.sequence), asc(canonicalRecords.recordId))
      .all()
      .map((row) => canonicalRecordRowToDomain(row));
    const mappings = this.connection.db
      .select()
      .from(privacyMappings)
      .where(eq(privacyMappings.privacyRevisionId, privacyRevisionId))
      .orderBy(
        asc(privacyMappings.entityType),
        asc(privacyMappings.placeholder),
        asc(privacyMappings.mappingId),
      )
      .all()
      .map((row) => privacyMappingRowToDomain(row));

    if (records.length !== revision.record_count || mappings.length !== revision.mapping_count) {
      throw new PersistenceError(
        "PERSISTENCE_INTEGRITY_ERROR",
        "Existing confirmed privacy aggregate is incomplete or internally inconsistent.",
      );
    }

    return { revision, records, mappings };
  }

  private assertExistingAggregateMatches(
    requested: LocalConfirmedPrivacyAggregate,
    existing: LocalConfirmedPrivacyAggregate,
  ): void {
    if (!semanticEqual(requested.revision, existing.revision)) {
      throw new PersistenceError(
        "IMMUTABILITY_VIOLATION",
        "Privacy revision identity already exists with different immutable content.",
      );
    }

    if (!semanticEqual(requested.records, existing.records)) {
      throw new PersistenceError(
        "IMMUTABILITY_VIOLATION",
        "Canonical snapshot already exists with different immutable content.",
      );
    }

    if (!semanticEqual(requested.mappings, existing.mappings)) {
      throw new PersistenceError(
        "IMMUTABILITY_VIOLATION",
        "Privacy mapping snapshot already exists with different immutable content.",
      );
    }
  }
}
