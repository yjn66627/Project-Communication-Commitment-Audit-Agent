import { z } from "zod";
import { CanonicalRecordDraftSchema, type CanonicalRecordDraft } from "../../domain/schemas/canonical.js";
import { createRandomRecordId } from "../../shared/ids/random-ids.js";
import { ApplicationError, assertServerRuntime } from "../errors.js";

export const MAX_PASTE_BYTES = 256 * 1024;
const PasteInputSchema = z.object({
  text: z.string().min(1).max(MAX_PASTE_BYTES)
    .refine((text) => Buffer.byteLength(text, "utf8") <= MAX_PASTE_BYTES),
  sourceName: z.string().min(1).max(512).default("Pasted text"),
  author: z.string().min(1).max(256).nullable().default(null),
}).strict();

/** Raw, local and memory-only. This module has no persistence, logging or provider port. */
export function createPasteDraft(input: unknown): CanonicalRecordDraft {
  assertServerRuntime();
  const parsed = PasteInputSchema.safeParse(input);
  if (!parsed.success) throw new ApplicationError("INVALID_PASTE", "Paste input is invalid or exceeds the local memory limit.");
  return Object.freeze(CanonicalRecordDraftSchema.parse({
    record_id: createRandomRecordId(), source_type: "PASTE", source_name: parsed.data.sourceName,
    author: parsed.data.author, timestamp: null, content: parsed.data.text, sequence: 0,
  }));
}
