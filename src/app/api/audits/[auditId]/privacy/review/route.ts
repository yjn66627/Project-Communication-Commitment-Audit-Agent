import { getSharedApplicationStore } from "../../../../../../server/application-store";
import { AuditPathSchema, ReviewCommandRequestSchema, toPrivacyReviewResponseDTO } from "../../../../../../server/http/http-dtos";
import { MAX_HTTP_JSON_BODY, readBoundedJson } from "../../../../../../server/http/bounded-json";
import { PrivacyReviewReadAdapter } from "../../../../../../application/privacy/privacy-review-read-adapter";
import { handleHttpRequest, methodNotAllowed } from "../../../../../../server/http/request-context";
import { HttpBoundaryError } from "../../../../../../server/http/local-origin-guard";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string }> };

export async function GET(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    const store = await getSharedApplicationStore();
    return { review: toPrivacyReviewResponseDTO(new PrivacyReviewReadAdapter(store.reviews).getSafe(auditId)) };
  });
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    const command = await readBoundedJson(request, ReviewCommandRequestSchema, MAX_HTTP_JSON_BODY);
    if (command.type === "FINALIZE_REVIEW_CANDIDATE") throw new HttpBoundaryError("INVALID_REQUEST");
    const store = await getSharedApplicationStore();
    store.reviews.apply(auditId, command);
    return { review: toPrivacyReviewResponseDTO(new PrivacyReviewReadAdapter(store.reviews).getSafe(auditId)) };
  });
}
