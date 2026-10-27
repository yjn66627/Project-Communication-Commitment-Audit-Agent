import { randomUUID } from "node:crypto";
import { mapSafeHttpError } from "./safe-http-error-mapper.js";
import { assertLocalRequestAllowed, isMutationMethod, HttpBoundaryError } from "./local-origin-guard.js";

export type RequestContext = Readonly<{ requestId: string }>;
export type HttpResult<T> = Readonly<{ body: T; status?: number }>;

export function jsonSuccess<T>(context: RequestContext, body: T, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", "X-Request-ID": context.requestId } });
}

export async function handleHttpRequest(request: Request, operation: (context: RequestContext) => Promise<HttpResult<unknown> | unknown>): Promise<Response> {
  const context = Object.freeze({ requestId: randomUUID() });
  try {
    assertLocalRequestAllowed(request, isMutationMethod(request.method));
    const result = await operation(context);
    if (isHttpResult(result)) return jsonSuccess(context, result.body, result.status ?? 200);
    return jsonSuccess(context, result);
  } catch (error) {
    if (error instanceof HttpBoundaryError && error.code === "METHOD_NOT_ALLOWED") {
      return errorResponse(context, error);
    }
    return errorResponse(context, error);
  }
}

export function httpResult<T>(body: T, status?: number): HttpResult<T> {
  return status === undefined ? { body } : { body, status };
}

/** Explicitly rejects CORS preflight without granting any cross-origin access. */
export function methodNotAllowed(request: Request): Response {
  const context = Object.freeze({ requestId: randomUUID() });
  try { assertLocalRequestAllowed(request, false); }
  catch (error) { return errorResponse(context, error); }
  return errorResponse(context, new HttpBoundaryError("METHOD_NOT_ALLOWED"));
}

function isHttpResult(value: unknown): value is HttpResult<unknown> {
  return typeof value === "object" && value !== null && "body" in value && Object.keys(value).every((key) => key === "body" || key === "status");
}

function errorResponse(context: RequestContext, error: unknown): Response {
  const mapped = mapSafeHttpError(error);
  return Response.json({ error: { code: mapped.code, message: mapped.message, request_id: context.requestId } }, {
    status: mapped.status,
    headers: { "Cache-Control": "no-store", "X-Request-ID": context.requestId },
  });
}
