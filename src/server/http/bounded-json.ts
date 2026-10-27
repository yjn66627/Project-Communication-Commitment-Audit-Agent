import { z } from "zod";

export const MAX_HTTP_JSON_BODY = 16 * 1024;
export const MAX_HTTP_PASTE_BODY = 1024 * 1024;

export type BoundedJsonErrorCode = "INVALID_REQUEST" | "PAYLOAD_TOO_LARGE";

export class BoundedJsonError extends Error {
  constructor(readonly code: BoundedJsonErrorCode) {
    super("The request body is invalid or too large.");
    this.name = "BoundedJsonError";
  }
}

/** Reads a bounded stream without Request.json() and stops once the cap is crossed. */
export async function readBoundedJson<T>(request: Request, schema: z.ZodType<T>, maxBytes = MAX_HTTP_JSON_BODY, allowEmpty = false): Promise<T> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/u.test(declared)) throw new BoundedJsonError("INVALID_REQUEST");
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes)) throw new BoundedJsonError("INVALID_REQUEST");
    if (declaredBytes > maxBytes) {
      await request.body?.cancel().catch(() => undefined);
      throw new BoundedJsonError("PAYLOAD_TOO_LARGE");
    }
  }

  if (!request.body) {
    if (allowEmpty) return parseSchema({}, schema);
    throw new BoundedJsonError("INVALID_REQUEST");
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BoundedJsonError("PAYLOAD_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (declared !== null && Number(declared) !== total) throw new BoundedJsonError("INVALID_REQUEST");
  if (total === 0 && allowEmpty) return parseSchema({}, schema);

  try {
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return parseSchema(JSON.parse(text) as unknown, schema);
  } catch (error) {
    if (error instanceof BoundedJsonError) throw error;
    throw new BoundedJsonError("INVALID_REQUEST");
  }
}

function parseSchema<T>(value: unknown, schema: z.ZodType<T>): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BoundedJsonError("INVALID_REQUEST");
  return parsed.data;
}
