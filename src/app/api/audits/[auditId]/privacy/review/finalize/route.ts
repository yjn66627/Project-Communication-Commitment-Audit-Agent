import { getSharedApplicationStore } from "../../../../../../../server/application-store";
import { AuditPathSchema, EmptyRequestSchema } from "../../../../../../../server/http/http-dtos";
import { MAX_HTTP_JSON_BODY, readBoundedJson } from "../../../../../../../server/http/bounded-json";
import { handleHttpRequest, methodNotAllowed } from "../../../../../../../server/http/request-context";

export const runtime = "nodejs";
export const OPTIONS = methodNotAllowed;
type Context = { params: Promise<{ auditId: string }> };

export async function POST(request: Request, context: Context): Promise<Response> {
  return handleHttpRequest(request, async () => {
    const { auditId } = AuditPathSchema.parse(await context.params);
    await readBoundedJson(request, EmptyRequestSchema, MAX_HTTP_JSON_BODY, true);
    const store = await getSharedApplicationStore();
    const candidate = store.reviews.finalize(auditId);
    return {
      reviewCandidateId: candidate.reviewCandidateId,
      preview: candidate.sanitizedRecords.map((record) => ({
        sourceType: record.source_type,
        sourceName: record.sanitized_source_name,
        author: record.sanitized_author,
        timestamp: record.timestamp,
        content: record.sanitized_content,
        sequence: record.sequence,
      })),
    };
  });
}
