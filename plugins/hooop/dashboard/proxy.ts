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
import {
  PEER_COOKIE,
  HOST_DEVICE_COOKIE,
  peerSigningSecret,
  verifyPeerToken,
  verifyHostDeviceToken,
  type PeerTokenPayload,
  type HostDeviceTokenPayload,
} from "@/lib/peer-token";
import { mutatingRequestLimiter } from "@/lib/rate-limit";
import { grantIsLive, revokedReason } from "@/lib/access";

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

/**
 * The terminal "you are signed out" page. Exempt from the revocation redirect
 * below for the obvious reason: it is where that redirect POINTS, so gating it
 * would be an infinite loop.
 */
const SIGNED_OUT_PATH = "/left";

/**
 * The strongest LIVE credential this request carries.
 *
 * "Strongest" is why the device is looked at first: a browser can legitimately
 * hold both cookies (you paired yourself into a session, then later enrolled the
 * same phone), and being pinned to one session as a guest is not what somebody who
 * just enrolled their own phone asked for.
 *
 * LIVE is the part that was missing, and it produced a real bug. Revocation is
 * invisible at the signature layer — a revoked token verifies perfectly — so
 * "prefer the device cookie" meant a REVOKED device shadowed a working peer
 * cookie: enrol a phone, revoke it, then join that same phone as a guest, and it
 * was refused as a dead device without the peer cookie ever being consulted. The
 * rule is therefore "the strongest credential that is still good", not "the
 * strongest credential presented".
 *
 * A dead credential is also reported so the caller can clear its cookie. Device
 * ids and share ids are never reused, so a revoked one is dead forever and there
 * is nothing to preserve by keeping it — leaving it in the jar just means it
 * shadows again on the next request.
 */
type Credential = { stale: string[] } & (
  | { kind: "device"; did: string }
  | { kind: "peer"; peer: PeerTokenPayload }
  /** Held one, it is gone. `participant` names which, so the message matches. */
  | { kind: "revoked"; participant: string }
  | { kind: "none" }
);

async function resolveCredential(req: NextRequest): Promise<Credential> {
  // Cookies the sandbox has already forgotten. Collected even when the request
  // SUCCEEDS on another credential: a dead cookie left in the jar shadows again on
  // the next request, and every request after that pays two probes to work around
  // it. Ids are never reused, so there is nothing to preserve by keeping it.
  const stale: string[] = [];
  const device = await resolveHostDevice(req);
  const peer = await resolvePeer(req);
  let deadParticipant: string | null = null;

  if (device) {
    const participant = `host:${device.did}`;
    if (await grantIsLive(participant)) return { kind: "device", did: device.did, stale };
    stale.push(HOST_DEVICE_COOKIE);
    deadParticipant = participant;
  }
  if (peer) {
    const participant = `peer:${peer.sid}`;
    if (await grantIsLive(participant)) return { kind: "peer", peer, stale };
    stale.push(PEER_COOKIE);
    // Both gone: report the device, the stronger of the two claims.
    deadParticipant ??= participant;
  }
  return deadParticipant
    ? { kind: "revoked", participant: deadParticipant, stale }
    : { kind: "none", stale };
}

/** Drop credentials the sandbox has already forgotten, so they stop being
 *  presented (and stop shadowing a good one) on every later request. */
function clearStale(res: NextResponse, stale: readonly string[]): NextResponse {
  for (const name of stale) res.cookies.set({ name, value: "", path: "/", maxAge: 0 });
  return res;
}

/**
 * Where a PAGE request goes when the credential behind it has been revoked.
 *
 * Somewhere that explains itself, rather than the shell: rendering would show the
 * host's empty new-session form, since every request behind it is refused, which
 * reads as the app being broken instead of as access having ended.
 *
 * Returns null only for the signed-out page itself, which has to stay reachable —
 * it is where this points, so gating it would loop forever.
 *
 * (API requests get a plain 403 at the call site. They have no shell to protect
 * and a redirect would just confuse a fetch.)
 */
function signedOutRedirect(
  req: NextRequest,
  rid: string,
  participant: string,
): NextResponse | null {
  if (req.nextUrl.pathname === SIGNED_OUT_PATH) return null;
  const url = req.nextUrl.clone();
  url.pathname = SIGNED_OUT_PATH;
  url.search = participant.startsWith("host:") ? "?as=device" : "";
  const res = NextResponse.redirect(url);
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
  //
  // The device-enrollment pair is here for the same reason and with the same
  // shape: a phone redeeming an enrollment code holds no credential yet (that is
  // the problem being solved), so /enroll must render and its POST must be
  // reachable without one. The POST is self-validating — it needs a live,
  // single-use code minted by the host for THIS tunnel host — and it is IP rate
  // limited, because unlike the peer flow there is no second gate behind it.
  if (
    pathname === "/api/share/redeem" ||
    pathname === "/api/share/join-status" ||
    pathname === "/api/share/claim" ||
    pathname === "/api/host-device/enroll" ||
    pathname.startsWith("/join/") ||
    pathname === "/join" ||
    pathname === "/enroll"
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

  // Whichever credential is both strongest and still good (see resolveCredential).
  const cred: Credential = !isAllowedHost(host)
    ? await resolveCredential(req)
    : { kind: "none", stale: [] };

  if (cred.kind === "revoked") {
    // Clear on the way out — including on the signed-out page itself, which stays
    // reachable, so the browser stops presenting a credential the sandbox has
    // forgotten.
    const refused = signedOutRedirect(req, rid, cred.participant);
    return clearStale(refused ?? passthrough(req, rid, "none"), cred.stale);
  }

  if (cred.kind === "device") {
    // Emphatically NOT the install cookie — the device authenticates with its own
    // revocable token, so a stolen phone costs you that device and not the
    // install. Everything else about being the host is identical.
    return clearStale(passthrough(req, rid, `host:${cred.did}`), cred.stale);
  }

  if (cred.kind === "peer") {
    const peer = cred.peer;
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
    return clearStale(passthrough(req, rid, `peer:${peer.sid}`, peer.ses, peer.cap), cred.stale);
  }

  // A page request from the public tunnel carrying NO credential at all. It used
  // to render the shell as nobody, which meant the host's "Start a session" form
  // backed by requests that all 403 — the third and last way to arrive at that
  // broken-looking screen (the other two being a revoked device and a device with
  // no session to land on). Nothing here is reachable from the internet without a
  // link, so say that instead of pretending to be an app.
  //
  // The three doors that must stay open returned earlier: /join/*, /enroll and the
  // signed-out page itself.
  if (!isAllowedHost(host)) {
    const url = req.nextUrl.clone();
    url.pathname = SIGNED_OUT_PATH;
    url.search = "";
    const res = req.nextUrl.pathname === SIGNED_OUT_PATH
      ? passthrough(req, rid, "none")
      : NextResponse.redirect(url);
    res.headers.set("x-request-id", rid);
    if (!expected) res.headers.set("x-dashboard-token-status", "unconfigured");
    return res;
  }

  // Host path: only on the localhost allowlist do we mint/refresh the install
  // cookie. With no install token configured, render but set nothing.
  if (!expected) {
    const res = passthrough(req, rid, "none");
    res.headers.set("x-dashboard-token-status", "unconfigured");
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

  // ── Peer / device path — non-allowed (tunnel) host + a signed token ───────
  // Preserve the DNS-rebinding defence: a disallowed host with NO credential
  // cookie is rejected exactly as before (403 host not allowed). Only a request
  // that actually carries one gets a validation path.
  const hasPeerCookie = !!req.cookies.get(PEER_COOKIE)?.value;
  const deviceCookie = req.cookies.get(HOST_DEVICE_COOKIE)?.value ?? "";
  if (!hasPeerCookie && !deviceCookie) {
    return jsonError(403, "host not allowed", rid);
  }

  // Whichever credential is both strongest and still good. A dead one does not
  // sink the request on its own: a browser holding a revoked device cookie AND a
  // live peer cookie is served as the guest it still legitimately is, and the dead
  // cookie is cleared so it stops shadowing on the next request.
  const cred = await resolveCredential(req);

  if (cred.kind === "revoked") {
    return clearStale(jsonError(403, revokedReason(cred.participant), rid), cred.stale);
  }
  if (cred.kind === "none") {
    return jsonError(401, "missing or invalid auth", rid);
  }

  if (cred.kind === "device") {
    if (!isSameOrigin(req)) {
      return jsonError(403, "cross-origin requests are not allowed", rid);
    }
    if (!SAFE_METHODS.has(req.method)) {
      const rate = mutatingRequestLimiter.check(deviceCookie);
      if (!rate.ok) return rateLimited(rid, rate.resetSec);
      // Same double-submit rule as the peer path, against the DEVICE cookie:
      // the header must equal it, so a hostile page that cannot read an
      // HttpOnly cookie cannot ride along on it. Constant-time, since the
      // cookie is a signed secret.
      const headerToken = req.headers.get(TOKEN_HEADER);
      if (!headerToken || !constantTimeEqualsJs(headerToken, deviceCookie)) {
        return jsonError(401, "mutating requests require " + TOKEN_HEADER + " header", rid);
      }
    }
    return clearStale(passthrough(req, rid, `host:${cred.did}`), cred.stale);
  }

  const peer = cred.peer;
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
  return clearStale(passthrough(req, rid, `peer:${peer.sid}`, peer.ses, peer.cap), cred.stale);
}

/**
 * Verify the host-device cookie's signature and bind it to the request Host.
 * Returns the payload only when the token is valid, unexpired, host-bound, and
 * actually a DEVICE token (verifyHostDeviceToken requires `kind:"host"`, so a
 * peer token dropped into this cookie by hand resolves to nothing).
 *
 * Revocation is NOT checked here, deliberately and by the same design as the peer
 * path: middleware runs on the edge with no way to reach the sandbox, so it
 * proves issuance and the sandbox proves currency on every forwarded call. A
 * revoked device can still render the shell for a moment; it cannot do anything.
 */
async function resolveHostDevice(req: NextRequest): Promise<HostDeviceTokenPayload | null> {
  const secret = peerSigningSecret();
  if (!secret) return null;
  const cookie = req.cookies.get(HOST_DEVICE_COOKIE)?.value;
  if (!cookie) return null;
  const payload = await verifyHostDeviceToken(cookie, secret);
  if (!payload) return null;
  if (normalizeHostHeader(req.headers.get("host")) !== payload.host) return null;
  return payload;
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
