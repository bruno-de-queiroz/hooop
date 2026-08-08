import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";
import { forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Remove a comment. Author-scoped: the sandbox returns 403 for non-authors.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { body, error } = await parseJsonBody<{ requestId?: unknown; commentId?: unknown }>(req, { maxBytes: 4 * 1024 });
  if (error) return error;
  const requestId = boundedString(body.requestId, 256);
  const commentId = boundedString(body.commentId, 256);
  if (!requestId || !commentId) return errorResponse("missing requestId or commentId", 400);
  try {
    return Response.json(await client.removePlanComment(id, { requestId, commentId }, forwardedParticipant(req)));
  } catch (e: any) {
    return errorResponse(e?.message ?? "remove failed", typeof e?.status === "number" ? e.status : 500);
  }
}
