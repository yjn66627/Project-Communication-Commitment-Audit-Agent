import { detectPrivacy } from "../../privacy/detection/detector.js";
import type { SourceNamePolicyResult } from "../../privacy/detection/types.js";
import { createReviewSession } from "../../privacy/review/review-state.js";
import { applyReviewCommand } from "../../privacy/review/review-commands.js";
import type { ReviewCommand, ReviewSession } from "../../privacy/review/types.js";
import { buildSanitizedPreview } from "../../privacy/preview/preview-builder.js";
import { buildRevisionMappingSnapshot } from "../../privacy/pseudonymization/mapping-snapshot.js";
import type { SeedPrivacyMapping } from "../../privacy/pseudonymization/types.js";
import { createCandidateFreshnessContext, finalizeReviewCandidate } from "../../privacy/revision/candidate-fingerprint.js";
import type { CandidateSemanticStateInput, FinalizedReviewCandidate } from "../../privacy/revision/types.js";
import { createPasteDraft } from "../input/paste-adapter.js";
import { ApplicationError } from "../errors.js";

export const REVIEW_MEMORY_LIMITS = Object.freeze({ sessions: 8, perSessionBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, detections: 2048, seedMappings: 4096 });
interface MemoryReview {
  readonly session: ReviewSession;
  readonly candidate?: FinalizedReviewCandidate;
  readonly state?: CandidateSemanticStateInput;
  readonly bytes: number;
  confirming: boolean;
}

/** Local-only raw review state. Nothing in this class writes to persistence or calls a provider. */
export class PrivacyReviewService {
  #reviews = new Map<string, MemoryReview>();
  #ensureOpen: () => void;
  #requireAudit: (auditId: string) => void;
  #loadSeeds: (auditId: string) => readonly SeedPrivacyMapping[];
  constructor(ensureOpen: () => void, requireAudit: (auditId: string) => void, loadSeeds: (auditId: string) => readonly SeedPrivacyMapping[]) {
    this.#ensureOpen = ensureOpen; this.#requireAudit = requireAudit; this.#loadSeeds = loadSeeds;
  }

  #get(auditId: string): MemoryReview {
    this.#ensureOpen();
    const value = this.#reviews.get(auditId);
    if (!value) throw new ApplicationError("REVIEW_UNAVAILABLE", "The local review candidate is unavailable.");
    return value;
  }
  #set(auditId: string, value: Omit<MemoryReview, "bytes">): void {
    // Fail closed if an inherited command produces inconsistent entity/member identity.
    // Do not rewrite or repair DEV04 state at this application boundary.
    for (const decision of Object.values(value.session.decisions)) {
      if (decision.state !== "ACCEPTED" || decision.semantic_entity_id === null) continue;
      const entity = value.session.entities[decision.semantic_entity_id];
      if (!entity || entity.state === "MERGED_INTO" || !entity.member_detection_ids.includes(decision.detection_id)) {
        throw new ApplicationError("REVIEW_INTEGRITY_ERROR", "The review command produced inconsistent local entity identity.");
      }
    }
    for (const entity of Object.values(value.session.entities)) {
      if (entity.state === "MERGED_INTO") continue;
      if (entity.member_detection_ids.some((id) => value.session.decisions[id]?.semantic_entity_id !== entity.semantic_entity_id)) {
        throw new ApplicationError("REVIEW_INTEGRITY_ERROR", "The review command produced inconsistent local entity membership.");
      }
    }
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    const otherBytes = [...this.#reviews.entries()].reduce((sum, [id, entry]) => sum + (id === auditId ? 0 : entry.bytes), 0);
    if (bytes > REVIEW_MEMORY_LIMITS.perSessionBytes || otherBytes + bytes > REVIEW_MEMORY_LIMITS.totalBytes || (!this.#reviews.has(auditId) && this.#reviews.size >= REVIEW_MEMORY_LIMITS.sessions)) {
      throw new ApplicationError("REVIEW_MEMORY_LIMIT", "The local privacy review memory limit was reached.");
    }
    this.#reviews.set(auditId, { ...value, bytes });
  }
  #editable(auditId: string): MemoryReview {
    const value = this.#get(auditId);
    if (value.confirming) throw new ApplicationError("REVIEW_CONFIRMING", "The local review is being confirmed.");
    return value;
  }

  beginPaste(auditId: string, input: unknown): void {
    this.#ensureOpen(); this.#requireAudit(auditId);
    if (this.#reviews.has(auditId)) this.#editable(auditId);
    const record = createPasteDraft(input);
    const detection = detectPrivacy(record);
    const seeds = this.#loadSeeds(auditId);
    if (detection.resolved.length > REVIEW_MEMORY_LIMITS.detections || seeds.length > REVIEW_MEMORY_LIMITS.seedMappings) throw new ApplicationError("REVIEW_MEMORY_LIMIT", "The local privacy review memory limit was reached.");
    const policies: Record<string, SourceNamePolicyResult> = { [record.record_id]: detection.source_name_policy };
    const session = createReviewSession({ auditId, records: [record], detections: detection.resolved, sourceNamePolicies: policies, seedMappings: seeds });
    this.#set(auditId, { session, confirming: false });
  }

  /** Explicit high-sensitivity local read. This is not an ordinary DTO/log/export. */
  getSessionLocal(auditId: string): ReviewSession { return this.#get(auditId).session; }

  apply(auditId: string, command: ReviewCommand): void {
    const old = this.#editable(auditId);
    const session = applyReviewCommand(Object.freeze({ ...old.session, stage: "REVIEW_REQUIRED" }), command);
    if (!session) throw new ApplicationError("INVALID_REVIEW_COMMAND", "The review command is invalid.");
    this.#set(auditId, { session, confirming: false }); // every edit invalidates the previous finalized candidate
  }

  finalize(auditId: string) {
    const old = this.#editable(auditId);
    const session = applyReviewCommand(old.session, { type: "FINALIZE_REVIEW_CANDIDATE" });
    const preview = buildSanitizedPreview(session);
    const state: CandidateSemanticStateInput = Object.freeze({ audit_id: auditId, raw_records: Object.freeze(Object.values(session.records)), resolved_detections: Object.freeze(Object.values(session.detections)), review_decisions: Object.freeze(Object.values(session.decisions)), mapping_plan: preview.mapping_plan, sanitized_preview_records: preview.preview_records });
    const candidate = finalizeReviewCandidate({ ...state, revision_mapping_snapshot: buildRevisionMappingSnapshot(preview.mapping_plan), local_mapping_vault: preview.mapping_plan.mappings });
    this.#set(auditId, { session, state, candidate, confirming: false });
    return Object.freeze({ reviewCandidateId: candidate.review_candidate_id, sanitizedRecords: candidate.sanitized_preview_records });
  }

  beginConfirmation(auditId: string, candidateId: string): FinalizedReviewCandidate {
    const value = this.#editable(auditId);
    if (!value.candidate || value.candidate.review_candidate_id !== candidateId) throw new ApplicationError("CANDIDATE_STALE", "The local review candidate is no longer current.");
    value.confirming = true;
    return value.candidate;
  }
  currentContext(auditId: string) {
    this.#ensureOpen();
    const state = this.#reviews.get(auditId)?.state;
    return state ? createCandidateFreshnessContext(state) : null;
  }
  finishConfirmation(auditId: string, candidateId: string, committed: boolean): void {
    const value = this.#reviews.get(auditId);
    if (value?.candidate?.review_candidate_id !== candidateId) return;
    if (committed) this.#reviews.delete(auditId); // release raw state once the aggregate is confirmed
    else value.confirming = false;
  }
  discard(auditId: string): void { this.#editable(auditId); this.#reviews.delete(auditId); }
  clearAll(): void { this.#reviews.clear(); }
  get memoryUsage() {
    return Object.freeze({ sessions: this.#reviews.size, bytes: [...this.#reviews.values()].reduce((sum, entry) => sum + entry.bytes, 0) });
  }
}
