import { getSharedApplicationStore } from "../../../server/application-store";
import { CreateAuditRequestSchema, toAuditResponseDTO } from "../../../server/http/http-dtos";
import { MAX_HTTP_JSON_BODY, readBoundedJson } from "../../../server/http/bounded-json";
import { handleHttpRequest, httpResult, methodNotAllowed } from "../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;

export async function GET(request: Request): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const store = await getSharedApplicationStore();
    return { audits: store.audits.list().map(toAuditResponseDTO) };
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const body = await readBoundedJson(request, CreateAuditRequestSchema, MAX_HTTP_JSON_BODY);
    const store = await getSharedApplicationStore();
    return httpResult({ audit: toAuditResponseDTO(store.audits.create(body)) }, 201);
  });
}
