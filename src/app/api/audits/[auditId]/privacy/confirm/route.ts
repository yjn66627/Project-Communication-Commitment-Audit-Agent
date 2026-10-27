import { getSharedApplicationStore } from "../../../../../../server/application-store";
import { AuditPathSchema, ConfirmPrivacyRequestSchema } from "../../../../../../server/http/http-dtos";
import { MAX_HTTP_JSON_BODY, readBoundedJson } from "../../../../../../server/http/bounded-json";
import { handleHttpRequest, methodNotAllowed } from "../../../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    const body = await readBoundedJson(request, ConfirmPrivacyRequestSchema, MAX_HTTP_JSON_BODY);
    const store = await getSharedApplicationStore();
    const result = await store.confirmation.confirm({ auditId, reviewCandidateId: body.reviewCandidateId });
    return { auditId: result.audit_id, recordCount: result.record_count, mappingCount: result.mapping_count, confirmedAt: result.confirmed_at, idempotent: result.idempotent };
  });
}
