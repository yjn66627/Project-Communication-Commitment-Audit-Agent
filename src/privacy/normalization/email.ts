import { normalizeNfkc } from "./common.js";

export function normalizeEmailCandidate(value: string): string | null {
  const normalized = normalizeNfkc(value);
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return null;
  }
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1).toLowerCase();
  return `${local}@${domain}`;
}
