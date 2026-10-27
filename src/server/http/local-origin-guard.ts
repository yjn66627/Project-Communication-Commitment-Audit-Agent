import { HttpBoundaryCode } from "./http-dtos.js";

export class HttpBoundaryError extends Error {
  constructor(readonly code: HttpBoundaryCode) {
    super("The local HTTP request was rejected.");
    this.name = "HttpBoundaryError";
  }
}

export function isMutationMethod(method: string): boolean {
  return ["POST", "PATCH", "PUT", "DELETE"].includes(method.toUpperCase());
}

export function assertLocalRequestAllowed(request: Request, mutation: boolean): void {
  const host = request.headers.get("host");
  const hostAuthority = parseLoopbackAuthority(host);
  if (!hostAuthority) throw new HttpBoundaryError("LOCAL_ACCESS_REQUIRED");
  if (!mutation) return;

  const origin = request.headers.get("origin");
  if (origin !== null) {
    let parsed: URL;
    try { parsed = new URL(origin); } catch { throw new HttpBoundaryError("LOCAL_ACCESS_REQUIRED"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new HttpBoundaryError("LOCAL_ACCESS_REQUIRED");
    }
    const originAuthority = parseLoopbackAuthority(parsed.host);
    // Next may reconstruct URL authority; client authority is the validated Host header.
    // The URL contributes only its scheme, never its hostname or port.
    const requestUrl = safeRequestUrl(request);
    if (!originAuthority || !requestUrl || parsed.protocol !== requestUrl.protocol ||
        canonicalAuthority(originAuthority, parsed.protocol) !== canonicalAuthority(hostAuthority, parsed.protocol)) {
      throw new HttpBoundaryError("LOCAL_ACCESS_REQUIRED");
    }
  } else if (["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"].some((name) => request.headers.has(name))) {
    throw new HttpBoundaryError("LOCAL_ACCESS_REQUIRED");
  }

  const contentType = request.headers.get("content-type");
  if (!contentType || !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/iu.test(contentType)) {
    throw new HttpBoundaryError("INVALID_REQUEST");
  }
}

function safeRequestUrl(request: Request): URL | null {
  try {
    const url = new URL(request.url);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}

type LoopbackAuthority = Readonly<{ hostname: string; port?: number }>;

function parseLoopbackAuthority(value: string | null): LoopbackAuthority | null {
  if (!value) return null;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::([0-9]{1,5}))?$/iu.exec(value);
  if (!match) return null;
  const host = match[1]!.toLowerCase();
  const port = match[2];
  if (port !== undefined) {
    const number = Number(port);
    if (number < 1 || number > 65535) return null;
  }
  return port === undefined ? { hostname: host } : { hostname: host, port: Number(port) };
}

function canonicalAuthority(authority: LoopbackAuthority, protocol: string): string {
  const port = authority.port ?? (protocol === "https:" ? 443 : 80);
  return `${authority.hostname}:${port}`;
}
