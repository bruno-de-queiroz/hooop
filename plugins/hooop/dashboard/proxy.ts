import { NextRequest, NextResponse } from "next/server";
import {
  dashboardTokenFromEnv,
  tokenMatchesExpected,
  constantTimeEqualsJs,
  readTokenFromCookieHeader,
  isSameOrigin,
  isAllowedHost,
  TOKEN_COOKIE,
  TOKEN_HEADER,
} from "@/lib/auth-edge";
import { PEER_COOKIE, peerSigningSecret, verifyPeerToken, type PeerTokenPayload } from "@/lib/peer-token";
import { mutatingRequestLimiter } from "@/lib/rate-limit";

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Trusted, middleware-injected request header naming the resolved participant.
// Always stripped from inbound requests and re-set by us, so a client can never
// forge it (the layout + sandbox-forwarding both rely on it being trustworthy).
const PARTICIPANT_HEADER = "x-hooop-participant";
// For a peer, the canonical session id their share is bound to. Injected
// (and any inbound value stripped) like the participant header, so routes can
// trust it to scope a peer to exactly one session.
const PEER_SESSION_HEADER = "x-hooop-peer-session";
// For a peer, their share's capability (full | drive | spectate). Injected
// (inbound value stripped) like the other peer headers, so the layout can emit
// it to the client and the plan-review UI can gate approve/reject on it. The
// sandbox re-validates capability on every action; this is UX-only.
const PEER_CAP_HEADER = "x-hooop-peer-capability";

function networkHardeningEnabled(): boolean {
  return process.env.HOOOP_NETWORK_HARDENING === "1";
}

function ensureRequestId(req: NextRequest): string {
  return req.headers.get("x-request-id") || crypto.randomUUID();
}

function normalizeHostHeader(hostHeader: string | null): string {
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

/** Build a passthrough response that injects the resolved participant and a
 * request id, having first stripped any client-supplied participant header. */
function passthrough(req: NextRequest, rid: string, participant: string, peerSession?: string, peerCap?: string): NextResponse {
  const headers = new Headers(req.headers);
  headers.delete(PARTICIPANT_HEADER);
  headers.delete(PEER_SESSION_HEADER); // never trust an inbound value
  headers.delete(PEER_CAP_HEADER);
  headers.set(PARTICIPANT_HEADER, participant);
  if (peerSession) headers.set(PEER_SESSION_HEADER, peerSession);
  if (peerCap) headers.set(PEER_CAP_HEADER, peerCap);
  const res = NextResponse.next({ request: { headers } });
  res.headers.set("x-request-id", rid);
  return res;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const rid = ensureRequestId(req);

  // Health endpoint is unauthenticated — Docker / k8s healthchecks have no
  // way to present a token.
  if (pathname === "/api/health") {
    return passthrough(req, rid, "none");
  }

  // Pre-admission peer endpoints, reachable without a cookie: the peer doesn't
  // hold the peer cookie until the host admits them and they claim it. Each is
  // self-validating (redeem/claim verify the signed token's host claim + the
  // pending-cookie secret; join-status is a coarse poll). The /join/* page is a
  // client shell that reads the fragment token — it must render without (and
  // must NOT receive) the install cookie, since it's served on the tunnel host.
  if (
    pathname === "/api/share/redeem" ||
    pathname === "/api/share/join-status" ||
    pathname === "/api/share/claim" ||
    pathname.startsWith("/join/") ||
    pathname === "/join"
  ) {
    return passthrough(req, rid, "none");
  }

  if (pathname.startsWith("/api/")) {
    return authorizeApi(req, rid);
  }

  return authorizePage(req, rid);
}

/** Page (non-API) requests. Sets the install cookie ONLY on allowed (localhost)
 * hosts, so a peer on the tunnel host can never be handed the install token. */
async function authorizePage(req: NextRequest, rid: string): Promise<NextResponse> {
  const host = req.headers.get("host");
  const expected = dashboardTokenFromEnv();

  // Peer path: a verified peer cookie bound to this (tunnel) host.
  const peer = await resolvePeer(req);
  if (peer && !isAllowedHost(host)) {
    // A peer is locked to exactly one session. On the bare root:
    //  - no session selected → redirect to their bound session (don't show the
    //    host's create-session shell). The redirect carries the param, so it
    //    falls through to normal passthrough (no loop).
    //  - a session that ISN'T theirs → reject (403). A peer must never be able to
    //    view another session by editing the URL; this is the page-level mirror
    //    of the per-request canAccessSession scope enforced on the API.
    if (req.nextUrl.pathname === "/") {
      const requested = req.nextUrl.searchParams.get("session");
      if (!requested) {
        const url = req.nextUrl.clone();
        url.searchParams.set("session", peer.ses);
        const res = NextResponse.redirect(url);
        res.headers.set("x-request-id", rid);
        return res;
      }
      if (requested !== peer.ses) {
        return jsonError(403, "out of session scope", rid);
      }
    }
    // Do NOT set the install cookie. Tell the layout to emit the peer token,
    // and pin the peer to their bound session.
    return passthrough(req, rid, `peer:${peer.sid}`, peer.ses, peer.cap);
  }

  // Host path: only on the localhost allowlist do we mint/refresh the install
  // cookie. On any other host with no peer grant, render but set nothing.
  if (!expected || !isAllowedHost(host)) {
    const res = passthrough(req, rid, expected ? "none" : "none");
    if (!expected) res.headers.set("x-dashboard-token-status", "unconfigured");
    return res;
  }

  const res = passthrough(req, rid, "host");
  const existing = req.cookies.get(TOKEN_COOKIE)?.value;
  if (!existing || existing !== expected) {
    res.cookies.set({
      name: TOKEN_COOKIE,
      value: expected,
      httpOnly: true,
      sameSite: "strict",
      secure: networkHardeningEnabled(),
      path: "/",
      maxAge: ONE_YEAR_SECONDS,
    });
  }
  return res;
}

async function authorizeApi(req: NextRequest, rid: string): Promise<NextResponse> {
  const expected = dashboardTokenFromEnv();
  if (!expected) {
    return jsonError(503, "dashboard token not configured", rid);
  }
  const host = req.headers.get("host");

  // ── Install (host) path — UNCHANGED behaviour, localhost-only ─────────────
  // Only attempt it when the host is on the localhost allowlist; this keeps the
  // host's existing attack surface exactly as before and means a tunnel-host
  // request never exercises the install path.
  if (isAllowedHost(host)) {
    if (!isSameOrigin(req)) {
      return jsonError(403, "cross-origin requests are not allowed", rid);
    }
    const cookieToken = readTokenFromCookieHeader(req.headers.get("cookie"));
    if (tokenMatchesExpected(cookieToken, expected)) {
      if (!SAFE_METHODS.has(req.method)) {
        const rate = mutatingRequestLimiter.check(cookieToken!);
        if (!rate.ok) return rateLimited(rid, rate.resetSec);
        const headerToken = req.headers.get(TOKEN_HEADER);
        if (!tokenMatchesExpected(headerToken, expected)) {
          return jsonError(401, "mutating requests require " + TOKEN_HEADER + " header", rid);
        }
      }
      return passthrough(req, rid, "host");
    }
    // Host allowed but no valid install cookie → reject (don't fall to peer;
    // peers never arrive on an allowed host).
    return jsonError(401, "missing or invalid auth cookie", rid);
  }

  // ── Peer path — non-allowed (tunnel) host + signed peer token ─────────────
  // Preserve the DNS-rebinding defence: a disallowed host with NO peer cookie
  // is rejected exactly as before (403 host not allowed). Only a request that
  // actually carries a peer cookie gets the peer-validation path.
  const hasPeerCookie = !!req.cookies.get(PEER_COOKIE)?.value;
  if (!hasPeerCookie) {
    return jsonError(403, "host not allowed", rid);
  }
  const peer = await resolvePeer(req);
  if (!peer) {
    return jsonError(401, "missing or invalid auth", rid);
  }
  if (!isSameOrigin(req)) {
    return jsonError(403, "cross-origin requests are not allowed", rid);
  }
  if (!SAFE_METHODS.has(req.method)) {
    const peerCookie = req.cookies.get(PEER_COOKIE)?.value ?? "";
    const rate = mutatingRequestLimiter.check(peerCookie);
    if (!rate.ok) return rateLimited(rid, rate.resetSec);
    // Double-submit: the mutation header must equal the peer cookie (an
    // attacker can't read the HttpOnly cookie nor forge the HMAC signature).
    // Constant-time compare, matching the host path — the cookie is a signed
    // secret, so avoid leaking it byte-by-byte via a short-circuiting `!==`.
    const headerToken = req.headers.get(TOKEN_HEADER);
    if (!headerToken || !constantTimeEqualsJs(headerToken, peerCookie)) {
      return jsonError(401, "mutating requests require " + TOKEN_HEADER + " header", rid);
    }
  }
  return passthrough(req, rid, `peer:${peer.sid}`, peer.ses, peer.cap);
}

/** Verify the peer cookie's signature and bind it to the request Host. Returns
 * the payload only when the token is valid, unexpired, and host-bound. */
async function resolvePeer(req: NextRequest): Promise<PeerTokenPayload | null> {
  const secret = peerSigningSecret();
  if (!secret) return null;
  const cookie = req.cookies.get(PEER_COOKIE)?.value;
  if (!cookie) return null;
  const payload = await verifyPeerToken(cookie, secret);
  if (!payload) return null;
  if (normalizeHostHeader(req.headers.get("host")) !== payload.host) return null;
  return payload;
}

function rateLimited(rid: string, resetSec: number): NextResponse {
  return new NextResponse(
    JSON.stringify({ error: "rate limit exceeded; try again later", requestId: rid }),
    {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(resetSec),
        "x-request-id": rid,
      },
    },
  );
}

function jsonError(status: number, message: string, rid?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (rid) headers["x-request-id"] = rid;
  return new NextResponse(
    JSON.stringify({ error: message, ...(rid ? { requestId: rid } : {}) }),
    { status, headers }
  );
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
