import { getSharedApplicationStore } from "../../../../../../../server/application-store";
import { ReportPathSchema, toAcceptedReportResponseDTO } from "../../../../../../../server/http/http-dtos";
import { handleHttpRequest, methodNotAllowed } from "../../../../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string; reportVersionId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId, reportVersionId } = ReportPathSchema.parse(await context.params);
    const store = await getSharedApplicationStore();
    return { report: toAcceptedReportResponseDTO(store.reports.getAccepted(auditId, reportVersionId)) };
  });
}
