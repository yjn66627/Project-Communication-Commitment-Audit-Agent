import { createHash } from "node:crypto";

export function createSafeSourceLabel(auditId: string, recordId: string): string {
  const hash = createHash("sha256");
  hash.update("source-label-v1\0", "utf8");
  hash.update(auditId, "utf8");
  hash.update("\0", "utf8");
  hash.update(recordId, "utf8");
  return `SOURCE_${hash.digest("hex").slice(0, 12).toUpperCase()}`;
}
