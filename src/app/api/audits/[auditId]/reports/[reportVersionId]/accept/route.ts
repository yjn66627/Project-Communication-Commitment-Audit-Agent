import { getSharedApplicationStore } from "../../../../../../../server/application-store";
import { AcceptReportRequestSchema, ReportPathSchema, toAcceptedReportResponseDTO } from "../../../../../../../server/http/http-dtos";
import { MAX_HTTP_JSON_BODY, readBoundedJson } from "../../../../../../../server/http/bounded-json";
import { handleHttpRequest, methodNotAllowed } from "../../../../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string; reportVersionId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId, reportVersionId } = ReportPathSchema.parse(await context.params);
    const body = await readBoundedJson(request, AcceptReportRequestSchema, MAX_HTTP_JSON_BODY);
    const store = await getSharedApplicationStore();
    const result = store.reports.accept(auditId, reportVersionId, body.expectedCanonicalDigest);
    return { outcome: result.outcome, report: toAcceptedReportResponseDTO(result.acceptance) };
  });
}
