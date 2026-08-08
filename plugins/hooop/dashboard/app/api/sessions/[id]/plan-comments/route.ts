import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";
import { forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET  → list shared comments for a plan review (?requestId=…). Also returns
//        `you` (the caller's author) so the client shows edit/remove only on
//        its own comments.
// POST → add a comment. Host + peers may author (attribution from the peer).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const requestId = new URL(req.url).searchParams.get("requestId");
  if (!requestId) return errorResponse("missing requestId", 400);
  try {
    return Response.json(await client.listPlanComments(id, requestId, forwardedParticipant(req)));
  } catch (e: any) {
    return errorResponse(e?.message ?? "plan-comments list failed", typeof e?.status === "number" ? e.status : 500);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { body, error } = await parseJsonBody<{ requestId?: unknown; quote?: unknown; offset?: unknown; length?: unknown; body?: unknown }>(
    req,
    { maxBytes: 8 * 1024 },
  );
  if (error) return error;
  const requestId = boundedString(body.requestId, 256);
  const text = boundedString(body.body, 4096);
  if (!requestId || !text) return errorResponse("missing requestId or body", 400);
  try {
    const result = await client.addPlanComment(
      id,
      {
        requestId,
        body: text,
        quote: boundedString(body.quote, 400) || "",
        offset: typeof body.offset === "number" ? body.offset : 0,
        length: typeof body.length === "number" ? body.length : 0,
      },
      forwardedParticipant(req),
    );
    return Response.json(result);
  } catch (e: any) {
    return errorResponse(e?.message ?? "plan-comments add failed", typeof e?.status === "number" ? e.status : 500);
  }
}
