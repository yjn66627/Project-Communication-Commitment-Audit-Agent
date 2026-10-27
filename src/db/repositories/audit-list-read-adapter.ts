import { asc, desc, eq } from "drizzle-orm";
import type { PersistenceConnection } from "../connection.js";
import { audits, auditMetadata } from "../schema.js";
import { SafeAuditViewSchema } from "../persistence/persistence-types.js";
import { DisplayNameSchema } from "../../application/audits/audit-metadata-adapter.js";
import { ApplicationError } from "../../application/errors.js";

export interface ApplicationAuditDTO {
  readonly auditId: string;
  readonly displayName: string;
  readonly createdAt: string;
}

export class AuditListReadAdapter {
  #connection: PersistenceConnection;
  constructor(connection: PersistenceConnection) { this.#connection = connection; }

  #rows(auditId?: string): readonly ApplicationAuditDTO[] {
    const query = this.#connection.db.select({
      auditId: audits.auditId, displayName: auditMetadata.displayName, createdAt: audits.createdAt,
    }).from(audits).leftJoin(auditMetadata, eq(audits.auditId, auditMetadata.auditId));
    const rows = (auditId === undefined ? query : query.where(eq(audits.auditId, auditId)))
      .orderBy(desc(audits.createdAt), asc(audits.auditId)).all();
    return Object.freeze(rows.map((row) => {
      const identity = SafeAuditViewSchema.safeParse({ audit_id: row.auditId, created_at: row.createdAt });
      const name = DisplayNameSchema.safeParse(row.displayName);
      if (!identity.success || !name.success) {
        throw new ApplicationError("AUDIT_METADATA_INTEGRITY", "Audit identity or metadata is incomplete.");
      }
      return Object.freeze({ auditId: identity.data.audit_id, displayName: name.data, createdAt: identity.data.created_at });
    }));
  }

  list(): readonly ApplicationAuditDTO[] { return this.#rows(); }
  get(auditId: string): ApplicationAuditDTO {
    const row = this.#rows(auditId)[0];
    if (!row) throw new ApplicationError("AUDIT_NOT_FOUND", "Audit was not found.");
    return row;
  }
}
