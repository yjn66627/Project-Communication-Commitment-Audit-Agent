import { getSharedApplicationStore } from "../../../../../server/application-store";
import { AuditPathSchema, EmptyRequestSchema } from "../../../../../server/http/http-dtos";
import { MAX_HTTP_JSON_BODY, readBoundedJson } from "../../../../../server/http/bounded-json";
import { SafeRunHttpError } from "../../../../../server/http/safe-http-error-mapper";
import { handleHttpRequest, methodNotAllowed } from "../../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    await readBoundedJson(request, EmptyRequestSchema, MAX_HTTP_JSON_BODY, true);
    const store = await getSharedApplicationStore();
    const result = await store.runs.run({ auditId });
    if (result.status === "FAILED") throw new SafeRunHttpError(result.failureCategory ?? "PERSISTENCE_FAILURE");
    return { status: "COMPLETED", reportVersionId: result.context.reportVersionId, failureCategory: null };
  });
}
