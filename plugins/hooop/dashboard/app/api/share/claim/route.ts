import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse } from "@/lib/api-helpers";
import { PEER_COOKIE, PEER_PENDING_COOKIE, peerSigningSecret, verifyPeerToken } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

function normalizeHost(hostHeader: string | null): string {
  if (!hostHeader) return "";
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  return h;
}

/**
 * Claim an admitted join and receive the peer cookie. Requires: the pending
 * cookie (ticket secret, proving this is the browser that redeemed), the
 * signed token again (re-verified), and the sandbox confirming the ticket is
 * admitted. Only then is the token promoted into the durable HttpOnly peer
 * cookie. Reachable without a peer cookie — middleware-allowlisted.
 */
export async function POST(req: Request) {
  const secret = peerSigningSecret();
  if (!secret) return errorResponse("sharing is not configured", 503);

  const { body, error } = await parseJsonBody<{ token?: string; ticketId?: string }>(req);
  if (error) return error;
  if (!body.token || !body.ticketId) return errorResponse("invalid request", 400);

  const pendingSecret = (await cookies()).get(PEER_PENDING_COOKIE)?.value;
  if (!pendingSecret) return errorResponse("no pending join", 401);

  const payload = await verifyPeerToken(body.token, secret);
  if (!payload) return errorResponse("invalid or expired share link", 401);
  const host = normalizeHost(req.headers.get("host"));
  if (payload.host !== host) return errorResponse("invalid or expired share link", 401);

  // Sandbox is the authority: only an admitted ticket whose secret matches
  // this browser's pending cookie can be claimed (one-time).
  let grant: { shareId: string; sessionId: string; peerName: string | null } | null = null;
  try {
    grant = await client.claimJoin(body.ticketId, pendingSecret);
  } catch {
    grant = null;
  }
  if (!grant || grant.shareId !== payload.sid) {
    return errorResponse("not admitted", 403);
  }

  const now = Date.now();
  const maxAgeMs = payload.exp ? Math.max(0, payload.exp - now) : DEFAULT_TTL_MS;

  const res = NextResponse.json({ ok: true, sessionId: payload.ses, peerName: payload.name ?? null });
  // Promote the token into the durable peer cookie; drop the pending cookie.
  //
  // SameSite=LAX (not Strict): the peer reaches this app by opening the share
  // link, which is a cross-site top-level navigation (tapped from a chat/email
  // app, or restored by the browser with a cross-site initiator). A Strict
  // cookie is withheld on that navigation, so the layout's server render sees
  // no peer cookie, emits no `x-dashboard-token` meta, and the client's
  // fetch-patch never installs — the first mutating request then 401s with
  // "mutating requests require x-dashboard-token header" even though same-origin
  // GET fetches (which DO carry a Strict cookie) loaded the session fine. Lax
  // sends the cookie on top-level GET navigations while still withholding it on
  // cross-site subresource/POST requests, so the double-submit CSRF defence
  // (header must equal the cookie) is fully preserved.
  res.cookies.set({
    name: PEER_COOKIE,
    value: body.token,
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: Math.floor(maxAgeMs / 1000),
  });
  res.cookies.set({ name: PEER_PENDING_COOKIE, value: "", path: "/", maxAge: 0 });
  return res;
}
