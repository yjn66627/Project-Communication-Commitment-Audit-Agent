import { z } from "zod";
import type { PersistenceConnection } from "../../db/connection.js";
import { auditMetadata } from "../../db/schema.js";
import { ApplicationError } from "../errors.js";

export const DisplayNameSchema = z.string().trim().min(1).max(256);

/** Application metadata only. This adapter never writes Audit identity. */
export class AuditMetadataAdapter {
  #connection: PersistenceConnection;
  constructor(connection: PersistenceConnection) { this.#connection = connection; }

  insert(auditId: string, displayName: string, updatedAt: string): void {
    const result = DisplayNameSchema.safeParse(displayName);
    if (!result.success) throw new ApplicationError("INVALID_AUDIT_NAME", "Audit display name is required.");
    this.#connection.db.insert(auditMetadata).values({ auditId, displayName: result.data, updatedAt }).run();
  }
}
