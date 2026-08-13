import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { participantOf } from "@/lib/peer-auth";
import { signPeerToken, peerSigningSecret } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Re-derive the caller's OWN share link, so a peer can carry on this session on
 * a second device without asking the host for anything.
 *
 * This closes a gap that was invisible from the host's side. Redeeming the same
 * link twice already works and already keeps identity intact — the share id IS
 * the identity, so the second device is the same person with the same name,
 * handle and capability, and `joinedBefore` exists precisely to call that a
 * rejoin. The peer simply had no way to GET their link again: the join page
 * strips the token from the URL the moment it is used (rightly — it is a
 * credential), and the existing re-derive route is gated on admit rights, so a
 * `drive` or `spectate` peer could not reach even their own.
 *
 * Scoped to the caller's own share, taken from the trusted middleware header, so
 * this cannot be turned into a way to enumerate or re-mint anybody else's link.
 * The host doesn't need it (they have the share list) and gets a 403 rather than
 * a confusing empty answer.
 *
 * Re-signing is safe and deterministic for the same reason /api/share/[id]/link
 * relies on: the token is stateless, so signing the same fields off the stored
 * record reproduces the identical, still-valid token. No new grant is created —
 * that is the whole point of the request.
 */
export async function GET(req: Request) {
  const who = participantOf(req);
  if (who.kind !== "peer") return errorResponse("forbidden", 403);

  const secret = peerSigningSecret();
  if (!secret) return errorResponse("sharing is not configured", 503);

  let record;
  try {
    record = await client.validateShare(who.shareId, {});
  } catch {
    record = null;
  }
  // Revoked mid-session, or the tunnel restarted under them. Either way the link
  // they'd be handed is dead, so say nothing useful.
  if (!record) return errorResponse("your access is no longer valid", 404);

  const peerToken = await signPeerToken(
    {
      sid: record.shareId,
      ses: record.sessionId,
      cap: record.capability,
      host: record.publicHost,
      name: record.peerName,
      ...(record.expiresAt ? { exp: record.expiresAt } : {}),
    },
    secret,
  );

  return Response.json({
    link: `https://${record.publicHost}/join/${encodeURIComponent(record.shareId)}#k=${peerToken}`,
    capability: record.capability,
    peerName: record.peerName,
    expiresAt: record.expiresAt,
  });
}
