import { getSharedApplicationStore } from "../../../../../server/application-store";
import { PasteRequestSchema, AuditPathSchema, toPrivacyReviewResponseDTO } from "../../../../../server/http/http-dtos";
import { MAX_HTTP_PASTE_BODY, readBoundedJson } from "../../../../../server/http/bounded-json";
import { PrivacyReviewReadAdapter } from "../../../../../application/privacy/privacy-review-read-adapter";
import { handleHttpRequest, httpResult, methodNotAllowed } from "../../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    const body = await readBoundedJson(request, PasteRequestSchema, MAX_HTTP_PASTE_BODY);
    const store = await getSharedApplicationStore();
    store.reviews.beginPaste(auditId, body);
    const review = new PrivacyReviewReadAdapter(store.reviews).getSafe(auditId);
    return httpResult({ review: toPrivacyReviewResponseDTO(review) }, 201);
  });
}
