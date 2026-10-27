import { ProviderTransportError } from "./errors.js";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 90_000;
export const MIN_PROVIDER_TIMEOUT_MS = 1_000;
export const MAX_PROVIDER_TIMEOUT_MS = 120_000;

export type ProviderRuntimeConfig = Readonly<{
  provider_name: string;
  base_url: string;
  model: string;
  api_key: string;
  timeout_ms: number;
}>;

export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

function requireNonEmpty(value: string | undefined): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ProviderTransportError("CONFIG_MISSING");
  }
  return value.trim();
}

function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProviderTransportError("CONFIG_INVALID");
  }

  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new ProviderTransportError("CONFIG_INVALID");
  }

  const pathname = parsed.pathname.replace(/\/+$/u, "");
  if (pathname.toLowerCase().endsWith("/chat/completions")) {
    throw new ProviderTransportError("CONFIG_INVALID");
  }

  parsed.pathname = pathname.length === 0 ? "/" : pathname;
  return parsed.toString().replace(/\/$/u, "");
}

export function createProviderRuntimeConfig(input: Readonly<{
  provider_name?: string;
  base_url: string;
  model: string;
  api_key: string;
  timeout_ms?: number;
}>): ProviderRuntimeConfig {
  const timeoutMs = input.timeout_ms ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < MIN_PROVIDER_TIMEOUT_MS ||
    timeoutMs > MAX_PROVIDER_TIMEOUT_MS
  ) {
    throw new ProviderTransportError("CONFIG_INVALID");
  }

  const providerName = input.provider_name?.trim() || "openai-compatible";
  const model = requireNonEmpty(input.model);
  const apiKey = requireNonEmpty(input.api_key);
  const baseUrl = normalizeBaseUrl(requireNonEmpty(input.base_url));

  return Object.freeze({
    provider_name: providerName,
    base_url: baseUrl,
    model,
    api_key: apiKey,
    timeout_ms: timeoutMs,
  });
}

export function readProviderRuntimeConfig(
  env: ProviderEnvironment = process.env,
): ProviderRuntimeConfig {
  return createProviderRuntimeConfig({
    provider_name: env.AUDIT_PROVIDER_NAME,
    base_url: requireNonEmpty(env.AUDIT_PROVIDER_BASE_URL),
    model: requireNonEmpty(env.AUDIT_PROVIDER_MODEL),
    api_key: requireNonEmpty(env.AUDIT_PROVIDER_API_KEY),
  });
}

export function buildChatCompletionsEndpoint(config: ProviderRuntimeConfig): string {
  return `${config.base_url.replace(/\/+$/u, "")}/chat/completions`;
}
