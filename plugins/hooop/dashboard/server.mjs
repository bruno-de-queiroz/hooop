// Front process for the dashboard container.
//
// Why this exists: the browser↔dashboard live channel was Server-Sent Events
// (`/api/stream`). SSE works locally, but Cloudflare quick tunnels (and other
// buffering proxies) buffer the entire `text/event-stream` response and never
// flush it, so a remote co-driving peer never receives live events. WebSockets
// are an upgrade protocol, not a buffered HTTP response, and pass through CF
// tunnels unbuffered — so the live channel is now a WebSocket at `/api/ws`.
//
// Next.js standalone doesn't let us attach an HTTP `upgrade` handler to its
// server, so this thin front process:
//   1. spawns the UNCHANGED Next standalone server on an internal port,
//   2. transparently reverse-proxies all HTTP to it (Next still runs every
//      middleware/route/auth check exactly as before — this process adds no
//      HTTP auth of its own),
//   3. serves the one thing Next can't: the `/api/ws` upgrade. The WS bridge
//      consumes Next's own `/api/stream` over localhost (where SSE streams
//      fine) and re-broadcasts each frame to WebSocket clients, scoped so a
//      peer only receives events for the session they were shared into.
//
// Net: zero changes to the Next app; the buffering-proxy problem is solved at
// the transport layer.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { request as udsRequest } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";
import { autoShareSweep as reconcileAutoShare, createCoalescingRunner } from "./auto-share.mjs";
import { waitForTunnelReachable } from "./tunnel-reachability.mjs";
import { parseQuickTunnelUrl } from "./quick-tunnel-url.mjs";
import { cloudflaredArgs, startTunnelWithRetry } from "./tunnel-start.mjs";
import {
  driverScriptFor, DRIVER_SCRIPT_PATH, DRIVER_SOCKET_PATH, SCRIPT_TAG,
  injectScript, isInjectableHtml, isDocumentRequest, createDriverRegistry,
} from "./preview-driver.mjs";

// Dev mode (HMR): when the CLI's HOOOP_DASHBOARD_DEV override is active, run the
// full `next dev` server on the internal port instead of the baked standalone
// `server.js`, and proxy Next's own HMR websocket (/_next/webpack-hmr) through
// this front process. Off by default → the prod path is byte-identical.
const DEV = /^(1|true|yes|on)$/i.test(process.env.HOOOP_DASHBOARD_DEV ?? "");

const PUBLIC_PORT = parseInt(process.env.HOOOP_PORT ?? "", 10) || 7842;
const PUBLIC_HOST = process.env.HOSTNAME || "0.0.0.0";
const INTERNAL_PORT = PUBLIC_PORT + 1; // Next standalone, loopback only
const INTERNAL_HOST = "127.0.0.1";

const DASHBOARD_TOKEN = process.env.HOOOP_DASHBOARD_TOKEN ?? "";
const PEER_SECRET = process.env.HOOOP_PEER_SIGNING_SECRET ?? "";
const PEER_COOKIE = "hooop_peer";
const INSTALL_COOKIE = "hooop_token";
// The host's own enrolled device, arriving over the tunnel. Its install cookie is
// scoped to the dashboard origin and never reaches *.trycloudflare.com, so this
// signed token is the only evidence the operator is the operator out there.
const HOST_DEVICE_COOKIE = "hooop_host_device";

// Sandbox UDS — used to check share revocation for the live (WS) channel, so a
// revoked peer's feed is cut, not just their writes.
const SANDBOX_SOCKET = process.env.HOOOP_SANDBOX_SOCKET || "/var/run/hooop/sandbox.sock";
const SANDBOX_TOKEN_FILE = process.env.HOOOP_SANDBOX_TOKEN_FILE || "/var/run/hooop/sandbox.token";
const SANDBOX_TOKEN_HEADER = "x-sandbox-token";
/**
 * Read fresh each time rather than caching: the sandbox rotates this file, and a
 * front process holding a stale token would fail every call with a 401 that
 * looks exactly like a permissions bug.
 */
function readSandboxToken() {
  try { return readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { return ""; }
}

const log = (...a) => console.log("[front]", ...a);

// Is a share still live? The sandbox is the authority: GET /shares/:id returns
// 200 for a live grant, 404 once revoked/expired. Fail-open on transient
// errors (local UDS blip shouldn't drop an active pairing — the next check
// retries, and peer READ paths are guarded independently). Only an explicit
// 404 means "revoked".
function shareLive(shareId) {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token || !shareId) return resolve(true); // can't check → don't over-drop
    const r = udsRequest(
      { socketPath: SANDBOX_SOCKET, method: "GET", path: `/shares/${encodeURIComponent(shareId)}`,
        headers: { [SANDBOX_TOKEN_HEADER]: token }, timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode !== 404); },
    );
    r.on("error", () => resolve(true));
    r.on("timeout", () => { r.destroy(); resolve(true); });
    r.end();
  });
}

// Is an enrolled host device still live? Exact counterpart of shareLive, same
// fail-open reasoning: only an explicit 404 means revoked, because dropping the
// operator's phone off the live feed on a local socket blip would be a worse bug
// than a few extra seconds of a grant we are about to re-check anyway.
function deviceLive(deviceId) {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token || !deviceId) return resolve(true); // can't check → don't over-drop
    const r = udsRequest(
      { socketPath: SANDBOX_SOCKET, method: "GET", path: `/host-devices/${encodeURIComponent(deviceId)}`,
        headers: { [SANDBOX_TOKEN_HEADER]: token }, timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode !== 404); },
    );
    r.on("error", () => resolve(true));
    r.on("timeout", () => { r.destroy(); resolve(true); });
    r.end();
  });
}

// Revoke every share in the sandbox. Called whenever the tunnel goes away
// (stop, host DELETE, or cloudflared dying): each share is bound to the tunnel
// hostname that just disappeared, so the grants are now dangling and must be
// cleared — otherwise the peer read guard (which checks shareId only, not host)
// would keep an already-connected peer alive against a dead tunnel. Fire-and-
// forget + short timeout so it never blocks tunnel teardown or shutdown.
function revokeAllSharesInSandbox() {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token) return resolve();
    const r = udsRequest(
      { socketPath: SANDBOX_SOCKET, method: "POST", path: "/shares/revoke-all",
        headers: { [SANDBOX_TOKEN_HEADER]: token, "content-length": 0 }, timeout: 3000 },
      (res) => { res.resume(); res.on("end", resolve); },
    );
    r.on("error", () => resolve());
    r.on("timeout", () => { r.destroy(); resolve(); });
    r.end();
  });
}

// ── 1. Spawn the Next server on the internal port ────────────────────────────
// Prod: the traced standalone `server.js`. Dev: `next dev` (webpack HMR) from
// the bind-mounted source, so edits are live without an image rebuild.
const next = DEV
  ? spawn(
      "./node_modules/.bin/next",
      ["dev", "--webpack", "-p", String(INTERNAL_PORT), "-H", INTERNAL_HOST],
      { env: { ...process.env }, stdio: "inherit" },
    )
  : spawn("node", ["server.js"], {
      env: { ...process.env, PORT: String(INTERNAL_PORT), HOSTNAME: INTERNAL_HOST },
      stdio: "inherit",
    });
if (DEV) log(`dev mode: next dev (webpack HMR) on ${INTERNAL_HOST}:${INTERNAL_PORT}`);
next.on("exit", (code) => { log("next exited", code); process.exit(code ?? 1); });
process.on("SIGTERM", () => next.kill("SIGTERM"));
process.on("SIGINT", () => next.kill("SIGINT"));

// ── auth helpers (mirror lib/peer-token.ts + lib/auth-edge.ts) ───────────────
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function ctEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
function b64urlFromBuf(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function normHost(h) {
  if (!h) return "";
  let s = h.trim().toLowerCase();
  if (s.startsWith("[")) { const e = s.indexOf("]"); return e >= 0 ? s.slice(0, e + 1) : s; }
  const c = s.indexOf(":");
  return c >= 0 ? s.slice(0, c) : s;
}
// Verify a dashboard-signed peer token: base64url(payload).base64url(hmacSHA256(payload)).
function verifyPeerToken(token) {
  if (!token || !PEER_SECRET) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const expected = b64urlFromBuf(createHmac("sha256", PEER_SECRET).update(payloadB64).digest());
  if (!ctEq(sigB64, expected)) return null;
  let payload;
  try {
    const json = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    payload = JSON.parse(json);
  } catch { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}
// Resolve the participant for a WS upgrade. Returns {kind:"host"} |
// {kind:"peer", ses, allowed:Set} | null. Same-origin enforced (the cookies are
// SameSite=Strict, so a cross-site WS wouldn't carry them anyway).
function authUpgrade(req) {
  const host = normHost(req.headers.host);
  const origin = req.headers.origin;
  if (origin) {
    try { if (normHost(new URL(origin).host) !== host) return null; } catch { return null; }
  }
  const cookies = parseCookies(req.headers.cookie);
  if (DASHBOARD_TOKEN && ctEq(cookies[INSTALL_COOKIE] ?? "", DASHBOARD_TOKEN)) {
    return { kind: "host" };
  }
  // The host on one of their own enrolled devices. Checked BEFORE the peer cookie
  // for the same reason the middleware does it: a browser can hold both (you
  // paired yourself into a session, then enrolled the same phone), and the device
  // is the stronger claim — a feed scoped to one session is not what the operator
  // asked for. `kind === "host"` is required, so a peer token dropped into this
  // cookie resolves to nothing; without that check the two credentials would be
  // interchangeable, since they share a signing secret.
  const deviceTok = cookies[HOST_DEVICE_COOKIE];
  if (deviceTok) {
    const d = verifyPeerToken(deviceTok);
    if (d && d.kind === "host" && d.host === host && d.did) {
      return { kind: "host", did: d.did };
    }
  }
  const peerTok = cookies[PEER_COOKIE];
  if (peerTok) {
    const p = verifyPeerToken(peerTok);
    // A host device token must never satisfy the peer path either: it carries no
    // session, so `p.ses` already rejects it, but say so explicitly rather than
    // relying on a field being absent to keep the two apart.
    if (p && p.kind !== "host" && p.host === host && p.ses) {
      return { kind: "peer", ses: p.ses, sid: p.sid, allowed: new Set([p.ses]) };
    }
  }
  return null;
}

// ── managed cloudflare tunnel (host-controlled, on-demand) ──────────────────
// The host exposes the dashboard for peer co-drive without installing anything:
// this process spawns `cloudflared` (bundled in the image) as a quick tunnel to
// its own public port, parses the assigned *.trycloudflare.com hostname from
// cloudflared's output, and hands it to the dashboard so a share can be bound
// to it. On-demand only — nothing is exposed until the host starts it.
const tunnel = {
  proc: null,
  url: null,
  status: "stopped", // "stopped" | "starting" | "running" | "error"
  error: null,
  waiters: [], // resolvers awaiting the URL while a start is in progress
};
const TUNNEL_START_TIMEOUT_MS = 20_000;

// A registration failure is usually transient, so one spawn is not an answer.
// The dominant failure mode (a resolver that sinkholes api.trycloudflare.com)
// fails in well under a second, so the retries cost nothing in the common case;
// the deadline is what bounds the case where cloudflared hangs instead, since
// each attempt can burn TUNNEL_START_TIMEOUT_MS on its own.
const TUNNEL_START_ATTEMPTS = Math.max(1, Number(process.env.HOOOP_TUNNEL_ATTEMPTS) || 3);
const TUNNEL_START_DEADLINE_MS = Math.max(
  TUNNEL_START_TIMEOUT_MS,
  Number(process.env.HOOOP_TUNNEL_DEADLINE_MS) || 45_000,
);
const TUNNEL_RETRY_BASE_MS = 1_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref?.());

// Shared shape for both tunnel kinds: same flags, same retry policy, one place
// that explains why either is what it is.
const withTunnelRetry = (attempt, label, aborted) => startTunnelWithRetry({
  attempt,
  attempts: TUNNEL_START_ATTEMPTS,
  deadlineMs: TUNNEL_START_DEADLINE_MS,
  backoffMs: (n) => TUNNEL_RETRY_BASE_MS * n,
  sleep,
  aborted,
  label,
  log,
});

/**
 * Which of cloudflared's lines are worth the front log.
 *
 * Its output used to be consumed ONLY by the URL regex above and then dropped on
 * the floor, which made every tunnel problem invisible: a tunnel that failed
 * after printing its hostname looked identical to one that was merely slow to
 * propagate, and there was nothing in any log to tell them apart. It is chatty
 * (a line per edge connection), so INF/DBG is dropped and only the lines that
 * admit something went wrong are kept.
 */
const CLOUDFLARED_ALERT_RE = /\b(ERR|WRN|FTL)\b|error=|failed/i;

function pipeCloudflaredLog(proc, label) {
  for (const stream of [proc.stdout, proc.stderr]) {
    if (!stream) continue;
    // Chunks split lines wherever they please; buffer the tail so a message
    // never arrives in the log cut in half.
    let rest = "";
    stream.on("data", (chunk) => {
      const lines = (rest + chunk.toString()).split("\n");
      rest = lines.pop() ?? "";
      for (const line of lines) {
        const t = line.trim();
        if (t && CLOUDFLARED_ALERT_RE.test(t)) log(`cloudflared[${label}]`, t);
      }
    });
  }
}

/**
 * Spawn one cloudflared quick tunnel pointing at a local URL and resolve with
 * its assigned hostname.
 *
 * Factored out because previews need tunnels too, and a quick tunnel maps ONE
 * hostname to ONE origin — so a shared preview cannot ride on the session's
 * tunnel and needs its own process. (Multiplexing several origins behind one
 * hostname would need a NAMED tunnel, which requires a Cloudflare account and a
 * domain; quick tunnels are what makes pairing zero-setup, so that trade stands.)
 *
 * Resolves `{ proc, url }` on success or `{ error }` on failure/timeout; never
 * rejects, so callers can report rather than crash the front process.
 */
function spawnQuickTunnel(localUrl, onExit, label = localUrl) {
  return new Promise((resolve) => {
    let settled = false;
    let reported = false; // a hostname was parsed, so this tunnel really existed
    let proc;
    try {
      proc = spawn("cloudflared", cloudflaredArgs(localUrl), {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return resolve({ error: `could not start cloudflared: ${e.message}`, fatal: true });
    }
    pipeCloudflaredLog(proc, label);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const onData = (chunk) => {
      const url = parseQuickTunnelUrl(chunk.toString());
      if (url) { reported = true; finish({ proc, url }); }
    };
    // cloudflared prints its URL banner to stderr, not stdout.
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData);
    proc.on("error", (e) =>
      finish({ error: `could not start cloudflared: ${e.message}`, fatal: true }));
    proc.on("exit", (code) => {
      finish({ error: `cloudflared exited (${code}) before reporting a hostname` });
      // onExit means "the tunnel died on its own", and the caller uses it to tear
      // down state keyed to a hostname. An attempt that never got that far has no
      // such state, and firing here would have the caller clean up a live tunnel
      // belonging to whoever retried after it.
      if (reported && onExit) onExit(code);
    });

    const timer = setTimeout(() => {
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      finish({ error: "timed out waiting for tunnel hostname" });
    }, TUNNEL_START_TIMEOUT_MS);
  });
}

/** spawnQuickTunnel, but a lost coin-flip is not the answer. See tunnel-start.mjs. */
function spawnQuickTunnelWithRetry(localUrl, onExit, label = localUrl) {
  return withTunnelRetry(() => spawnQuickTunnel(localUrl, onExit, label), label);
}

function tunnelStatus() {
  return { status: tunnel.status, url: tunnel.url, error: tunnel.error };
}
function resolveTunnelWaiters() {
  const snap = tunnelStatus();
  for (const w of tunnel.waiters.splice(0)) w(snap);
}

/**
 * One spawn of the session tunnel.
 *
 * Resolves `{}` once cloudflared reports a hostname, or `{ error }` when this
 * attempt is spent. Deliberately does NOT publish a failure to `tunnel.status`
 * or wake the waiters: whether a failed attempt is the end of the story belongs
 * to startTunnel, and a transient one must never reach the UI.
 *
 * A death AFTER a hostname was reported is a different event, and this function
 * keeps owning it — that tunnel vanished out from under live shares, so the
 * handler below clears them. Retrying is only ever for the pre-hostname window.
 */
function attemptSessionTunnel() {
  return new Promise((resolve) => {
    let settled = false;
    let reported = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    let proc;
    try {
      proc = spawn("cloudflared", cloudflaredArgs(`http://127.0.0.1:${PUBLIC_PORT}`), {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      return finish({ error: `could not start cloudflared: ${e.message}`, fatal: true });
    }
    tunnel.proc = proc;
    // The session tunnel used to be the ONE cloudflared this process never
    // logged (spawnQuickTunnel has always piped its previews). So when it failed,
    // the front log showed a hostname and an exit code and nothing that said why —
    // which is exactly how a control-plane error got mistaken for a live tunnel.
    pipeCloudflaredLog(proc, "session");

    const onData = (chunk) => {
      if (reported) return;
      const url = parseQuickTunnelUrl(chunk.toString());
      if (!url) return;
      reported = true;
      tunnel.url = url;
      tunnel.status = "running";
      log("tunnel up:", tunnel.url);
      resolveTunnelWaiters();
      finish({});
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", onData); // cloudflared prints the URL banner to stderr

    proc.on("exit", (code) => {
      log("cloudflared exited", code);
      // False once a later attempt (or a stop) has taken tunnel.proc, which makes
      // this the corpse of one we already gave up on: it may no longer speak for
      // the tunnel's state.
      const mine = tunnel.proc === proc;
      if (mine) tunnel.proc = null;
      // Settling the ATTEMPT is unconditional even so. stopTunnel() clears
      // tunnel.proc and then kills us, and if that exit returned early here the
      // start would sit waiting on a timer with nothing left to wait for.
      if (!reported) {
        return finish({ error: `cloudflared exited (${code}) before reporting a hostname` });
      }
      if (!mine) return;
      if (tunnel.status === "stopped") return; // intentional stop; stopTunnel() did the cleanup
      // Unexpected death of a tunnel that WAS live — shares are bound to a
      // hostname that no longer routes, so clear them now.
      tunnel.status = "error";
      tunnel.error = "tunnel process exited";
      tunnel.url = null;
      void revokeAllSharesInSandbox();
      resolveTunnelWaiters();
    });
    proc.on("error", (e) => {
      log("cloudflared spawn error", e.message);
      if (tunnel.proc === proc) tunnel.proc = null;
      finish({ error: `could not start cloudflared: ${e.message}`, fatal: true });
    });

    const timer = setTimeout(() => {
      // Leave tunnel.proc set: the exit this kill provokes should still be seen
      // as this attempt's, so it can't be mistaken for a later one's.
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      finish({ error: "timed out waiting for tunnel hostname" });
    }, TUNNEL_START_TIMEOUT_MS);
  });
}

async function startTunnel() {
  // Idempotent: a running/starting tunnel just yields its current state.
  if (tunnel.status === "running") return tunnelStatus();
  if (tunnel.status === "starting") {
    return new Promise((resolve) => tunnel.waiters.push(resolve));
  }
  tunnel.status = "starting";
  tunnel.url = null;
  tunnel.error = null;

  // "Abort" here is stopTunnel() landing mid-start: the host asked for no tunnel,
  // so leave "stopped" standing rather than retrying into it. attemptSessionTunnel
  // publishes success itself, so only the give-up path is left to report.
  const last = await withTunnelRetry(
    attemptSessionTunnel,
    "session",
    () => tunnel.status !== "starting",
  );
  if (!last.error || last.aborted) return tunnelStatus();

  tunnel.status = "error";
  tunnel.error = last.error;
  tunnel.url = null;
  resolveTunnelWaiters();
  return tunnelStatus();
}

function stopTunnel() {
  const proc = tunnel.proc;
  tunnel.proc = null;
  tunnel.status = "stopped";
  tunnel.url = null;
  tunnel.error = null;
  // Kill the durable auth BEFORE the tunnel dies so a peer mid-request can't
  // slip through as it closes (same ordering the UI's stopSharing relies on).
  void revokeAllSharesInSandbox();
  if (proc) { try { proc.kill("SIGTERM"); } catch {} }
  resolveTunnelWaiters();
  return tunnelStatus();
}

process.on("SIGTERM", () => { stopTunnel(); stopAllPreviewTunnels(); });
process.on("SIGINT", () => { stopTunnel(); stopAllPreviewTunnels(); });

// Host-only gate for the front process's own /api/tunnel endpoints. Peers never
// hold the install cookie; same-origin blocks cross-site CSRF (the cookie is
// SameSite=Strict, but we check Origin explicitly for mutations too).
//
// Async because the operator may also be on one of their OWN enrolled devices,
// out on the tunnel where the install cookie cannot reach — and that credential is
// revocable, so answering "is this the host?" means asking the sandbox whether the
// device is still enrolled. The install-cookie path stays synchronous in effect
// (it short-circuits before any I/O) and unchanged in behaviour.
//
// The device gets the FULL set of these controls, stopping the tunnel included.
// That is the chosen model — one identity, several screens — and it is also the
// most useful thing a phone can do here: killing the pairing from wherever you
// happen to be standing is exactly when you most want to.
async function isHostRequest(req) {
  const host = normHost(req.headers.host);
  const origin = req.headers.origin;
  if (origin) {
    try { if (normHost(new URL(origin).host) !== host) return false; } catch { return false; }
  }
  const cookies = parseCookies(req.headers.cookie);
  if (!!DASHBOARD_TOKEN && ctEq(cookies[INSTALL_COOKIE] ?? "", DASHBOARD_TOKEN)) return true;
  const deviceTok = cookies[HOST_DEVICE_COOKIE];
  if (!deviceTok) return false;
  const d = verifyPeerToken(deviceTok);
  // `kind === "host"` is required so a peer token in this cookie proves nothing;
  // the host binding stops a grant minted for a dead tunnel being replayed on a
  // new one. Revocation is the sandbox's answer, not ours.
  if (!d || d.kind !== "host" || d.host !== host || !d.did) return false;
  return deviceLive(d.did);
}
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}
// Handle /api/tunnel entirely in the front process (cloudflared lives here, not
// in Next). Returns true if the request was handled.
async function handleTunnel(req, res) {
  if ((req.url || "").split("?")[0] !== "/api/tunnel") return false;
  if (!(await isHostRequest(req))) { sendJson(res, 403, { error: "host only" }); return true; }
  if (req.method === "GET") { sendJson(res, 200, tunnelStatus()); return true; }
  if (req.method === "POST") {
    const s = await startTunnel();
    sendJson(res, s.status === "running" ? 200 : 502, s);
    return true;
  }
  if (req.method === "DELETE") { sendJson(res, 200, stopTunnel()); return true; }
  sendJson(res, 405, { error: "method not allowed" });
  return true;
}

// ── live previews ────────────────────────────────────────────────────────────
//
// A preview runs in its own container (preview-runner-N) and serves on a fixed
// container port. This process is the ONLY door to it: compose publishes
// 7850-7852 here, not on the runners, so every preview request passes a cookie
// gate instead of being reachable by anything on host loopback.
//
// The same listener serves two audiences, distinguished only by their cookie:
//   - the HOST, arriving on 127.0.0.1:785N with the install cookie;
//   - a PEER, arriving over that slot's cloudflared tunnel with a preview grant.
// One code path, because the interesting check — "is the share behind this
// still live?" — is identical for both.
//
// A distinct port (and, for peers, a distinct hostname) is also a distinct
// ORIGIN. That is not incidental: it is what stops agent-authored JS in the
// preview from reading the hooop API. Cookies are not port-scoped, so the
// install cookie does reach :7850 — but a cross-origin fetch back to :7842 is
// refused by the same-origin check in proxy.ts.

const PREVIEW_SLOTS = 3;
const PREVIEW_PORT_BASE = parseInt(process.env.HOOOP_PREVIEW_PORT_BASE ?? "", 10) || 7850;
const PREVIEW_COOKIE = "hooop_preview";
const PREVIEW_AUTH_PREFIX = "/__hooop";
/** How long a slot→preview lookup is reused. Short: a slot can change hands. */
const PREVIEW_CACHE_MS = 2000;
/** Matches the WS reaper's cadence — a revoked share loses access this fast. */
const SHARE_LIVE_CACHE_MS = 5000;

/** GET /previews from the sandbox (host-only route). */
function fetchPreviews() {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token) return resolve([]);
    const r = udsRequest(
      {
        socketPath: SANDBOX_SOCKET, method: "GET", path: "/previews", timeout: 5000,
        headers: { [SANDBOX_TOKEN_HEADER]: token, "x-hooop-participant": "host" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")).previews ?? []); }
          catch { resolve([]); }
        });
      },
    );
    r.on("error", () => resolve([]));
    r.on("timeout", () => { r.destroy(); resolve([]); });
    r.end();
  });
}

/** GET /shares from the sandbox (host view: every live share). */
function fetchShares() {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token) return resolve([]);
    const r = udsRequest(
      {
        socketPath: SANDBOX_SOCKET, method: "GET", path: "/shares", timeout: 5000,
        headers: { [SANDBOX_TOKEN_HEADER]: token, "x-hooop-participant": "host" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")).shares ?? []); }
          catch { resolve([]); }
        });
      },
    );
    r.on("error", () => resolve([]));
    r.on("timeout", () => { r.destroy(); resolve([]); });
    r.end();
  });
}

/** Record a preview's public URL with the sandbox, which owns the record. */
function recordPreviewShared(sessionId, previewId, url) {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token) return resolve(false);
    const payload = JSON.stringify({ url });
    const r = udsRequest(
      {
        socketPath: SANDBOX_SOCKET, method: "POST", timeout: 5000,
        path: `/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(previewId)}/share`,
        headers: {
          [SANDBOX_TOKEN_HEADER]: token, "x-hooop-participant": "host",
          "content-type": "application/json", "content-length": Buffer.byteLength(payload),
        },
      },
      (res) => { res.resume(); res.on("end", () => resolve(res.statusCode === 200)); },
    );
    r.on("error", () => resolve(false));
    r.on("timeout", () => { r.destroy(); resolve(false); });
    r.end(payload);
  });
}

// Has a share existed since this process started? The reconciler needs it to tell
// "the last share just went away" (close the tunnel) from "the host opened a
// tunnel and has not invited anyone yet" (leave it alone). Process state, so it
// lives here beside the debounce rather than in the policy module.
let _sawAnyShare = false;
/**
 * Run one auto-share reconcile pass. The policy lives in auto-share.mjs so it
 * can be tested — this process boots real listeners and spawns cloudflared, so
 * nothing in here is reachable from a unit test. Here we own only the wiring of
 * side effects; serialization is createCoalescingRunner's job, below.
 *
 * Note the direction of travel is preserved: this PULLS from the sandbox and
 * then records the result, exactly as the Next route does, so the
 * sandbox→dashboard arrow still does not exist (see handlePreviewTunnel).
 */
// A failed share does not heal on its own: the sweep only runs on an event, and
// the events that would have re-triggered it are exactly the ones swallowed
// while it was busy failing. One chained retry covers the transient case (a
// refused record, a tunnel that lost a DNS coin-flip) without turning a
// PERMANENT failure into a cloudflared spawn loop. Deliberately one and not
// three: startPreviewTunnel already retries internally, so this is a second
// chance, not a policy of persistence. Cleared by the first clean pass.
const AUTO_SHARE_RETRY_MS = 10_000;
let autoShareRetried = false;

async function runAutoShareSweep() {
  try {
    const result = await reconcileAutoShare({
      fetchPreviews, fetchShares, startPreviewTunnel, stopPreviewTunnel,
      recordPreviewShared, log,
      // Tunnel teardown, the other half of the reconcile: previews now end on
      // their own (the sandbox releases an idle session's preview), so nothing
      // calls a "close the tunnel" endpoint for them.
      liveTunnelSlots: () => [...previewTunnels.keys()],
      dashboardTunnelUp: () => tunnel.status === "running",
      stopDashboardTunnel: () => { stopTunnel(); },
      sawAnyShare: () => _sawAnyShare,
      setSawAnyShare: (v) => { _sawAnyShare = v; },
    });
    if (result.failed.length === 0) {
      autoShareRetried = false;
    } else if (!autoShareRetried) {
      autoShareRetried = true;
      log("auto-share:", result.failed.length, "preview(s) failed to share - one retry queued");
      scheduleAutoShareSweep(AUTO_SHARE_RETRY_MS);
    } else {
      // Say so rather than going quiet: a preview that stays unshared with
      // nothing in the log is the shape this whole bug had.
      log("auto-share:", result.failed.length, "preview(s) still failing after a retry - giving up until the next event");
    }
  } catch (e) {
    log("auto-share sweep failed", String(e));
  }
}

// Serialized, and a trigger that lands mid-pass is REPLAYED rather than dropped.
// See createCoalescingRunner: nothing sweeps on a timer, so a dropped trigger is
// a preview that stays unshared until something unrelated happens to nudge it.
const autoShareSweep = createCoalescingRunner({
  run: runAutoShareSweep,
  schedule: () => scheduleAutoShareSweep(),
});

// Debounced, because a single share or preview transition produces a burst of
// stream frames and the sweep costs two UDS round trips.
let autoShareTimer = null;
function scheduleAutoShareSweep(delayMs = 500) {
  if (autoShareTimer) return;
  autoShareTimer = setTimeout(() => { autoShareTimer = null; void autoShareSweep(); }, delayMs);
  autoShareTimer.unref?.();
}

let previewCache = { at: 0, bySlot: new Map() };
async function previewOnSlot(slot) {
  const now = Date.now();
  if (now - previewCache.at > PREVIEW_CACHE_MS) {
    const list = await fetchPreviews();
    previewCache = { at: now, bySlot: new Map(list.map((p) => [p.slot, p])) };
  }
  return previewCache.bySlot.get(slot) ?? null;
}

const shareLiveCache = new Map();
async function shareLiveCached(shareId) {
  const hit = shareLiveCache.get(shareId);
  if (hit && Date.now() - hit.at < SHARE_LIVE_CACHE_MS) return hit.live;
  const live = await shareLive(shareId);
  shareLiveCache.set(shareId, { at: Date.now(), live });
  return live;
}

// Same cache, same window, for enrolled devices: a preview iframe makes a request
// per asset, and none of them should each cost a round trip to the sandbox.
const deviceLiveCache = new Map();
async function deviceLiveCached(deviceId) {
  const hit = deviceLiveCache.get(deviceId);
  if (hit && Date.now() - hit.at < SHARE_LIVE_CACHE_MS) return hit.live;
  const live = await deviceLive(deviceId);
  deviceLiveCache.set(deviceId, { at: Date.now(), live });
  return live;
}

/** Node-side mirror of lib/preview-token.ts (same construction, same secret). */
function verifyPreviewToken(token) {
  if (!token || !PEER_SECRET) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const expected = b64urlFromBuf(createHmac("sha256", PEER_SECRET).update(payloadB64).digest());
  if (!ctEq(token.slice(dot + 1), expected)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
  } catch { return null; }
  if (!payload?.pv || !payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

/**
 * May this request load the preview on this slot?
 *
 * The grant is never the whole answer. A peer's access is re-derived from their
 * SHARE on every request (cached ~5s), so revoking a share, denying a join or a
 * peer leaving cuts them off within seconds even though the signed token they
 * hold is still perfectly valid.
 */
async function authorizePreview(req, preview) {
  const host = normHost(req.headers.host);
  const cookies = parseCookies(req.headers.cookie);

  // The local operator, on the published port.
  if (DASHBOARD_TOKEN && ctEq(cookies[INSTALL_COOKIE] ?? "", DASHBOARD_TOKEN)) return { ok: true };

  const payload = verifyPreviewToken(cookies[PREVIEW_COOKIE]);
  if (!payload) return { ok: false, status: 401, reason: "no-grant" };
  // Host-bound: a grant minted for one tunnel hostname is useless on another.
  if (payload.host !== host) return { ok: false, status: 403, reason: "wrong-host" };
  // Bound to THIS preview, so a grant is not portable across slots.
  if (payload.pv !== preview.previewId) return { ok: false, status: 403, reason: "wrong-preview" };
  // The host, arriving over the tunnel. Their install cookie is scoped to the
  // dashboard origin and never reaches *.trycloudflare.com, so the check above
  // cannot see them and this grant is the only evidence they are the operator.
  // Refusing it meant sharing a preview locked the HOST out of it — the tunnel
  // URL answered "Not available" to the very person who published it.
  //
  // Accepted on its own bindings rather than a share: the grant names this
  // preview (`pv`), this hostname (`host`), and an expiry. There is deliberately
  // no per-viewer revocation for it — nothing to re-derive, since the host has
  // no share — so the way to cut it is to unshare or stop the preview, which
  // tears down the tunnel for everyone at once. Must return BEFORE the
  // shareLiveCached call below, which would otherwise look up a share named
  // "host", find none, and read that as revoked.
  // `sid` is what the checks below re-derive access from, and verifyPreviewToken
  // never validated its type — it only insists on `pv` and `exp`. A grant without
  // one names no revocable thing, so it cannot be re-checked and must not be
  // guessed at. (It also used to fall through to a shareLive(undefined) that
  // resolved TRUE, quietly admitting it.)
  if (typeof payload.sid !== "string" || !payload.sid) {
    return { ok: false, status: 403, reason: "no-grant" };
  }
  if (payload.sid === "host") return { ok: true };
  // The host on one of their own ENROLLED DEVICES. Unlike the bare "host" above,
  // this one IS revocable, so it gets re-checked like a share does: revoking the
  // phone stops the preview on the phone within seconds, rather than leaving it
  // watching until the grant expires.
  if (payload.sid.startsWith("host:")) {
    const did = payload.sid.slice("host:".length);
    if (!(await deviceLiveCached(did))) return { ok: false, status: 403, reason: "revoked" };
    return { ok: true };
  }
  if (!(await shareLiveCached(payload.sid))) return { ok: false, status: 403, reason: "revoked" };
  return { ok: true };
}

function previewErrorPage(res, status, title, detail) {
  const body = `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
    `<style>body{font:15px/1.6 system-ui,sans-serif;margin:12vh auto;max-width:34rem;padding:0 1.5rem;color:#111}` +
    `h1{font-size:1.15rem;margin:0 0 .6rem}p{margin:0;color:#555}</style>` +
    `<h1>${title}</h1><p>${detail}</p>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

/**
 * The redemption shell. Reads the grant from the URL FRAGMENT — which browsers
 * never send to a server — and posts it back, so the token stays out of
 * Cloudflare's access logs, out of `Referer`, and out of anything that records
 * URLs. Mirrors how the peer /join flow redeems a share.
 */
function servePreviewAuthShell(res, slot) {
  // Land where the other viewers already are, not at the app's front door. A
  // panel that opens while the agent is working — which is now the common case,
  // since a drive opens it — would otherwise start out of step with everyone
  // else and miss whatever happens next on the page it is not on.
  const dest = drivers.followingPath(slot) ?? "/";
  const html = `<!doctype html><meta charset="utf-8"><title>Opening preview…</title>
<style>body{font:15px/1.6 system-ui,sans-serif;margin:12vh auto;max-width:30rem;padding:0 1.5rem;color:#111}</style>
<p id="s">Opening preview…</p>
<script>
(async function () {
  var t = location.hash.slice(1);
  if (!t) { document.getElementById("s").textContent = "This link is missing its access grant."; return; }
  try {
    var r = await fetch("${PREVIEW_AUTH_PREFIX}/preview-claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: t }),
    });
    if (r.ok) { location.replace(${JSON.stringify(dest)}); }
    else { document.getElementById("s").textContent = "This preview link is no longer valid."; }
  } catch (e) { document.getElementById("s").textContent = "Could not open the preview."; }
})();
</script>`;
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    // The shell holds a credential in its fragment; never let it be cached.
    "cache-control": "no-store",
  });
  res.end(html);
}

async function handlePreviewClaim(req, res, slot) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > 8192) { res.writeHead(413).end(); return; }
    chunks.push(c);
  }
  let token = "";
  try { token = JSON.parse(Buffer.concat(chunks).toString("utf-8")).token ?? ""; } catch { /* ignore */ }

  const payload = verifyPreviewToken(token);
  const host = normHost(req.headers.host);
  const preview = await previewOnSlot(slot);
  if (!payload || !preview || payload.pv !== preview.previewId || payload.host !== host) {
    return sendJson(res, 403, { error: "invalid grant" });
  }
  if (payload.sid !== "host" && !(await shareLiveCached(payload.sid))) {
    return sendJson(res, 403, { error: "grant revoked" });
  }

  const secure = req.headers["x-forwarded-proto"] === "https" || !host.startsWith("127.0.0.1");

  // A preview is meant to be WATCHED INSIDE the dashboard, and that makes the
  // cookie's SameSite value load-bearing rather than boilerplate.
  //
  // Lax is withheld from every request whose site differs from the TOP-LEVEL
  // site, so in an iframe hosted by a dashboard on another site the grant
  // redeemed (200) and was then ignored on the next request (401) — the "Not
  // available" page inside a panel whose URL worked perfectly in a new tab. A
  // peer can never avoid that: their dashboard and the preview sit on two
  // `*.trycloudflare.com` hostnames, and that domain is on the Public Suffix
  // List, so they are different sites no matter what. Peers had therefore never
  // been able to watch a preview in the panel at all.
  //
  // `None` is what a third-party context requires; `Partitioned` (CHIPS) keys
  // the cookie to the embedding site, so it also survives browsers that block
  // third-party cookies outright — and it happens to say exactly what we mean:
  // this grant is for viewing the preview through the dashboard that issued it.
  // Widening SameSite costs nothing here. The only state-changing endpoint on
  // this origin is the claim itself, which demands a signed grant; everything
  // else is the agent's own dev server, which being reachable IS the feature.
  // The hooop API is a different origin and refuses cross-origin callers.
  //
  // Insecure viewers keep Lax: `Secure` (and so `Partitioned`) is invalid over
  // plain HTTP, and that path is the host framing their own loopback slot port —
  // same-site already, so Lax is sent and nothing is gained by relaxing it.
  const sameSite = secure ? "SameSite=None; Secure; Partitioned" : "SameSite=Lax";
  res.writeHead(200, {
    "content-type": "application/json",
    "set-cookie": `${PREVIEW_COOKIE}=${token}; Path=/; HttpOnly; ${sameSite}; Max-Age=43200`,
  });
  res.end(JSON.stringify({ ok: true }));
}

/**
 * Pipe a preview request to its runner, byte for byte — except for the HTML
 * document itself, which gets the driver script spliced in (see
 * preview-driver.mjs for why that is the seam).
 *
 * "Byte for byte" still holds for everything else, and that matters: an app's
 * JSON, assets, streamed responses and websockets must arrive exactly as it sent
 * them. Only a self-described `text/html` response with a recognisable document
 * shell is ever rewritten.
 */
function proxyToRunner(slot, creq, cres) {
  // A compressed body cannot be string-spliced, so document requests ask the app
  // for identity. Scoped to navigations, so assets keep their compression.
  const wantsInjection = isDocumentRequest(creq.headers);
  const headers = { ...creq.headers };
  if (wantsInjection) headers["accept-encoding"] = "identity";

  const preq = httpRequest(
    {
      host: `preview-runner-${slot}`,
      port: PREVIEW_PORT_BASE + slot - 1,
      method: creq.method,
      path: creq.url,
      headers,
    },
    (pres) => {
      // Never let an HTML body sit in the browser cache — injected or not.
      //
      // Two failures, one cause. A static file server sends no cache-control, so
      // Chrome heuristically keeps the document and the operator goes on looking
      // at the app as it was BEFORE the agent's last edit. And because injection
      // is scoped to navigations, an ordinary fetch() of the same URL stores an
      // UNinjected copy under it — after which every navigation there loads an
      // app with no driver, no socket, and no explanation.
      const noStore = (h) => (isInjectableHtml(h) ? { ...h, "cache-control": "no-store" } : h);
      if (!wantsInjection || !isInjectableHtml(pres.headers)) {
        cres.writeHead(pres.statusCode ?? 502, noStore(pres.headers));
        pres.pipe(cres);
        return;
      }
      // Buffer only the document. Capped: an app that streams a huge HTML body
      // should be passed through rather than held in memory here.
      const chunks = [];
      let total = 0;
      let bailed = false;
      pres.on("data", (c) => {
        if (bailed) return;
        total += c.length;
        if (total > 4 * 1024 * 1024) {
          bailed = true;
          cres.writeHead(pres.statusCode ?? 200, noStore(pres.headers));
          for (const b of chunks) cres.write(b);
          cres.write(c);
          pres.pipe(cres);
          return;
        }
        chunks.push(c);
      });
      pres.on("end", () => {
        if (bailed) return;
        const body = injectScript(Buffer.concat(chunks).toString("utf-8"), SCRIPT_TAG);
        const out = Buffer.from(body, "utf-8");
        const h = { ...noStore(pres.headers), "content-length": String(out.length) };
        // The length changed, so a chunked framing from upstream no longer
        // describes this response.
        delete h["transfer-encoding"];
        cres.writeHead(pres.statusCode ?? 200, h);
        cres.end(out);
      });
    },
  );
  preq.on("error", () => {
    try {
      previewErrorPage(cres, 502, "Preview is not responding",
        "The app stopped or is still starting. Check the preview panel in the dashboard.");
    } catch { /* headers already sent */ }
  });
  creq.pipe(preq);
}

/**
 * Strip credentials that belong to the DASHBOARD before anything reaches the
 * runner. The runner is the least trusted container in the stack; handing it
 * the sandbox token or the install cookie would undo that in one header.
 */
function sanitizePreviewHeaders(headers) {
  const out = { ...headers };
  delete out[SANDBOX_TOKEN_HEADER];
  delete out["x-hooop-participant"];
  delete out["x-hooop-peer-session"];
  delete out["x-hooop-peer-capability"];
  delete out.cookie;
  return out;
}

// ── preview drivers (one per watching page) ─────────────────────────────────
//
// STAGE 1 / PoC. What is here proves the claim the whole design rests on: hooop
// can inject a driver into the agent's own app, and driving it shows up in the
// iframe the operator is watching. The model is NOT wired in yet — actions come
// from the host-only endpoint below, so this can be exercised with curl before
// any of the sandbox relay exists.
const driverWss = new WebSocketServer({ noServer: true });
/** Which pages are watching which slot, and which of them still follow. */
const drivers = createDriverRegistry({
  log,
  // The last viewer took control, so there is nobody left for the agent to work
  // in front of. Stopping the turn here rather than in the panel covers BOTH
  // ways of taking over — clicking the overlay and clicking inside the frame —
  // and it is the only place that knows how many followers remain.
  onIdle: (slot) => void (async () => {
    const preview = await previewOnSlot(slot);
    if (!preview?.sessionId) return;
    log(`preview slot ${slot}: last follower took control, interrupting the turn`);
    await sandboxJson("POST", `/sessions/${encodeURIComponent(preview.sessionId)}/interrupt`, {
      reason: "a viewer took control of the preview",
    });
  })().catch((e) => log(`interrupt after take-control failed: ${e?.message ?? e}`)),
});

function attachDriver(slot, previewId, ws) {
  drivers.attach(slot, previewId, ws);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    drivers.receive(ws, msg);
  });
  const drop = () => drivers.drop(ws);
  ws.on("close", drop);
  ws.on("error", drop);
}

// ── relaying the model's actions ────────────────────────────────────────────
//
// The sandbox cannot call this process — that arrow does not exist and adding it
// would give agent-authored code a route into the operator's session. But the
// pages the model wants to drive are reachable ONLY from here, because their
// sockets terminate in this process.
//
// So we pull, exactly as auto-share does: long-poll the sandbox for the next
// action the model parked, run it in the watching pages, post the result back.
// Latency is a click's worth, and an idle session costs one parked request.
let driveRelayStopped = false;

async function sandboxJson(method, path, body) {
  const token = readSandboxToken();
  if (!token) return null;
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve) => {
    const r = udsRequest({
      socketPath: SANDBOX_SOCKET, method, path,
      // Longer than the sandbox's own 30s ceiling on a poll, so the socket
      // timeout never fires before the honest empty answer arrives.
      timeout: 40_000,
      headers: {
        [SANDBOX_TOKEN_HEADER]: token, "x-hooop-participant": "host",
        ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let buf = "";
      res.setEncoding("utf-8");
      res.on("data", (c) => { buf += c; });
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    r.on("error", () => resolve(null));
    r.on("timeout", () => { r.destroy(); resolve(null); });
    r.end(payload ?? undefined);
  });
}

async function driveRelayLoop() {
  let backoff = 1000;
  while (!driveRelayStopped) {
    const answer = await sandboxJson("GET", "/previews/drive-next?waitMs=25000");
    if (!answer) {
      // The sandbox is restarting, or not up yet. Back off rather than spin —
      // this loop runs for the life of the process.
      await new Promise((r) => setTimeout(r, backoff).unref?.());
      backoff = Math.min(backoff * 2, 15_000);
      continue;
    }
    backoff = 1000;
    const action = answer.action;
    if (!action) continue;              // the poll simply expired; ask again
    // Deliberately NOT awaited: an action can sit for the better part of a
    // minute waiting for somebody to open the preview, and blocking the loop on
    // it would stall every other session's drive behind that one person.
    void runDriveAction(action);
  }
}

async function runDriveAction(action) {
  // Tell every participant's UI the agent has the wheel, BEFORE the action runs
  // — the overlay exists so nobody is surprised mid-click, which means it has to
  // be up first. The browser decays it after a quiet interval, so a sequence of
  // actions keeps it steady instead of flickering once per click.
  const preview = await previewOnSlot(action.slot);
  if (preview?.sessionId) {
    broadcast("preview-drive", {
      sessionId: preview.sessionId,
      previewId: action.previewId,
      action: action.action,
    });
  }
  let result;
  try {
    result = await drivers.drive(action.slot, action.action, action.params ?? {}, {
      // The slot alone is not identity: a stopped preview leaves its viewers'
      // sockets attached, and the next preview to take the slot can belong to
      // another session entirely.
      previewId: action.previewId,
      // Only ever set on a retry the sandbox sent after nudging everyone to open
      // the preview; a first attempt must answer immediately, so it is the nudge
      // that waits rather than the model.
      waitForViewerMs: action.waitForViewerMs ?? 0,
    });
  } catch (e) {
    result = { ok: false, error: `could not drive the page: ${String(e?.message ?? e)}` };
  }
  // Reported even when it failed: the model is parked on this, and a silence
  // would surface to it as the operator refusing the call.
  await sandboxJson("POST", "/previews/drive-result", { id: action.id, result });
}

/**
 * Host-only manual driver, kept from the Stage 1 PoC.
 *
 * The model now reaches the same code through the permission gate and the relay
 * above; this stays because it is how the loop is exercised from a terminal
 * while watching the panel, which is worth more than the twenty lines it costs.
 */
async function handlePreviewDrive(req, res) {
  if ((req.url || "").split("?")[0] !== "/api/preview-drive") return false;
  if (!(await isHostRequest(req))) { sendJson(res, 403, { error: "host only" }); return true; }
  // GET reports the census, so "who is following?" is answerable from a terminal
  // instead of by opening every peer's console.
  if (req.method === "GET") {
    const out = {};
    for (let s = 1; s <= PREVIEW_SLOTS; s += 1) {
      out[s] = { ...drivers.census(s), recent: drivers.recent(s) };
    }
    sendJson(res, 200, { slots: out });
    return true;
  }
  if (req.method !== "POST") { sendJson(res, 405, { error: "method not allowed" }); return true; }

  const chunks = [];
  for await (const c of req) chunks.push(c);
  let body = {};
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}"); } catch { /* below */ }
  const slot = parseInt(body.slot ?? "", 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > PREVIEW_SLOTS) {
    sendJson(res, 400, { error: "invalid slot" }); return true;
  }
  if (!body.action) { sendJson(res, 400, { error: "missing action" }); return true; }

  // A manual drive waits a moment for a viewer, so "open the panel, then run
  // this" works without racing.
  const r = await drivers.drive(slot, body.action, body.params ?? {}, {
    timeoutMs: 10_000,
    waitForViewerMs: body.waitForViewerMs ?? 0,
    // Same isolation as the model's path, resolved here rather than trusted from
    // the body: a manual drive should not be able to reach a previous occupant's
    // viewers by naming the wrong preview.
    previewId: (await previewOnSlot(slot))?.previewId,
  });
  sendJson(res, r.ok ? 200 : 409, r);
  return true;
}

function startPreviewListeners() {
  for (let slot = 1; slot <= PREVIEW_SLOTS; slot += 1) {
    const port = PREVIEW_PORT_BASE + slot - 1;
    const server = createServer((creq, cres) => {
      void (async () => {
        const path = (creq.url || "/").split("?")[0];

        // Reserved prefix, served by us and never forwarded. It shadows this
        // path in the previewed app, which is the one URL hooop takes away.
        if (path === `${PREVIEW_AUTH_PREFIX}/preview-auth`) return servePreviewAuthShell(cres, slot);
        if (path === DRIVER_SCRIPT_PATH) {
          // Served from the preview origin so it is same-origin with the page it
          // drives. Behind the same grant check as everything else below? No —
          // it is inert on its own (it can only talk to a socket that IS grant
          // checked), and gating it would make an unauthorized page fail with a
          // console error instead of hooop's own "Not available".
          // Carries the preview's id, so the page can keep its progress under a
          // key that does not survive the slot changing hands.
          const here = await previewOnSlot(slot);
          const buf = Buffer.from(driverScriptFor(here?.previewId), "utf-8");
          cres.writeHead(200, {
            "content-type": "application/javascript; charset=utf-8",
            "content-length": buf.length,
            "cache-control": "no-store",
          });
          return cres.end(buf);
        }
        if (path === `${PREVIEW_AUTH_PREFIX}/preview-claim` && creq.method === "POST") {
          return handlePreviewClaim(creq, cres, slot);
        }

        const preview = await previewOnSlot(slot);
        if (!preview) {
          return previewErrorPage(cres, 404, "No preview here",
            "Nothing is running on this preview slot. It may have been stopped, or the session that owned it may have ended.");
        }
        const auth = await authorizePreview(creq, preview);
        if (!auth.ok) {
          const detail = auth.reason === "revoked"
            ? "Your access to this session was revoked."
            : auth.reason === "wrong-preview"
              ? "This link was for a different preview. Open the current one from the dashboard."
              : "Open this preview from the hooop dashboard to get access.";
          return previewErrorPage(cres, auth.status, "Not available", detail);
        }
        creq.headers = sanitizePreviewHeaders(creq.headers);
        proxyToRunner(slot, creq, cres);
      })().catch(() => {
        try { previewErrorPage(cres, 500, "Preview error", "Something went wrong serving this preview."); }
        catch { /* headers already sent */ }
      });
    });

    // WebSocket upgrades (HMR, socket.io) go through the same auth then become
    // a raw socket pipe — which is why an app that ships a working live-reload
    // socket keeps it.
    server.on("upgrade", (req, socket, head) => {
      void (async () => {
        const preview = await previewOnSlot(slot);
        if (!preview) { socket.destroy(); return; }
        const auth = await authorizePreview(req, preview);
        if (!auth.ok) {
          socket.write(`HTTP/1.1 ${auth.status} Forbidden\r\n\r\n`);
          socket.destroy();
          return;
        }
        // The driver's own socket terminates HERE rather than being piped to the
        // app. It is grant-checked by the same authorizePreview above, so it can
        // only ever be opened by a page that was already allowed to load.
        if ((req.url || "").split("?")[0] === DRIVER_SOCKET_PATH) {
          return driverWss.handleUpgrade(req, socket, head, (ws) => {
            attachDriver(slot, preview.previewId, ws);
          });
        }
        const clean = sanitizePreviewHeaders(req.headers);
        const up = netConnect(PREVIEW_PORT_BASE + slot - 1, `preview-runner-${slot}`, () => {
          const lines = [`${req.method} ${req.url} HTTP/1.1`];
          for (const [k, v] of Object.entries(clean)) {
            for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
          }
          lines.push("", "");
          up.write(lines.join("\r\n"));
          if (head && head.length) up.write(head);
          socket.pipe(up);
          up.pipe(socket);
        });
        up.on("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
        socket.on("error", () => { try { up.destroy(); } catch { /* ignore */ } });
      })().catch(() => { try { socket.destroy(); } catch { /* ignore */ } });
    });

    server.on("error", (e) => log(`preview listener ${port} error`, e.message));
    server.listen(port, PUBLIC_HOST, () => log(`preview slot ${slot} on ${PUBLIC_HOST}:${port}`));
  }
}

// ── preview tunnels (one per SHARED preview) ────────────────────────────────
const previewTunnels = new Map(); // slot -> { proc, url, reachable }

/** How long a probe waits before calling one attempt a miss. */
const PROBE_TIMEOUT_MS = 5000;

/**
 * Did the tunnel hostname answer? ANY status counts — the origin is hooop's own
 * listener, which refuses ungranted requests, so a 401 proves the edge is
 * routing to us just as well as a 200 would.
 */
async function probeTunnelOnce(url) {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // Nothing here reads the body; leaving it unread would hold the socket.
    try { await res.body?.cancel(); } catch { /* already closed */ }
    return true;
  } catch {
    // DNS not resolving yet lands here, and that is the normal early state.
    return false;
  }
}

/**
 * Watch a freshly minted hostname until it actually serves, in the background.
 *
 * Not awaited by the share: propagation takes tens of seconds and blocking that
 * long would look like a hang. The share still returns immediately — it just
 * reports `reachable: false` honestly instead of implying the link is ready, and
 * the UI polls this state so it can say so.
 */
function trackPreviewReachability(slot, url) {
  void waitForTunnelReachable({
    url,
    probe: probeTunnelOnce,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  }).then(({ reachable, attempts }) => {
    const cur = previewTunnels.get(slot);
    // The slot may have changed hands (or been stopped) while we probed; that
    // tunnel's reachability is no longer anybody's business.
    if (!cur || cur.url !== url) return;
    cur.reachable = reachable;
    // We have stopped asking. Without this the answer is identical to "still
    // propagating" forever, so the panel kept promising a link that was never
    // coming — for hours — and the only honest thing it could have said was
    // that the tunnel never registered.
    cur.probing = false;
    log(
      `preview tunnel slot ${slot}`,
      reachable ? `reachable after ${attempts} probe(s):` : "never became reachable:",
      url,
    );
  });
}

async function startPreviewTunnel(slot) {
  const existing = previewTunnels.get(slot);
  if (existing) return { url: existing.url, reachable: !!existing.reachable };

  const result = await spawnQuickTunnelWithRetry(
    `http://127.0.0.1:${PREVIEW_PORT_BASE + slot - 1}`,
    () => {
      // The tunnel died on its own. Drop the record so the next share re-creates
      // it rather than handing out a hostname that no longer resolves.
      previewTunnels.delete(slot);
      log(`preview tunnel for slot ${slot} exited`);
    },
    `preview ${slot}`,
  );
  if (result.error) return { error: result.error };
  previewTunnels.set(slot, { proc: result.proc, url: result.url, reachable: false, probing: true });
  // cloudflared's own banner warns the hostname "may take some time to be
  // reachable", so the URL existing is not the same as the URL working.
  log(`preview tunnel up for slot ${slot} (propagating):`, result.url);
  trackPreviewReachability(slot, result.url);
  return { url: result.url, reachable: false };
}

function stopPreviewTunnel(slot) {
  const t = previewTunnels.get(slot);
  previewTunnels.delete(slot);
  if (t?.proc) { try { t.proc.kill("SIGTERM"); } catch { /* already gone */ } }
}

function stopAllPreviewTunnels() {
  for (const slot of [...previewTunnels.keys()]) stopPreviewTunnel(slot);
}

/**
 * Host-only control for preview tunnels, handled here because cloudflared lives
 * in this process. The Next route calls it, then records the URL with the
 * sandbox — keeping the sandbox→dashboard arrow from ever needing to exist.
 */
async function handlePreviewTunnel(req, res) {
  if ((req.url || "").split("?")[0] !== "/api/preview-tunnel") return false;
  if (!(await isHostRequest(req))) { sendJson(res, 403, { error: "host only" }); return true; }

  const slot = parseInt(new URL(req.url, "http://x").searchParams.get("slot") ?? "", 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > PREVIEW_SLOTS) {
    sendJson(res, 400, { error: "invalid slot" });
    return true;
  }
  if (req.method === "POST") {
    const r = await startPreviewTunnel(slot);
    sendJson(res, r.url ? 200 : 502, r);
    return true;
  }
  // Reachability is polled rather than pushed: a hostname becomes reachable
  // without any event to hang off, and the UI already polls preview state.
  if (req.method === "GET") {
    const t = previewTunnels.get(slot);
    sendJson(res, 200, t
      ? { url: t.url, reachable: !!t.reachable, probing: !!t.probing }
      : { url: null, reachable: false, probing: false });
    return true;
  }
  if (req.method === "DELETE") { stopPreviewTunnel(slot); sendJson(res, 200, { ok: true }); return true; }
  sendJson(res, 405, { error: "method not allowed" });
  return true;
}

// ── 3. WebSocket bridge ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const clients = new Set(); // { ws, scope }

function shouldForward(scope, type, data) {
  if (scope.kind === "host") return true;
  // Peer: only their session's live data.
  switch (type) {
    case "event":
      return !!data && typeof data.session_id === "string" && scope.allowed.has(data.session_id);
    case "presence":
      return !!data && data.sessionId === scope.ses;
    case "session-status": {
      // Track alias swaps for the peer's session so later events under the new
      // id still reach them (mirrors the browser's alias widening).
      if (data && (scope.allowed.has(data.aliasFrom) || scope.allowed.has(data.sessionId))) {
        if (data.sessionId) scope.allowed.add(data.sessionId);
        return true;
      }
      return false;
    }
    case "session-error":
      return !!data && (data.sessionId == null || scope.allowed.has(data.sessionId));
    case "files":      // carries {sessionId, cwd} — only the owning peer should see it
      return !!data && typeof data.sessionId === "string" && scope.allowed.has(data.sessionId);
    // The model started or stopped driving a preview. Every peer watching that
    // session needs it: the point of the overlay is that whoever is looking at
    // the page knows the agent has the wheel, and a peer looking at a page they
    // cannot see marked as driven is the exact confusion this prevents.
    case "preview-drive":
      return !!data && typeof data.sessionId === "string" && scope.allowed.has(data.sessionId);
    case "sessions":   // content-free "refetch" ping
    case "skills":     // skills are shared
      return true;
    default:
      return false;    // anything unrecognized → host only
  }
}

function broadcast(type, data) {
  const frame = JSON.stringify({ type, data });
  for (const c of clients) {
    if (c.ws.readyState !== c.ws.OPEN) continue;
    if (shouldForward(c.scope, type, data)) {
      try { c.ws.send(frame); } catch { /* ignore */ }
    }
  }
}

// ── upstream: one SSE connection to Next's /api/stream (as host, localhost) ──
let upstreamReq = null;
function startUpstream() {
  const req = httpRequest({
    host: INTERNAL_HOST,
    port: INTERNAL_PORT,
    path: "/api/stream",
    method: "GET",
    headers: {
      host: `${INTERNAL_HOST}:${INTERNAL_PORT}`,
      origin: `http://${INTERNAL_HOST}:${INTERNAL_PORT}`,
      accept: "text/event-stream",
      cookie: `${INSTALL_COOKIE}=${DASHBOARD_TOKEN}`,
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      log("upstream /api/stream status", res.statusCode, "- retrying");
      res.resume();
      return scheduleUpstreamRetry();
    }
    res.setEncoding("utf-8");
    let buf = "", evType = null, dataLines = [];
    const flush = () => {
      if (dataLines.length) {
        const raw = dataLines.join("\n");
        let data; try { data = JSON.parse(raw); } catch { data = null; }
        if (data !== null) {
          broadcast(evType ?? "message", data);
          // Anything that could have created a share or brought a preview up
          // lands on this stream. Rather than match event shapes, let the
          // reconciler decide — it is debounced and no-ops when there is
          // nothing to do, so a false trigger costs one cached read.
          scheduleAutoShareSweep();
        }
      }
      evType = null; dataLines = [];
    };
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line === "") { flush(); continue; }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) evType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    });
    res.on("end", scheduleUpstreamRetry);
    res.on("close", scheduleUpstreamRetry);
    res.on("error", scheduleUpstreamRetry);
  });
  req.on("error", () => scheduleUpstreamRetry());
  req.end();
  upstreamReq = req;
}
let retryTimer = null;
function scheduleUpstreamRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; startUpstream(); }, 1000);
}

// ── 2. Reverse-proxy all HTTP to Next (transparent; Next does all auth) ──────
const server = createServer((creq, cres) => {
  // Tunnel control lives in this process (it owns the cloudflared child), so
  // intercept before the transparent proxy hands off to Next.
  if ((creq.url || "").split("?")[0] === "/api/tunnel") {
    void handleTunnel(creq, cres).catch(() => { try { sendJson(cres, 500, { error: "tunnel error" }); } catch {} });
    return;
  }
  // Preview tunnels live here for the same reason session tunnels do: this
  // process owns the cloudflared children.
  if ((creq.url || "").split("?")[0] === "/api/preview-tunnel") {
    void handlePreviewTunnel(creq, cres).catch(() => { try { sendJson(cres, 500, { error: "preview tunnel error" }); } catch {} });
    return;
  }
  // Same reason again: the driver sockets terminate in THIS process, so only it
  // can reach a watching page.
  if ((creq.url || "").split("?")[0] === "/api/preview-drive") {
    void handlePreviewDrive(creq, cres).catch(() => { try { sendJson(cres, 500, { error: "drive error" }); } catch {} });
    return;
  }
  const preq = httpRequest({
    host: INTERNAL_HOST,
    port: INTERNAL_PORT,
    method: creq.method,
    path: creq.url,
    headers: creq.headers, // preserves Host/Cookie/Origin → Next middleware sees the real request
  }, (pres) => {
    cres.writeHead(pres.statusCode ?? 502, pres.headers);
    pres.pipe(cres);
  });
  preq.on("error", () => { try { cres.writeHead(502); cres.end("bad gateway"); } catch {} });
  creq.pipe(preq);
});

// Raw upgrade proxy → internal Next server. Only used in dev, to carry Next's
// HMR websocket (/_next/webpack-hmr) through this front process. Reconstructs
// the upgrade request line + headers, replays any buffered `head`, then pipes
// bidirectionally.
function proxyUpgrade(req, socket, head) {
  const up = netConnect(INTERNAL_PORT, INTERNAL_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push("", "");
    up.write(lines.join("\r\n"));
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
  socket.on("error", () => { try { up.destroy(); } catch { /* ignore */ } });
}

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (!url.startsWith("/api/ws")) {
    // Dev: forward Next's HMR (and any other) upgrade to the internal server.
    // Prod: no such upgrades exist, so reject exactly as before.
    if (DEV) return proxyUpgrade(req, socket, head);
    socket.destroy();
    return;
  }
  const scope = authUpgrade(req);
  if (!scope) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  // A peer's share — or an enrolled device's grant — must still be live to open
  // the feed. A revoked credential can't reconnect to keep watching, whichever
  // kind it is. The host at the machine has nothing to re-check: their authority
  // is the install cookie, not a revocable grant.
  const gate = scope.kind === "peer"
    ? shareLive(scope.sid)
    : scope.did
      ? deviceLive(scope.did)
      : Promise.resolve(true);
  gate.then((live) => {
    if (!live) {
      try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); } catch {}
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, scope };
      clients.add(client);
      ws.send(JSON.stringify({ type: "ready", data: { kind: scope.kind } }));
      const ping = setInterval(() => { try { ws.ping(); } catch {} }, 20_000);
      ws.on("close", () => { clearInterval(ping); clients.delete(client); });
      ws.on("error", () => { clearInterval(ping); clients.delete(client); });
    });
  });
});

// Drop live feeds whose grant got revoked mid-session. Poll every 5s and close
// any socket whose share — or enrolled device — the sandbox no longer holds
// (deduped by id, so N viewers on one grant cost one check).
//
// Devices are swept alongside shares rather than in a second timer because they
// need it MORE, not less: revoking a phone that is still streaming the transcript
// has to actually stop the transcript, and a signed token stays valid until it
// expires, so the sandbox's registry is the only thing that can say "no".
setInterval(async () => {
  const sids = new Set();
  const dids = new Set();
  for (const c of clients) {
    if (c.scope.kind === "peer" && c.scope.sid) sids.add(c.scope.sid);
    else if (c.scope.kind === "host" && c.scope.did) dids.add(c.scope.did);
  }
  if (sids.size === 0 && dids.size === 0) return;
  const deadShares = new Set();
  const deadDevices = new Set();
  await Promise.all([
    ...[...sids].map(async (sid) => { if (!(await shareLive(sid))) deadShares.add(sid); }),
    ...[...dids].map(async (did) => { if (!(await deviceLive(did))) deadDevices.add(did); }),
  ]);
  if (deadShares.size === 0 && deadDevices.size === 0) return;
  for (const c of clients) {
    const dead =
      (c.scope.kind === "peer" && deadShares.has(c.scope.sid)) ||
      (c.scope.kind === "host" && c.scope.did && deadDevices.has(c.scope.did));
    if (dead) {
      try { c.ws.close(4403, c.scope.kind === "peer" ? "share revoked" : "device revoked"); } catch {}
      clients.delete(c);
    }
  }
}, 5000);

// ── boot: wait for Next, then listen + start the upstream relay ──────────────
// `ready` makes this a one-shot: once Next answers 200 we listen exactly once
// and stop polling. Without it, a keep-alive health socket (next dev keeps the
// connection open) fires a late `timeout` after success → a stray retry →
// onNextReady twice → ERR_SERVER_ALREADY_LISTEN. `Connection: close` also keeps
// each probe from lingering.
let ready = false;
function waitForNext(attempt = 0) {
  if (ready) return;
  const r = httpRequest(
    { host: INTERNAL_HOST, port: INTERNAL_PORT, path: "/api/health", method: "GET",
      headers: { connection: "close" }, timeout: 1000 },
    (res) => { res.resume(); res.statusCode === 200 ? onNextReady() : retry(); },
  );
  r.on("error", retry);
  r.on("timeout", () => { r.destroy(); retry(); });
  r.end();
  function retry() {
    if (ready) return;
    if (attempt > 600) { log("next never became ready"); process.exit(1); }
    setTimeout(() => waitForNext(attempt + 1), 250);
  }
}
function onNextReady() {
  if (ready) return;
  ready = true;
  server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    log(`listening on ${PUBLIC_HOST}:${PUBLIC_PORT} → next on ${INTERNAL_HOST}:${INTERNAL_PORT}; ws at /api/ws`);
    startUpstream();
    // Bound for the life of the process, not per-preview: a slot's port must
    // answer even when nothing is running on it, so a stale bookmark gets a
    // clear "no preview here" page instead of a connection refused.
    startPreviewListeners();
    // Long-polls the sandbox for actions the model wants run in a watching page.
    // Started unconditionally: it costs one parked request while idle, and
    // starting it lazily would mean the first drive of a session is the one that
    // waits.
    void driveRelayLoop();
  });
}
waitForNext();
