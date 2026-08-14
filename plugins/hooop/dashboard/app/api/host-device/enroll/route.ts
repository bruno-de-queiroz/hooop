import { NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import {
  HOST_DEVICE_COOKIE,
  peerSigningSecret,
  signHostDeviceToken,
} from "@/lib/peer-token";
import { enrollAttemptLimiter } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Fallback lifetime if the sandbox somehow returns a device with no expiry. */
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

/** Rate-limit key for an unauthenticated caller: the tunnel edge's view of who
 * they are. `CF-Connecting-IP` is authoritative behind a cloudflared tunnel (the
 * edge overwrites any client-supplied value); the first `X-Forwarded-For` hop is
 * the fallback. A shared NAT means a few colleagues share a budget, which is
 * fine at ten attempts a minute, and an attacker with a pool of addresses still
 * faces single-use codes that expire in two minutes. */
function clientKey(req: Request): string {
  const cf = req.headers.get("cf-connecting-ip");
  const xff = req.headers.get("x-forwarded-for");
  return (cf?.trim() || xff?.split(",")[0]?.trim() || "unknown").toLowerCase().slice(0, 45);
}

/**
 * Redeem an enrollment code and become one of the host's own devices.
 *
 * Reachable with NO credential (middleware-allowlisted), because a phone that is
 * about to be enrolled holds nothing yet — that is the problem being solved. What
 * stands in for a credential:
 *   1. the code itself, single-use, two-minute TTL, minted only by a caller who
 *      already had host authority;
 *   2. the host binding — the code was minted for THIS tunnel hostname, checked
 *      here and again in the sandbox;
 *   3. an IP rate limit, since unlike the peer flow there is no second human
 *      gate behind this one. A peer link ends in "wait for the host to admit
 *      you"; a code ends in "you are the host", so guessing has to be expensive.
 *
 * On success the device gets its OWN signed token in an HttpOnly cookie. Never
 * the install token: that one stays on the machine, which is the entire reason
 * this flow exists instead of a copy-paste.
 */
export async function POST(req: Request) {
  const secret = peerSigningSecret();
  if (!secret) return errorResponse("device enrollment is not configured", 503);

  const rate = enrollAttemptLimiter.check(clientKey(req));
  if (!rate.ok) {
    return new NextResponse(
      JSON.stringify({ error: "too many attempts; wait a moment and try again" }),
      { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(rate.resetSec) } },
    );
  }

  const { body, error } = await parseJsonBody<{ code?: unknown; label?: unknown }>(req);
  if (error) return error;
  const code = boundedString(body.code, 64);
  // One message for every failure below, so this endpoint never becomes an
  // oracle for "was that code real?" — the same reason /api/share/redeem gives
  // one answer for a bad token and an unknown share.
  const genericErr = "This enrollment code is invalid, expired, or already used.";
  if (!code) return errorResponse(genericErr, 401);
  const label = boundedString(body.label, 60);

  const host = normalizeHost(req.headers.get("host"));
  if (!host) return errorResponse(genericErr, 401);

  let device: {
    deviceId: string; label: string; publicHost: string;
    expiresAt: number | null; sessionId: string | null;
  } | null;
  try {
    device = await client.redeemHostEnrollCode(code, host, label);
  } catch {
    return errorResponse("could not complete enrollment", 502);
  }
  if (!device) return errorResponse(genericErr, 401);

  const exp = device.expiresAt ?? Date.now() + DEFAULT_TTL_MS;
  const token = await signHostDeviceToken({ did: device.deviceId, host: device.publicHost, exp }, secret);

  // `sessionId` is a landing hint, not part of the grant: the device is the host
  // and may switch sessions freely afterwards. It exists because "add a device"
  // is pressed from ONE session's dialog, and arriving on the new-session form
  // instead of that session reads as the enrollment having gone somewhere else.
  const res = NextResponse.json({
    ok: true,
    label: device.label,
    expiresAt: device.expiresAt,
    sessionId: device.sessionId,
  });
  res.cookies.set({
    name: HOST_DEVICE_COOKIE,
    value: token,
    httpOnly: true,
    secure: true, // tunnels are HTTPS
    // SameSite=LAX for the same reason the peer cookie uses it: the device
    // arrives by tapping a link or scanning a QR, which is a cross-site
    // top-level navigation. Strict would withhold the cookie on that first
    // navigation, the layout would render as nobody, and the fetch patch would
    // never install — so the first mutating request would 401 on a missing
    // header. Lax still withholds it on cross-site subresource and POST
    // requests, so the double-submit CSRF defence is intact.
    sameSite: "lax",
    path: "/",
    maxAge: Math.max(0, Math.floor((exp - Date.now()) / 1000)),
  });
  return res;
}
