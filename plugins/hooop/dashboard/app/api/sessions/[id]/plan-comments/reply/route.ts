import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";
import { forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { body, error } = await parseJsonBody<{ requestId?: unknown; commentId?: unknown; body?: unknown }>(req, { maxBytes: 8 * 1024 });
  if (error) return error;
  const requestId = boundedString(body.requestId, 256);
  const commentId = boundedString(body.commentId, 256);
  const text = boundedString(body.body, 4096);
  if (!requestId || !commentId || !text) return errorResponse("missing requestId, commentId or body", 400);
  try {
    return Response.json(await client.addPlanReply(id, { requestId, commentId, body: text }, forwardedParticipant(req)));
  } catch (e: any) {
    return errorResponse(e?.message ?? "reply failed", typeof e?.status === "number" ? e.status : 500);
  }
}
