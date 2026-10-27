import { getSharedApplicationStore } from "../../../../server/application-store";
import { AuditPathSchema, toAuditResponseDTO } from "../../../../server/http/http-dtos";
import { handleHttpRequest, methodNotAllowed } from "../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    const store = await getSharedApplicationStore();
    return { audit: toAuditResponseDTO(store.audits.open(auditId)) };
  });
}
