import { z } from "zod";
import type { PersistenceConnection } from "../../db/connection.js";
import { AuditRepository } from "../../db/repositories/audit-repository.js";
import { AuditListReadAdapter, type ApplicationAuditDTO } from "../../db/repositories/audit-list-read-adapter.js";
import { createAuditId, createRevisionSalt } from "../../shared/ids/random-ids.js";
import { IsoUtcTextSchema } from "../../db/persistence/persistence-types.js";
import { ApplicationError, assertServerRuntime } from "../errors.js";
import { AuditMetadataAdapter, DisplayNameSchema } from "./audit-metadata-adapter.js";

const CreateAuditSchema = z.object({ displayName: DisplayNameSchema }).strict();

export class AuditApplicationService {
  #connection: PersistenceConnection;
  #repository: AuditRepository;
  #metadata: AuditMetadataAdapter;
  #read: AuditListReadAdapter;
  #ensureOpen: () => void;
  #clock: () => string;

  constructor(connection: PersistenceConnection, ensureOpen: () => void, clock: () => string = () => new Date().toISOString()) {
    assertServerRuntime();
    this.#connection = connection;
    this.#repository = new AuditRepository(connection);
    this.#metadata = new AuditMetadataAdapter(connection);
    this.#read = new AuditListReadAdapter(connection);
    this.#ensureOpen = ensureOpen;
    this.#clock = clock;
  }

  create(input: unknown): ApplicationAuditDTO {
    this.#ensureOpen();
    const parsed = CreateAuditSchema.safeParse(input);
    const time = IsoUtcTextSchema.safeParse(this.#clock());
    if (!parsed.success || !time.success) throw new ApplicationError("INVALID_AUDIT_INPUT", "Audit name or server clock is invalid.");
    const auditId = createAuditId();
    const salt = createRevisionSalt();
    try {
      return this.#connection.transaction(() => {
        this.#repository.createAudit({ audit_id: auditId, revision_salt: Buffer.from(salt).toString("base64url"), created_at: time.data });
        this.#metadata.insert(auditId, parsed.data.displayName, time.data);
        return this.#read.get(auditId);
      });
    } catch {
      throw new ApplicationError("AUDIT_CREATE_FAILED", "Audit creation failed atomically.");
    } finally { salt.fill(0); }
  }

  list(): readonly ApplicationAuditDTO[] {
    this.#ensureOpen();
    const result = this.#read.list();
    for (const row of result) this.#repository.getAuditLocalIdentity(row.auditId);
    return result;
  }

  open(auditId: string): ApplicationAuditDTO {
    this.#ensureOpen();
    this.#repository.getAuditLocalIdentity(auditId); // frozen strict salt validation; no regeneration
    this.#repository.getAuditById(auditId);
    return this.#read.get(auditId);
  }
}
