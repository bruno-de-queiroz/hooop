import { NextRequest } from "next/server";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import { participantOf, forwardedParticipant, canAccessSession } from "@/lib/peer-auth";
import { heartbeat, leave, listPresence } from "@/lib/presence";
import { client } from "@/lib/sandbox-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  sessionId?: string;
  name?: string;
  typing?: boolean;
  leaving?: boolean;
  /**
   * Which SCREEN is beating — one browser tab, not one person.
   *
   * Client-supplied and NOT trusted for identity (that comes from the middleware
   * header, as ever); this only sub-divides the caller's own presence row. The
   * worst a forged value does is affect another of your own tabs, and lying that
   * you are two tabs when you are one buys nothing: presence grants no access.
   */
  viewerId?: string;
  /** Whether the viewer's tab is in the foreground (document.visibilityState).
   * Absent → treated as active. Drives the `away` (dimmed) presence state. */
  active?: boolean;
}

/**
 * Read-only roster, backing the composer's `@peer` mention autocomplete.
 *
 * Separate from the POST on purpose: that one ASSERTS presence (and relays the
 * beat to the sandbox), so using it to populate a dropdown would make merely
 * opening the autocomplete claim the viewer is here and suppress their own
 * notifications. This one only reads.
 *
 * Stricter than the POST about which session it will answer for, because it
 * discloses the other participants' display names rather than just recording
 * the caller's own.
 */
export async function GET(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);

  const sessionId = new URL(req.url).searchParams.get("sessionId");
  if (!sessionId) return errorResponse("missing required query param: sessionId", 400);
  if (!canAccessSession(req, sessionId)) return errorResponse("forbidden", 403);

  // `me` so the caller can drop itself from the list without matching on a
  // display name, which two participants are free to share.
  const me = who.kind === "host" ? "host" : `peer:${who.shareId}`;
  return Response.json({ participants: listPresence(sessionId), me });
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
  const viewerId = boundedString(body.viewerId, 64) ?? undefined;
  if (body.leaving) {
    leave(sessionId, participantId, viewerId);
  } else {
    heartbeat({ sessionId, participantId, viewerId, name, kind, typing: !!body.typing, active });
  }

  // Relay to the sandbox, which can't see this registry (presence is
  // dashboard-local) but needs it to avoid notifying someone about the session
  // already on their screen. Reusing this beat rather than having the browser
  // run a second one keeps a single source of truth for "who is here".
  //
  // Best-effort and deliberately not awaited into the response: presence is UI
  // awareness, and a sandbox blip must not make the roster stop updating.
  void client
    .pushPresence(sessionId, active && !body.leaving, forwardedParticipant(req), viewerId)
    .catch(() => { /* non-fatal: the beat just ages out and we notify */ });

  // `me` so the viewer can find itself in the roster by id rather than by
  // display name, which two participants are free to share.
  return Response.json({ participants: listPresence(sessionId), me: participantId });
}
