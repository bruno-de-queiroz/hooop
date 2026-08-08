import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAccessSession, forwardedParticipant } from "@/lib/peer-auth";
import { peerShareGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("forbidden: out of session scope", 403);
  const revoked = await peerShareGuard(req);
  if (revoked) return revoked;
  return Response.json(await client.getSessionModel(sessionId));
}

/** Switch the session's model (the composer's `/model <alias>`). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  const body = (await req.json().catch(() => null)) as { model?: unknown } | null;
  const model = typeof body?.model === "string" ? body.model.trim() : "";
  if (!model) return errorResponse("missing required field: model", 400);
  try {
    const res = await client.setSessionModel(sessionId, model, forwardedParticipant(req));
    return Response.json(res);
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "model switch failed", status);
  }
}
