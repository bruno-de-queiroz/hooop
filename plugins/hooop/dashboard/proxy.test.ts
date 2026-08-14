import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const fakeFiles = vi.hoisted(() => ({
  store: new Map<string, string>(),
  reset() { this.store.clear(); },
}));

vi.mock("node:fs", () => {
  const api = {
    existsSync: (p: string) => fakeFiles.store.has(p),
    readFileSync: (p: string) => {
      const v = fakeFiles.store.get(p);
      if (v == null) throw new Error("ENOENT");
      return v;
    },
    writeFileSync: (p: string, data: string | Buffer) => {
      fakeFiles.store.set(p, typeof data === "string" ? data : data.toString());
    },
    chmodSync: () => undefined,
    mkdirSync: () => undefined,
  };
  return { ...api, default: api };
});

let mod: typeof import("./proxy");
let auth: typeof import("./lib/auth");
let rateLimit: typeof import("./lib/rate-limit");
let peerToken: typeof import("./lib/peer-token");
let token: string;
const PEER_SECRET = "p".repeat(48);
const TUNNEL_HOST = "abc123.trycloudflare.com";
let originalCheck: typeof rateLimit.mutatingRequestLimiter.check | null = null;

beforeEach(async () => {
  vi.resetModules();
  fakeFiles.reset();
  process.env.HOOOP_DASHBOARD_TOKEN_FILE = "/mock/state/dashboard.token";
  process.env.HOOOP_DASHBOARD_TOKEN = "a".repeat(64);
  process.env.HOOOP_PEER_SIGNING_SECRET = PEER_SECRET;
  delete process.env.HOOOP_NETWORK_HARDENING;
  mod = await import("./proxy");
  auth = await import("./lib/auth");
  rateLimit = await import("./lib/rate-limit");
  peerToken = await import("./lib/peer-token");
  token = auth.dashboardToken();
  rateLimit.mutatingRequestLimiter.reset();
  originalCheck = null;
});

afterEach(() => {
  if (originalCheck && rateLimit?.mutatingRequestLimiter) {
    rateLimit.mutatingRequestLimiter.check = originalCheck;
    originalCheck = null;
  }
  delete process.env.HOOOP_PEER_SIGNING_SECRET;
});

function reqWith(opts: {
  method?: string;
  pathname?: string;
  origin?: string;
  cookie?: string;
  dashboardHeader?: string;
  extraHeaders?: Record<string, string>;
}): NextRequest {
  const url = `http://localhost:7842${opts.pathname ?? "/"}`;
  const headers: Record<string, string> = {
    host: "localhost:7842",
    origin: opts.origin ?? "http://localhost:7842",
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.dashboardHeader ? { "x-dashboard-token": opts.dashboardHeader } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  return new NextRequest(url, { method: opts.method ?? "GET", headers });
}

/** A request arriving on the tunnel host (the peer side). */
function peerReq(opts: {
  method?: string;
  pathname?: string;
  cookieToken?: string;     // value placed in the hooop_peer cookie
  dashboardHeader?: string; // x-dashboard-token (double-submit)
  host?: string;
}): NextRequest {
  const host = opts.host ?? TUNNEL_HOST;
  const headers: Record<string, string> = {
    host,
    origin: `https://${host}`,
  };
  if (opts.cookieToken) headers.cookie = `hooop_peer=${opts.cookieToken}`;
  if (opts.dashboardHeader) headers["x-dashboard-token"] = opts.dashboardHeader;
  return new NextRequest(`https://${host}${opts.pathname ?? "/api/sessions"}`, {
    method: opts.method ?? "GET",
    headers,
  });
}

async function mkPeerToken(over: Partial<import("./lib/peer-token").PeerTokenPayload> = {}): Promise<string> {
  return peerToken.signPeerToken(
    { sid: "share-1", ses: "sess-1", cap: "full", host: TUNNEL_HOST, ...over },
    PEER_SECRET,
  );
}

describe("proxy — install (host) path", () => {
  it("page route: sets the cookie when absent", async () => {
    const res = await mod.proxy(reqWith({ pathname: "/" }));
    expect(res).toBeInstanceOf(NextResponse);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hooop_token=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=strict");
  });

  it("page route: refreshes a stale cookie to the current expected token", async () => {
    const res = await mod.proxy(reqWith({
      pathname: "/",
      cookie: `hooop_token=stale-value-from-prior-run-${"x".repeat(40)}`,
    }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`hooop_token=${token}`);
  });

  it("page route: leaves a matching cookie alone", async () => {
    const res = await mod.proxy(reqWith({
      pathname: "/",
      cookie: `hooop_token=${token}`,
    }));
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("page route: stamps an x-request-id on the response", async () => {
    const res = await mod.proxy(reqWith({ pathname: "/" }));
    expect(res.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("API GET with valid cookie passes through", async () => {
    const res = await mod.proxy(reqWith({
      pathname: "/api/sessions",
      cookie: `hooop_token=${token}`,
    }));
    expect(res.status).toBe(200);
  });

  it("API GET without cookie rejects 401", async () => {
    const res = await mod.proxy(reqWith({ pathname: "/api/sessions" }));
    expect(res.status).toBe(401);
    const body = await (res as Response).json();
    expect(body.error).toMatch(/auth cookie/);
    expect(body.requestId).toMatch(/^[0-9a-f]{8}-/);
  });

  it("API cross-origin rejects 403 before the cookie check", async () => {
    const res = await mod.proxy(reqWith({
      pathname: "/api/sessions",
      origin: "https://evil.com",
      cookie: `hooop_token=${token}`,
    }));
    expect(res.status).toBe(403);
  });

  it("API POST with cookie+header passes through", async () => {
    const res = await mod.proxy(reqWith({
      method: "POST",
      pathname: "/api/sessions/new",
      cookie: `hooop_token=${token}`,
      dashboardHeader: token,
    }));
    expect(res.status).toBe(200);
  });

  it("API POST with cookie but MISSING header rejects 401", async () => {
    const res = await mod.proxy(reqWith({
      method: "POST",
      pathname: "/api/sessions/new",
      cookie: `hooop_token=${token}`,
    }));
    expect(res.status).toBe(401);
    const body = await (res as Response).json();
    expect(body.error).toMatch(/x-dashboard-token/);
  });

  it("rate-limit fires on mutating burst (cookie valid, no header) — consumes budget BEFORE 401", async () => {
    const baseReq = () => reqWith({
      method: "POST",
      pathname: "/api/sessions/new",
      cookie: `hooop_token=${token}`,
    });
    rateLimit.mutatingRequestLimiter.reset();
    const limiter = rateLimit.createRateLimiter({ max: 2, windowMs: 60_000 });
    originalCheck = rateLimit.mutatingRequestLimiter.check;
    rateLimit.mutatingRequestLimiter.check = (k: string) => limiter.check(k);

    const r1 = await mod.proxy(baseReq());
    const r2 = await mod.proxy(baseReq());
    const r3 = await mod.proxy(baseReq());

    expect(r1.status).toBe(401);
    expect(r2.status).toBe(401);
    expect(r3.status).toBe(429);
    const body = await (r3 as Response).json();
    expect(body.error).toMatch(/rate limit/);
    expect(r3.headers.get("retry-after")).toBeTruthy();
    expect(r3.headers.get("x-request-id")).toBeTruthy();
  });

  it("rate-limit: GET (safe method) does NOT consume the budget", async () => {
    const limiter = rateLimit.createRateLimiter({ max: 2, windowMs: 60_000 });
    originalCheck = rateLimit.mutatingRequestLimiter.check;
    rateLimit.mutatingRequestLimiter.check = (k: string) => limiter.check(k);

    for (let i = 0; i < 5; i++) {
      const res = await mod.proxy(reqWith({
        pathname: "/api/sessions",
        cookie: `hooop_token=${token}`,
      }));
      expect(res.status).toBe(200);
    }
  });

  it("rate-limit: the N-1 mutating requests all pass before the Nth fires 429", async () => {
    const limiter = rateLimit.createRateLimiter({ max: 3, windowMs: 60_000 });
    originalCheck = rateLimit.mutatingRequestLimiter.check;
    rateLimit.mutatingRequestLimiter.check = (k: string) => limiter.check(k);

    const req = () => reqWith({
      method: "POST",
      pathname: "/api/sessions/new",
      cookie: `hooop_token=${token}`,
      dashboardHeader: token,
    });

    expect((await mod.proxy(req())).status).toBe(200);
    expect((await mod.proxy(req())).status).toBe(200);
    expect((await mod.proxy(req())).status).toBe(200);
    expect((await mod.proxy(req())).status).toBe(429);
  });

  it("network hardening: rejects API request with no origin signal when enabled", async () => {
    process.env.HOOOP_NETWORK_HARDENING = "1";
    try {
      const req = new NextRequest("http://localhost:7842/api/sessions", {
        method: "GET",
        headers: { host: "localhost:7842", cookie: `hooop_token=${token}` },
      });
      const res = await mod.proxy(req);
      expect(res.status).toBe(403);
    } finally {
      delete process.env.HOOOP_NETWORK_HARDENING;
    }
  });
});

describe("proxy — host allowlist (DNS-rebinding defence)", () => {
  it("localhost:7842 → allowed (200)", async () => {
    const res = await mod.proxy(reqWith({
      pathname: "/api/sessions",
      cookie: `hooop_token=${token}`,
    }));
    expect(res.status).toBe(200);
  });

  it("127.0.0.1:7842 → allowed", async () => {
    const req = new NextRequest("http://127.0.0.1:7842/api/sessions", {
      method: "GET",
      headers: { host: "127.0.0.1:7842", origin: "http://127.0.0.1:7842", cookie: `hooop_token=${token}` },
    });
    expect((await mod.proxy(req)).status).toBe(200);
  });

  it("[::1]:7842 → allowed", async () => {
    const req = new NextRequest("http://[::1]:7842/api/sessions", {
      method: "GET",
      headers: { host: "[::1]:7842", origin: "http://[::1]:7842", cookie: `hooop_token=${token}` },
    });
    expect((await mod.proxy(req)).status).toBe(200);
  });

  it("host.docker.internal:7842 → allowed", async () => {
    const req = new NextRequest("http://host.docker.internal:7842/api/sessions", {
      method: "GET",
      headers: { host: "host.docker.internal:7842", origin: "http://host.docker.internal:7842", cookie: `hooop_token=${token}` },
    });
    expect((await mod.proxy(req)).status).toBe(200);
  });

  it("evil.example.com (no peer cookie) → 403 host not allowed", async () => {
    const req = new NextRequest("http://evil.example.com/api/sessions", {
      method: "GET",
      headers: { host: "evil.example.com", origin: "http://evil.example.com", cookie: `hooop_token=${token}` },
    });
    const res = await mod.proxy(req);
    expect(res.status).toBe(403);
    const body = await (res as Response).json();
    expect(body.error).toMatch(/host not allowed/);
  });

  it("empty Host header → 403", async () => {
    const reqNoHost = new NextRequest("http://localhost:7842/api/sessions", {
      method: "GET",
      headers: { host: "", origin: "http://localhost:7842", cookie: `hooop_token=${token}` },
    });
    const res = await mod.proxy(reqNoHost);
    expect(res.status).toBe(403);
  });

  it("HOOOP_TRUSTED_HOSTS bare hostname matches any port", async () => {
    process.env.HOOOP_TRUSTED_HOSTS = "mybox.local,10.0.0.5:7842";
    try {
      const req = new NextRequest("http://mybox.local:9999/api/sessions", {
        method: "GET",
        headers: { host: "mybox.local:9999", origin: "http://mybox.local:9999", cookie: `hooop_token=${token}` },
      });
      expect((await mod.proxy(req)).status).toBe(200);
    } finally {
      delete process.env.HOOOP_TRUSTED_HOSTS;
    }
  });

  it("HOOOP_TRUSTED_HOSTS host:port exact match", async () => {
    process.env.HOOOP_TRUSTED_HOSTS = "mybox.local,10.0.0.5:7842";
    try {
      const req = new NextRequest("http://10.0.0.5:7842/api/sessions", {
        method: "GET",
        headers: { host: "10.0.0.5:7842", origin: "http://10.0.0.5:7842", cookie: `hooop_token=${token}` },
      });
      expect((await mod.proxy(req)).status).toBe(200);
    } finally {
      delete process.env.HOOOP_TRUSTED_HOSTS;
    }
  });

  it("hostile combo evil Host + matching Origin rejected by host check first", async () => {
    const req = new NextRequest("http://evil.example.com/api/sessions", {
      method: "GET",
      headers: { host: "evil.example.com", origin: "http://evil.example.com", cookie: `hooop_token=${token}` },
    });
    const res = await mod.proxy(req);
    expect(res.status).toBe(403);
    const body = await (res as Response).json();
    expect(body.error).toBe("host not allowed");
  });
});

describe("proxy — trusted header injection (spoof defence)", () => {
  // NextResponse.next({ request: { headers } }) encodes the forwarded request
  // headers as `x-middleware-request-<name>` markers (listed in
  // `x-middleware-override-headers`). Asserting on those proves what the
  // downstream (layout / route handlers / sandbox) will actually receive.

  it("host page path: a client-forged x-hooop-participant is stripped, replaced with the trusted value", async () => {
    const res = await mod.proxy(reqWith({
      pathname: "/",
      cookie: `hooop_token=${token}`,
      extraHeaders: {
        "x-hooop-participant": "host-SPOOFED",
        "x-hooop-peer-session": "evil",
        "x-hooop-peer-capability": "full",
      },
    }));
    // The forwarded header carries the value WE resolved, never the client's.
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("host");
    // Peer headers are never set on the host path, and the forged inbound ones
    // are dropped rather than forwarded.
    const overridden = res.headers.get("x-middleware-override-headers") ?? "";
    expect(overridden).not.toContain("x-hooop-peer-session");
    expect(overridden).not.toContain("x-hooop-peer-capability");
    expect(res.headers.get("x-middleware-request-x-hooop-peer-session")).toBeNull();
    expect(res.headers.get("x-middleware-request-x-hooop-peer-capability")).toBeNull();
  });

  it("peer path: a peer cannot forge participant/session/capability headers to escalate", async () => {
    const t = await mkPeerToken({ sid: "share-1", ses: "sess-1", cap: "full" });
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/sessions`, {
      method: "GET",
      headers: {
        host: TUNNEL_HOST,
        origin: `https://${TUNNEL_HOST}`,
        cookie: `hooop_peer=${t}`,
        "x-hooop-participant": "host",         // forged: try to become host
        "x-hooop-peer-session": "sess-EVIL",   // forged: try to widen session scope
        "x-hooop-peer-capability": "spectate", // forged: mismatched capability
      },
    }));
    expect(res.status).toBe(200);
    // All three are re-derived from the verified token, not the client's headers.
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("peer:share-1");
    expect(res.headers.get("x-middleware-request-x-hooop-peer-session")).toBe("sess-1");
    expect(res.headers.get("x-middleware-request-x-hooop-peer-capability")).toBe("full");
  });
});

describe("proxy — peer (share) path", () => {
  it("valid peer token on the bound tunnel host: GET passes through", async () => {
    const t = await mkPeerToken();
    const res = await mod.proxy(peerReq({ pathname: "/api/sessions", cookieToken: t }));
    expect(res.status).toBe(200);
    // Middleware injects the trusted participant header for downstream.
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("peer token bound to a DIFFERENT host is rejected (host binding)", async () => {
    const t = await mkPeerToken({ host: "other.trycloudflare.com" });
    const res = await mod.proxy(peerReq({ pathname: "/api/sessions", cookieToken: t }));
    // Has a peer cookie but it doesn't bind to this host → 401, not 200.
    expect(res.status).toBe(401);
  });

  it("forged/garbage peer token is rejected 401", async () => {
    const res = await mod.proxy(peerReq({ pathname: "/api/sessions", cookieToken: "not.a.valid.token" }));
    expect(res.status).toBe(401);
  });

  it("tampered payload (valid-looking but wrong signature) rejected", async () => {
    const t = await mkPeerToken();
    const tampered = t.slice(0, t.indexOf(".")) + "x." + t.slice(t.indexOf(".") + 1);
    const res = await mod.proxy(peerReq({ pathname: "/api/sessions", cookieToken: tampered }));
    expect(res.status).toBe(401);
  });

  it("expired peer token rejected", async () => {
    const t = await mkPeerToken({ exp: Date.now() - 1000 });
    const res = await mod.proxy(peerReq({ pathname: "/api/sessions", cookieToken: t }));
    expect(res.status).toBe(401);
  });

  it("tunnel host with NO peer cookie → 403 host not allowed (rebinding defence intact)", async () => {
    const res = await mod.proxy(peerReq({ pathname: "/api/sessions" }));
    expect(res.status).toBe(403);
  });

  it("peer mutation requires double-submit header equal to the cookie", async () => {
    const t = await mkPeerToken();
    // Missing header → 401
    const noHeader = await mod.proxy(peerReq({ method: "POST", pathname: "/api/sessions/sess-1/message", cookieToken: t }));
    expect(noHeader.status).toBe(401);
    // Header != cookie → 401
    const wrong = await mod.proxy(peerReq({ method: "POST", pathname: "/api/sessions/sess-1/message", cookieToken: t, dashboardHeader: "different" }));
    expect(wrong.status).toBe(401);
    // Header == cookie → passes
    const ok = await mod.proxy(peerReq({ method: "POST", pathname: "/api/sessions/sess-1/message", cookieToken: t, dashboardHeader: t }));
    expect(ok.status).toBe(200);
  });

  it("peer requests never set the install cookie (page route on tunnel host)", async () => {
    const t = await mkPeerToken();
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/?session=sess-1`, {
      method: "GET",
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, cookie: `hooop_peer=${t}` },
    }));
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).not.toContain("hooop_token=");
  });

  it("peer landing on bare root is redirected to their bound session", async () => {
    const t = await mkPeerToken(); // ses: "sess-1"
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/`, {
      method: "GET",
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, cookie: `hooop_peer=${t}` },
    }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(`https://${TUNNEL_HOST}/?session=sess-1`);
  });

  it("peer on root WITH their bound session param passes through (no redirect)", async () => {
    const t = await mkPeerToken();
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/?session=sess-1`, {
      method: "GET",
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, cookie: `hooop_peer=${t}` },
    }));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("peer:share-1");
  });

  it("peer on root with a DIFFERENT session id is rejected 403 (page-level scope)", async () => {
    const t = await mkPeerToken(); // bound to ses: "sess-1"
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/?session=sess-OTHER`, {
      method: "GET",
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, cookie: `hooop_peer=${t}` },
    }));
    expect(res.status).toBe(403);
    // Must not have rendered as a peer for the wrong session.
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBeNull();
  });

  it("redeem + join endpoints are reachable without a cookie", async () => {
    const redeem = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/share/redeem`, {
      method: "POST",
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, "content-type": "application/json" },
    }));
    expect(redeem.status).toBe(200); // passthrough; the route itself validates
    const join = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/join/share-1`, {
      method: "GET",
      headers: { host: TUNNEL_HOST },
    }));
    expect(join.status).toBe(200);
  });

  it("peer path disabled when no signing secret is configured", async () => {
    delete process.env.HOOOP_PEER_SIGNING_SECRET;
    vi.resetModules();
    const fresh = await import("./proxy");
    const t = await mkPeerToken();
    const res = await fresh.proxy(peerReq({ pathname: "/api/sessions", cookieToken: t }));
    // No secret → resolvePeer returns null → has-cookie but invalid → 401
    expect(res.status).toBe(401);
  });
});

/** A request arriving on the tunnel host carrying an enrolled DEVICE cookie. */
function deviceReq(opts: {
  method?: string;
  pathname?: string;
  cookie?: string;          // raw cookie header
  dashboardHeader?: string; // x-dashboard-token (double-submit)
  host?: string;
  extraHeaders?: Record<string, string>;
}): NextRequest {
  const host = opts.host ?? TUNNEL_HOST;
  const headers: Record<string, string> = {
    host,
    origin: `https://${host}`,
    ...(opts.cookie ? { cookie: opts.cookie } : {}),
    ...(opts.dashboardHeader ? { "x-dashboard-token": opts.dashboardHeader } : {}),
    ...(opts.extraHeaders ?? {}),
  };
  return new NextRequest(`https://${host}${opts.pathname ?? "/api/sessions"}`, {
    method: opts.method ?? "GET",
    headers,
  });
}

async function mkDeviceToken(
  over: Partial<import("./lib/peer-token").HostDeviceTokenPayload> = {},
): Promise<string> {
  return peerToken.signHostDeviceToken(
    { did: "device-1", host: TUNNEL_HOST, ...over },
    PEER_SECRET,
  );
}

describe("proxy — enrolled host device path", () => {
  it("a valid device token on the bound host resolves to the HOST, not a peer", async () => {
    const t = await mkDeviceToken();
    const res = await mod.proxy(deviceReq({ pathname: "/api/sessions", cookie: `hooop_host_device=${t}` }));
    expect(res.status).toBe(200);
    // `host:<deviceId>` — the identity is the host, and the id is what the
    // sandbox re-validates against its device registry.
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("host:device-1");
    // A device is NOT pinned to one session the way a peer is.
    expect(res.headers.get("x-middleware-request-x-hooop-peer-session")).toBeNull();
  });

  it("never hands a device the install cookie", async () => {
    // The whole reason a device gets its own revocable credential: the install
    // token must not leave the machine, even to its owner's phone.
    const t = await mkDeviceToken();
    const res = await mod.proxy(deviceReq({ pathname: "/", cookie: `hooop_host_device=${t}` }));
    expect(res.headers.get("set-cookie") ?? "").not.toContain("hooop_token=");
  });

  it("device token bound to a DIFFERENT host is rejected (dies with the tunnel)", async () => {
    const t = await mkDeviceToken({ host: "other.trycloudflare.com" });
    const res = await mod.proxy(deviceReq({ pathname: "/api/sessions", cookie: `hooop_host_device=${t}` }));
    expect(res.status).toBe(401);
  });

  it("expired device token rejected", async () => {
    const t = await mkDeviceToken({ exp: Date.now() - 1000 });
    const res = await mod.proxy(deviceReq({ pathname: "/api/sessions", cookie: `hooop_host_device=${t}` }));
    expect(res.status).toBe(401);
  });

  it("a PEER token in the device cookie proves nothing (domain separation)", async () => {
    // Both kinds are signed with the same secret, so the only thing stopping a
    // guest from promoting their own cookie is the `kind` claim.
    const peerTok = await mkPeerToken();
    const res = await mod.proxy(deviceReq({ pathname: "/api/sessions", cookie: `hooop_host_device=${peerTok}` }));
    expect(res.status).toBe(401);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBeNull();
  });

  it("a DEVICE token in the peer cookie is not a peer either (the other direction)", async () => {
    const t = await mkDeviceToken();
    const res = await mod.proxy(peerReq({ pathname: "/api/sessions", cookieToken: t }));
    expect(res.status).toBe(401);
  });

  it("a device cannot forge the participant header to name another device", async () => {
    const t = await mkDeviceToken({ did: "device-1" });
    const res = await mod.proxy(deviceReq({
      pathname: "/api/sessions",
      cookie: `hooop_host_device=${t}`,
      extraHeaders: { "x-hooop-participant": "host" }, // try to shed the revocable id
    }));
    expect(res.status).toBe(200);
    // Re-derived from the verified token: a device can never launder itself into
    // the un-revocable bare "host".
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("host:device-1");
  });

  it("rejects a CROSS-ORIGIN device request", async () => {
    // Untested until now, which meant this property rested on somebody reading the
    // function rather than on anything failing if it regressed.
    const t = await mkDeviceToken();
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/sessions`, {
      method: "GET",
      headers: {
        host: TUNNEL_HOST,
        origin: "https://evil.example.com",
        cookie: `hooop_host_device=${t}`,
      },
    }));
    expect(res.status).toBe(403);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBeNull();
  });

  it("rate-limits a device's mutating requests, keyed on its own cookie", async () => {
    const limiter = rateLimit.createRateLimiter({ max: 2, windowMs: 60_000 });
    originalCheck = rateLimit.mutatingRequestLimiter.check;
    rateLimit.mutatingRequestLimiter.check = (k: string) => limiter.check(k);

    const t = await mkDeviceToken();
    const post = () => mod.proxy(deviceReq({
      method: "POST", pathname: "/api/sessions/sess-1/message",
      cookie: `hooop_host_device=${t}`, dashboardHeader: t,
    }));
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(429);

    // A different device has its own budget: the key is the cookie, not the host.
    const other = await mkDeviceToken({ did: "device-2" });
    const res = await mod.proxy(deviceReq({
      method: "POST", pathname: "/api/sessions/sess-1/message",
      cookie: `hooop_host_device=${other}`, dashboardHeader: other,
    }));
    expect(res.status).toBe(200);
  });

  it("device mutation requires the double-submit header equal to the device cookie", async () => {
    const t = await mkDeviceToken();
    const noHeader = await mod.proxy(deviceReq({
      method: "POST", pathname: "/api/sessions/sess-1/message", cookie: `hooop_host_device=${t}`,
    }));
    expect(noHeader.status).toBe(401);

    const wrongHeader = await mod.proxy(deviceReq({
      method: "POST", pathname: "/api/sessions/sess-1/message",
      cookie: `hooop_host_device=${t}`, dashboardHeader: `${t}x`,
    }));
    expect(wrongHeader.status).toBe(401);

    const ok = await mod.proxy(deviceReq({
      method: "POST", pathname: "/api/sessions/sess-1/message",
      cookie: `hooop_host_device=${t}`, dashboardHeader: t,
    }));
    expect(ok.status).toBe(200);
  });

  it("a device does NOT get the install token as its double-submit value", async () => {
    // Belt and braces on the layout's rule: presenting the install token with a
    // device cookie must not satisfy the check, or the phone would need a copy
    // of the very secret this feature exists to avoid copying.
    const t = await mkDeviceToken();
    const res = await mod.proxy(deviceReq({
      method: "POST", pathname: "/api/sessions/sess-1/message",
      cookie: `hooop_host_device=${t}`, dashboardHeader: token,
    }));
    expect(res.status).toBe(401);
  });

  it("the device cookie outranks a peer cookie held by the same browser", async () => {
    // Enrolling your phone after having paired it into a session should promote
    // it, not leave it pinned to that one session as a guest.
    const dev = await mkDeviceToken();
    const peer = await mkPeerToken();
    const res = await mod.proxy(deviceReq({
      pathname: "/api/sessions",
      cookie: `hooop_peer=${peer}; hooop_host_device=${dev}`,
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("host:device-1");
  });

  it("a dead device cookie falls back to a still-valid peer cookie", async () => {
    // Losing host authority should not also cost you the guest access you
    // legitimately still hold.
    const dev = await mkDeviceToken({ exp: Date.now() - 1000 });
    const peer = await mkPeerToken();
    const res = await mod.proxy(deviceReq({
      pathname: "/api/sessions",
      cookie: `hooop_peer=${peer}; hooop_host_device=${dev}`,
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("peer:share-1");
  });

  it("enrollment endpoints are reachable without a cookie", async () => {
    // The phone being enrolled holds nothing yet — that is the problem being
    // solved — so both halves must be reachable pre-credential.
    const page = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/enroll`, {
      method: "GET", headers: { host: TUNNEL_HOST },
    }));
    expect(page.status).toBe(200);
    const post = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/host-device/enroll`, {
      method: "POST",
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, "content-type": "application/json" },
    }));
    expect(post.status).toBe(200); // passthrough; the route itself validates
  });

  it("the code-minting endpoint is NOT reachable from the tunnel without a credential", async () => {
    // Only /api/host-device/enroll is pre-auth. Minting a code is host-only, so a
    // cookieless tunnel request must die on the ordinary rebinding defence.
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/host-device/code`, {
      method: "POST",
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, "content-type": "application/json" },
    }));
    expect(res.status).toBe(403);
  });
});

describe("proxy — revocation, checked once for everything", () => {
  // A signed token stays cryptographically valid after the grant behind it is
  // revoked, so every check above proves issuance and nothing more. This is the
  // one place that asks the sandbox whether the grant is still live — which is why
  // it is the one place worth testing for it. It used to be a helper each route
  // remembered to call, and the two thirds of routes that never called it were the
  // hole: a revoked peer kept reading files, previews, skills and agents.
  let access: typeof import("./lib/access");
  let live: boolean;

  beforeEach(async () => {
    live = true;
    vi.doMock("@/lib/sandbox-client", () => ({
      client: {
        validateShare: async () => (live ? { shareId: "share-1", sessionId: "sess-1" } : null),
        hostDeviceLive: async () => (live ? { deviceId: "device-1", label: "Pixel" } : null),
      },
    }));
    vi.resetModules();
    mod = await import("./proxy");
    peerToken = await import("./lib/peer-token");
    access = await import("./lib/access");
    access.__resetAccessCacheForTests();
  });

  afterEach(() => {
    vi.doUnmock("@/lib/sandbox-client");
  });

  it("refuses a revoked PEER on any api path, including ones no route ever guarded", async () => {
    live = false;
    const t = await mkPeerToken();
    for (const pathname of ["/api/files", "/api/previews", "/api/skills", "/api/agents", "/api/events"]) {
      const res = await mod.proxy(peerReq({ pathname, cookieToken: t }));
      expect(res.status, pathname).toBe(403);
    }
  });

  it("refuses a revoked DEVICE on any api path", async () => {
    live = false;
    const t = await peerToken.signHostDeviceToken({ did: "device-1", host: TUNNEL_HOST }, PEER_SECRET);
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/files`, {
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, cookie: `hooop_host_device=${t}` },
    }));
    expect(res.status).toBe(403);
    // And it is never forwarded as the host to anything downstream.
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBeNull();
  });

  it("lets a live grant through untouched", async () => {
    const t = await mkPeerToken();
    const res = await mod.proxy(peerReq({ pathname: "/api/files", cookieToken: t }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("peer:share-1");
  });

  it("sends a revoked PAGE request to the signed-out page, not to a broken shell", async () => {
    // Rendering would show the host's empty new-session form, since every request
    // behind it is refused — which reads as the app being broken rather than as
    // access having ended.
    live = false;
    const t = await mkPeerToken();
    const res = await mod.proxy(peerReq({ pathname: "/", cookieToken: t }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/left");
  });

  it("tells a revoked device it was the DEVICE, not a share", async () => {
    live = false;
    const t = await peerToken.signHostDeviceToken({ did: "device-1", host: TUNNEL_HOST }, PEER_SECRET);
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/`, {
      headers: { host: TUNNEL_HOST, cookie: `hooop_host_device=${t}` },
    }));
    expect(res.headers.get("location")).toContain("as=device");
  });

  it("does not redirect the signed-out page to itself", async () => {
    // It is where the redirect points, so gating it would loop forever.
    live = false;
    const t = await mkPeerToken();
    const res = await mod.proxy(peerReq({ pathname: "/left", cookieToken: t }));
    expect(res.status).toBe(200);
  });

  it("serves a browser whose DEVICE was revoked but whose PEER share is live", async () => {
    // The reported sequence: add a device, revoke it, then join that same browser
    // as a guest and be admitted. Preferring the device cookie unconditionally
    // meant the revoked one shadowed the good peer cookie — the peer was refused
    // as a dead device, and the peer cookie was never even consulted. Revocation is
    // invisible to a signature check, so "prefer the device" has to mean "prefer a
    // LIVE device".
    const dev = await peerToken.signHostDeviceToken({ did: "device-1", host: TUNNEL_HOST }, PEER_SECRET);
    const peer = await mkPeerToken();
    vi.doMock("@/lib/sandbox-client", () => ({
      client: {
        validateShare: async () => ({ shareId: "share-1", sessionId: "sess-1" }), // live
        hostDeviceLive: async () => null,                                          // revoked
      },
    }));
    vi.resetModules();
    const fresh = await import("./proxy");

    const res = await fresh.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/sessions`, {
      headers: {
        host: TUNNEL_HOST,
        origin: `https://${TUNNEL_HOST}`,
        cookie: `hooop_peer=${peer}; hooop_host_device=${dev}`,
      },
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("peer:share-1");
    // And the dead cookie is dropped, so it cannot shadow again on the next request.
    expect(res.headers.get("set-cookie") ?? "").toContain("hooop_host_device=;");
  });

  it("still refuses a revoked device when there is nothing else to fall back to", async () => {
    live = false;
    const dev = await peerToken.signHostDeviceToken({ did: "device-1", host: TUNNEL_HOST }, PEER_SECRET);
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/sessions`, {
      headers: { host: TUNNEL_HOST, origin: `https://${TUNNEL_HOST}`, cookie: `hooop_host_device=${dev}` },
    }));
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie") ?? "").toContain("hooop_host_device=;");
  });

  it("prefers the device when BOTH are live", async () => {
    // The original rule still holds: enrolling your phone after pairing it in
    // should promote it, not leave it pinned to one session as a guest.
    const dev = await peerToken.signHostDeviceToken({ did: "device-1", host: TUNNEL_HOST }, PEER_SECRET);
    const peer = await mkPeerToken();
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/sessions`, {
      headers: {
        host: TUNNEL_HOST,
        origin: `https://${TUNNEL_HOST}`,
        cookie: `hooop_peer=${peer}; hooop_host_device=${dev}`,
      },
    }));
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("host:device-1");
  });

  it("falls back on a PAGE request too, instead of bouncing the peer to /left", async () => {
    const dev = await peerToken.signHostDeviceToken({ did: "device-1", host: TUNNEL_HOST }, PEER_SECRET);
    const peer = await mkPeerToken();
    vi.doMock("@/lib/sandbox-client", () => ({
      client: {
        validateShare: async () => ({ shareId: "share-1", sessionId: "sess-1" }),
        hostDeviceLive: async () => null,
      },
    }));
    vi.resetModules();
    const fresh = await import("./proxy");

    const res = await fresh.proxy(new NextRequest(`https://${TUNNEL_HOST}/?session=sess-1`, {
      headers: { host: TUNNEL_HOST, cookie: `hooop_peer=${peer}; hooop_host_device=${dev}` },
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-request-x-hooop-participant")).toBe("peer:share-1");
  });

  it("refuses when BOTH grants are gone, naming the device", async () => {
    live = false;
    const dev = await peerToken.signHostDeviceToken({ did: "device-1", host: TUNNEL_HOST }, PEER_SECRET);
    const peer = await mkPeerToken();
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/api/sessions`, {
      headers: {
        host: TUNNEL_HOST,
        origin: `https://${TUNNEL_HOST}`,
        cookie: `hooop_peer=${peer}; hooop_host_device=${dev}`,
      },
    }));
    expect(res.status).toBe(403);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "device revoked" });
  });

  it("never probes for the host at the machine", async () => {
    // Their authority is the install cookie: nothing to revoke, so a round trip
    // per request would be pure cost.
    let probed = false;
    vi.doMock("@/lib/sandbox-client", () => ({
      client: {
        validateShare: async () => { probed = true; return null; },
        hostDeviceLive: async () => { probed = true; return null; },
      },
    }));
    vi.resetModules();
    const fresh = await import("./proxy");
    const res = await fresh.proxy(reqWith({ pathname: "/api/sessions", cookie: `hooop_token=${token}` }));
    expect(res.status).toBe(200);
    expect(probed).toBe(false);
  });
});

describe("proxy — the tunnel is not an app you can just open", () => {
  // The third and last way to arrive at the host's empty "Start a session" form:
  // no credential at all. It used to render the shell as nobody, so every request
  // behind it 403'd and the screen looked broken rather than closed.
  it("sends a cookieless page request on the tunnel to the signed-out page", async () => {
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/`, {
      headers: { host: TUNNEL_HOST },
    }));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/left");
    // No variant: this person never had access to lose.
    expect(res.headers.get("location")).not.toContain("as=");
  });

  it("drops any query on the way, so it cannot carry a session id", async () => {
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/?session=sess-1`, {
      headers: { host: TUNNEL_HOST },
    }));
    expect(res.headers.get("location")).not.toContain("session=");
  });

  it("still renders the signed-out page itself", async () => {
    const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}/left`, {
      headers: { host: TUNNEL_HOST },
    }));
    expect(res.status).toBe(200);
  });

  it("leaves the three pre-credential doors open", async () => {
    // A guest and a device both arrive holding nothing; if these closed, nobody
    // could ever get in.
    for (const pathname of ["/join/share-1", "/enroll"]) {
      const res = await mod.proxy(new NextRequest(`https://${TUNNEL_HOST}${pathname}`, {
        headers: { host: TUNNEL_HOST },
      }));
      expect(res.status, pathname).toBe(200);
    }
  });

  it("leaves the host on localhost completely alone", async () => {
    const res = await mod.proxy(reqWith({ pathname: "/" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie") ?? "").toContain("hooop_token=");
  });
});
