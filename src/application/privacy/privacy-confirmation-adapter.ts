import { z } from "zod";
import { AuditIdSchema } from "../../domain/schemas/base.js";
import { AuditRepository } from "../../db/repositories/audit-repository.js";
import { PrivacyRepository } from "../../db/repositories/privacy-repository.js";
import { RevisionSaltTextSchema } from "../../db/persistence/persistence-types.js";
import { PrivacyConfirmationService } from "../../privacy/revision/confirmation-service.js";
import type { SafeConfirmationResult } from "../../privacy/revision/types.js";
import { ApplicationError } from "../errors.js";
import { PrivacyReviewService } from "./privacy-review-service.js";

const ConfirmationRequestSchema = z.object({ auditId: AuditIdSchema, reviewCandidateId: z.string().regex(/^rcand_[0-9a-f]{64}$/) }).strict();

export class PrivacyConfirmationAdapter {
  #audits: AuditRepository;
  #service: PrivacyConfirmationService;
  #reviews: PrivacyReviewService;
  #ensureOpen: () => void;
  #pending = new Set<Promise<SafeConfirmationResult>>();
  constructor(audits: AuditRepository, privacy: PrivacyRepository, reviews: PrivacyReviewService, ensureOpen: () => void) {
    this.#audits = audits; this.#reviews = reviews; this.#ensureOpen = ensureOpen;
    this.#service = new PrivacyConfirmationService({
      getConfirmedPrivacyAggregateLocal: (id) => { ensureOpen(); return privacy.getConfirmedPrivacyAggregateLocal(id); },
      saveConfirmedPrivacyAggregate: (input) => { ensureOpen(); return privacy.saveConfirmedPrivacyAggregate(input); },
    });
  }

  async confirm(input: unknown): Promise<SafeConfirmationResult> {
    this.#ensureOpen();
    const parsed = ConfirmationRequestSchema.safeParse(input);
    if (!parsed.success) throw new ApplicationError("INVALID_CONFIRMATION", "The confirmation request is invalid.");
    const { auditId, reviewCandidateId } = parsed.data;
    const identity = this.#audits.getAuditLocalIdentity(auditId);
    const encoded = RevisionSaltTextSchema.safeParse(identity.revision_salt);
    if (!encoded.success) throw new ApplicationError("INVALID_REVISION_SALT", "Audit revision salt is invalid.");
    const salt = Buffer.from(encoded.data, "base64url");
    let committed = false;
    let candidate;
    try { candidate = this.#reviews.beginConfirmation(auditId, reviewCandidateId); }
    catch (error: unknown) { salt.fill(0); throw error; }
    const operation = this.#service.confirm({ candidate, revisionSalt: salt, currentContext: () => {
      this.#ensureOpen();
      const current = this.#audits.getAuditLocalIdentity(auditId);
      if (current.revision_salt !== encoded.data) throw new ApplicationError("INVALID_REVISION_SALT", "Audit identity changed during confirmation.");
      return this.#reviews.currentContext(auditId);
    } });
    this.#pending.add(operation);
    try { const result = await operation; committed = true; return result; }
    finally { salt.fill(0); this.#pending.delete(operation); this.#reviews.finishConfirmation(auditId, reviewCandidateId, committed); }
  }
  async drain(): Promise<void> { await Promise.allSettled([...this.#pending]); }
}
