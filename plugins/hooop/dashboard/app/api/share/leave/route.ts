import { NextRequest, NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import { participantOf, peerSessionId } from "@/lib/peer-auth";
import { leave } from "@/lib/presence";
import { PEER_COOKIE } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A peer deliberately leaves the shared session (the "Leave session" action).
 *
 * This is the SINGLE source of a durable `PeerLeft` transcript marker: only an
 * explicit leave produces one. (An accidental tab close or a backgrounded tab
 * merely dims the avatar and, eventually, drops it from the roster silently —
 * never a marker.) Being unambiguous, we act at once:
 *   1. drop THIS SCREEN from the presence roster;
 *   2. emit the `PeerLeft` transcript marker — but only if that was their last
 *      screen. A peer who joined from a laptop and a phone and then leaves on the
 *      phone has not left, and announcing it would tell the room something
 *      untrue (and, worse, tell the host to stop expecting them);
 *   3. clear the durable peer cookie on this device, so returning HERE requires
 *      the share link and the host's admit gate again (i.e. a real, gated rejoin
 *      — and a leaked link still faces a deny). Their other device keeps its own
 *      cookie: leaving on one screen is not a revocation, and a peer cannot
 *      revoke their own share anyway.
 *
 * Identity is taken from the middleware-injected (trusted) participant headers,
 * never from the client. `name` is a cosmetic marker label only.
 */
export async function POST(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind !== "peer") return errorResponse("forbidden", 403);

  const sessionId = peerSessionId(req);
  const { body } = await parseJsonBody<{ name?: unknown; viewerId?: unknown }>(req, { maxBytes: 4 * 1024 });
  const name = boundedString(body?.name, 80);
  const viewerId = boundedString(body?.viewerId, 64) ?? undefined;

  if (sessionId) {
    // Omitting viewerId drops every screen, which is the right reading of a
    // leave from a client too old to name its own — it can only have one.
    const { gone } = leave(sessionId, `peer:${who.shareId}`, viewerId);
    // Best-effort audit marker; a sandbox blip must not block the peer's exit.
    if (gone) {
      try {
        await client.peerLeave(sessionId, name, who.shareId);
      } catch { /* non-fatal */ }
    }
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set({ name: PEER_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
