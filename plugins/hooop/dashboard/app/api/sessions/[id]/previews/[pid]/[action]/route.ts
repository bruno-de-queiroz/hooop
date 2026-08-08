import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { forwardedParticipant, canAccessSession, peerCapabilityOf, isPeer } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The only actions this route serves. An allowlist rather than a passthrough:
 * the segment is user-controlled and is concatenated into the sandbox path, so
 * anything not named here must 404 before it reaches the socket.
 *
 * Sibling STATIC segments (`logs/`, `share/`, `link/`) take precedence over
 * this dynamic one in the App Router, so they are unaffected by it.
 */
const ACTIONS = new Set(["stop", "restart", "rebuild"]);

/**
 * Act on a preview: stop, restart (respawn `run`) or rebuild (re-run every
 * setup step, then respawn).
 *
 * Host or a full-access peer. This is the first-line gate — the sandbox
 * enforces the same rule authoritatively and additionally scopes the preview to
 * this session, so a `drive` peer who forged past here still gets a 403 there.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pid: string; action: string }> },
) {
  const { id: sessionId, pid, action } = await params;
  if (!ACTIONS.has(action)) return errorResponse("unknown preview action", 404);
  if (!canAccessSession(req, sessionId)) return errorResponse("out of session scope", 403);
  if (isPeer(req) && peerCapabilityOf(req) !== "full") {
    return errorResponse("your share can view this preview, but only the host or a full-access peer can change it", 403);
  }

  try {
    const result = await client.previewAction(
      sessionId, pid, action as "stop" | "restart" | "rebuild", forwardedParticipant(req),
    );
    return Response.json(result);
  } catch (e: any) {
    return errorResponse(e?.message ?? `preview ${action} failed`, typeof e?.status === "number" ? e.status : 500);
  }
}
