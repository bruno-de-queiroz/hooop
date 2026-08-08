import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody } from "@/lib/api-helpers";
import { forwardedParticipant, canAccessSession } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * This session's previews.
 *
 * Deliberately an ordinary session-scoped read: it is what lets a peer who
 * joins AFTER a preview was shared see it on first load, with no re-approval
 * and no host action. The sandbox re-checks scope and capability.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("out of session scope", 403);
  try {
    return Response.json(await client.listPreviews(sessionId, forwardedParticipant(req)));
  } catch (e: any) {
    return errorResponse(e?.message ?? "could not list previews", typeof e?.status === "number" ? e.status : 500);
  }
}

/**
 * Start a preview for this session from the dashboard, so the operator does not
 * have to ask the agent to do it. The sandbox owns spec validation, slot
 * accounting and the capability check (host or full peer) — this only forwards.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("out of session scope", 403);
  const { body, error } = await parseJsonBody<Record<string, unknown>>(req, { maxBytes: 8 * 1024 });
  if (error) return error;
  try {
    return Response.json(await client.startPreview(sessionId, body, forwardedParticipant(req)));
  } catch (e: any) {
    return errorResponse(e?.message ?? "could not start the preview", typeof e?.status === "number" ? e.status : 500);
  }
}

