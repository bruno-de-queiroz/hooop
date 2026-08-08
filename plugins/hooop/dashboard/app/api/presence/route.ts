import { NextRequest } from "next/server";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import { participantOf, forwardedParticipant } from "@/lib/peer-auth";
import { heartbeat, leave, listPresence } from "@/lib/presence";
import { client } from "@/lib/sandbox-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  sessionId?: string;
  name?: string;
  typing?: boolean;
  leaving?: boolean;
  /** Whether the viewer's tab is in the foreground (document.visibilityState).
   * Absent → treated as active. Drives the `away` (dimmed) presence state. */
  active?: boolean;
}

/**
 * Presence heartbeat for a shared session. The participant identity comes from
 * the middleware-injected (trusted) header; the display name comes from the
 * client (a peer's chosen name / the host label) — a cosmetic label only.
 */
export async function POST(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);

  const { body, error } = await parseJsonBody<Body>(req, { maxBytes: 4 * 1024 });
  if (error) return error;
  const sessionId = boundedString(body.sessionId, 256);
  if (!sessionId) return errorResponse("missing required field: sessionId", 400);

  const participantId = who.kind === "host" ? "host" : `peer:${who.shareId}`;
  const kind = who.kind;
  const defaultName = kind === "host" ? "Host" : "Guest";
  const name = (boundedString(body.name, 80) ?? defaultName).slice(0, 80);

  const active = body.active !== false;
  if (body.leaving) {
    leave(sessionId, participantId);
  } else {
    heartbeat({ sessionId, participantId, name, kind, typing: !!body.typing, active });
  }

  // Relay to the sandbox, which can't see this registry (presence is
  // dashboard-local) but needs it to avoid notifying someone about the session
  // already on their screen. Reusing this beat rather than having the browser
  // run a second one keeps a single source of truth for "who is here".
  //
  // Best-effort and deliberately not awaited into the response: presence is UI
  // awareness, and a sandbox blip must not make the roster stop updating.
  void client
    .pushPresence(sessionId, active && !body.leaving, forwardedParticipant(req))
    .catch(() => { /* non-fatal: the beat just ages out and we notify */ });

  return Response.json({ participants: listPresence(sessionId) });
}
