import { normalizeNfkc } from "./common.js";

const TRAILING_PROSE = /[.,;!?，。；！？]+$/u;

export function trimUrlTrailingProse(value: string): string {
  let result = value.replace(TRAILING_PROSE, "");
  while (result.endsWith(")")) {
    const opens = (result.match(/\(/gu) ?? []).length;
    const closes = (result.match(/\)/gu) ?? []).length;
    if (closes <= opens) break;
    result = result.slice(0, -1);
  }
  return result;
}

export function normalizeUrlCandidate(value: string): string | null {
  const normalized = normalizeNfkc(trimUrlTrailingProse(value));
  try {
    if (/^www\./iu.test(normalized)) {
      const parsed = new URL(`https://${normalized}`);
      if (!parsed.hostname.includes(".")) return null;
      const authority = parsed.port ? `${parsed.hostname.toLowerCase()}:${parsed.port}` : parsed.hostname.toLowerCase();
      return `www://${authority}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    const parsed = new URL(normalized);
    const protocol = parsed.protocol.toLowerCase();
    if (!["http:", "https:", "ftp:", "file:"].includes(protocol)) return null;
    parsed.protocol = protocol;
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((protocol === "http:" && parsed.port === "80") || (protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function urlContainsCredentialUserinfo(value: string): boolean {
  try {
    const normalized = normalizeNfkc(trimUrlTrailingProse(value));
    const parsed = /^www\./iu.test(normalized) ? new URL(`https://${normalized}`) : new URL(normalized);
    return parsed.password.length > 0 || (parsed.username.length > 0 && parsed.password.length > 0);
  } catch {
    return false;
  }
}
