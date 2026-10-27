import { normalizeNfkc } from "./common.js";

const VISUAL_SEPARATORS = /[\s\-()]/gu;

export function normalizePhoneCandidate(value: string): string | null {
  const compact = normalizeNfkc(value).replace(VISUAL_SEPARATORS, "");
  if (/^1[3-9]\d{9}$/u.test(compact)) {
    return `+86${compact}`;
  }
  if (/^\+861[3-9]\d{9}$/u.test(compact)) {
    return compact;
  }
  if (/^\+[1-9]\d{7,14}$/u.test(compact)) {
    return compact;
  }
  return null;
}
