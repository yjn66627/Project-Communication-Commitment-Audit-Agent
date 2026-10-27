import { getSharedApplicationStore } from "../../../../../server/application-store";
import { AuditPathSchema, toWorkflowStateResponseDTO } from "../../../../../server/http/http-dtos";
import { handleHttpRequest, methodNotAllowed } from "../../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    const store = await getSharedApplicationStore();
    return toWorkflowStateResponseDTO(store.workflow.get(auditId));
  });
}
