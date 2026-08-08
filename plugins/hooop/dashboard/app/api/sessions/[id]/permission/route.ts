import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";
import { forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REQUEST_ID_LEN = 256;
// Reject feedback is relayed to the model as the decision reason. Cap it well
// under the 8KB body limit; a plan critique doesn't need more.
const MAX_FEEDBACK_LEN = 4 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  const { body, error } = await parseJsonBody<{ requestId?: unknown; decision?: unknown; scope?: unknown; feedback?: unknown }>(
    req,
    { maxBytes: 8 * 1024 },
  );
  if (error) return error;

  const requestId = boundedString(body.requestId, MAX_REQUEST_ID_LEN);
  if (!requestId) {
    return errorResponse("missing required field: requestId", 400);
  }
  if (body.decision !== "allow" && body.decision !== "deny") {
    return errorResponse("decision must be 'allow' or 'deny'", 400);
  }
  const scope = body.scope === "always" ? "always" : "once";
  const feedback = boundedString(body.feedback, MAX_FEEDBACK_LEN) || undefined;

  try {
    const result = await client.respondToPermission(sessionId, requestId, body.decision, forwardedParticipant(req), scope, feedback);
    return Response.json(result);
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "permission response failed", status);
  }
}
