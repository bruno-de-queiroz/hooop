/**
 * Boundary tests for the runtime resource caps: MAX_SSE_CLIENTS and the
 * socket-conflict probe in listenOnSocket. This file focuses on the
 * server-side gates.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingMessage } from "node:http";

vi.mock("./lib/ingestor", () => ({
  ingestEventLine: vi.fn(),
  startIngestor: vi.fn(),
  eventBus: new EventEmitter(),
}));
vi.mock("./lib/sessions", () => ({
  listSessions: () => [],
  startSessionsWatcher: vi.fn(),
  stopSessionsWatcher: vi.fn(),
  sessionsBus: new EventEmitter(),
}));
vi.mock("./lib/active-sessions", () => ({
  startNewConversation: vi.fn(),
  startSkillSession: vi.fn(async () => ({ sessionId: "s1" })),
  isValidSkillName: () => true,
  writeUserTurn: vi.fn(),
  isControllable: vi.fn(() => false),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  activeSessionsBus: new EventEmitter(),
  bootActiveSessions: vi.fn(),
  shutdownActiveSessions: vi.fn(),
  // No canonicalization in tests → checkParticipant falls back to raw session
  // ids (share.sessionId compared verbatim), which is what these authz tests want.
  getActiveSession: vi.fn(() => undefined),
}));
vi.mock("./lib/skills", () => ({ listSkills: () => [], startSkillsWatcher: vi.fn(), stopSkillsWatcher: vi.fn(), skillsBus: new EventEmitter() }));
vi.mock("./lib/commands", () => ({ listSlashCommands: () => [] }));
vi.mock("./lib/agents", () => ({ listAgentRuns: () => [], getAgentDetail: () => undefined }));
vi.mock("./lib/search", () => ({ search: vi.fn(async () => ({ results: [], total: 0 })) }));
vi.mock("./lib/mcps", () => ({ listMcps: () => ({ servers: [] }) }));
vi.mock("./lib/stack", () => ({ getStack: () => ({ plugins: [] }) }));
vi.mock("./lib/identity", () => ({ getIdentity: () => ({ authenticated: false }) }));
vi.mock("./lib/session-model", () => ({ getSessionModel: () => ({ model: null }) }));
vi.mock("./lib/events-query", () => ({ listEvents: () => [], getEvent: () => undefined }));
vi.mock("./lib/cwd-policy", () => ({ isAllowedCwd: () => ({ ok: true }) }));
vi.mock("./lib/db", () => ({ backupEventsDb: vi.fn(), checkpointDb: vi.fn() }));
vi.mock("./rate-limit", () => ({
  mutatingLimiter: { check: vi.fn(() => ({ ok: true })) },
}));
vi.mock("./logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("./shutdown", () => ({ registerShutdown: vi.fn() }));

interface CapsServer {
  socketPath: string;
  token: string;
  server: import("node:http").Server;
  close(): Promise<void>;
}

async function startServerWith(envOverrides: Record<string, string>): Promise<CapsServer> {
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
  vi.resetModules();
  const dir = mkdtempSync(join(tmpdir(), "sandbox-caps-test-"));
  const socketPath = join(dir, "sandbox.sock");
  const tokenFile = join(dir, "sandbox.token");
  const token = "test-token-".padEnd(64, "x");
  writeFileSync(tokenFile, token);
  process.env.HOOOP_SANDBOX_TOKEN_FILE = tokenFile;

  const { createSandboxServer } = await import("./server");
  const server = createSandboxServer();
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  return {
    socketPath,
    token,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => {
          if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
          resolve();
        });
      }),
  };
}

// NOTE: `participant` defaults to "host" because an ABSENT header is now 403
// rather than "host" (see checkParticipant). Pass null to exercise that.
function postJson(socketPath: string, token: string, path: string, participant: string | null = "host"): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "x-sandbox-token": token,
      "content-type": "application/json",
    };
    if (participant) headers["x-hooop-participant"] = participant;
    const body = "{}";
    headers["content-length"] = String(Buffer.byteLength(body));
    const req = httpRequest({ socketPath, method: "POST", path, headers }, (res) => {
      res.resume(); // drain so the socket closes
      resolve({ status: res.statusCode ?? 0 });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/** General request helper (any method + optional JSON body + participant). */
function reqJson(
  socketPath: string,
  token: string,
  method: string,
  path: string,
  participant: string | null = "host",
  bodyObj?: unknown,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "x-sandbox-token": token };
    if (participant) headers["x-hooop-participant"] = participant;
    let body: string | undefined;
    if (method !== "GET") {
      body = JSON.stringify(bodyObj ?? {});
      headers["content-type"] = "application/json";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const r = httpRequest({ socketPath, method, path, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

function openSseConnection(socketPath: string, token: string): Promise<{
  status: number;
  headers: IncomingMessage["headers"];
  destroy: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      socketPath,
      method: "GET",
      path: "/events/stream",
      headers: { "x-sandbox-token": token },
    }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        destroy: () => { req.destroy(); res.destroy(); },
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("probeSocketAlive — socket-conflict detection for listenOnSocket", () => {
  it("returns true when another listener is alive on the socket path", async () => {
    const net = await import("node:net");
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-test-"));
    const socketPath = join(dir, "live.sock");
    const dummy = net.createServer();
    await new Promise<void>((resolve) => dummy.listen(socketPath, () => resolve()));

    const { probeSocketAlive } = await import("./server");
    const alive = await probeSocketAlive(socketPath, 500);
    expect(alive).toBe(true);

    await new Promise<void>((resolve) => dummy.close(() => resolve()));
    if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it("returns false for a stale socket file with no listener", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sandbox-probe-test-"));
    const socketPath = join(dir, "stale.sock");
    // Create the file but don't bind a server — simulates a crash-leftover.
    writeFileSync(socketPath, "");

    const { probeSocketAlive } = await import("./server");
    const alive = await probeSocketAlive(socketPath, 200);
    expect(alive).toBe(false);

    if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it("returns false for a non-existent path", async () => {
    const { probeSocketAlive } = await import("./server");
    const alive = await probeSocketAlive("/tmp/does-not-exist-" + Date.now() + ".sock", 200);
    expect(alive).toBe(false);
  });
});

describe("host-only spawn guards (requireHost) — defence-in-depth", () => {
  let srv: CapsServer;

  afterEach(async () => {
    if (srv) await srv.close();
  });

  it("POST /sessions allows an explicit host, and rejects a peer OR a header-less caller", async () => {
    srv = await startServerWith({});
    // A peer participant the dashboard should have blocked — sandbox rejects it too.
    expect((await postJson(srv.socketPath, srv.token, "/sessions", "peer:share-x")).status).toBe(403);
    // Host gets past the guard. The mocked startNewConversation returns
    // undefined → the handler 500s downstream; the point is only that
    // requireHost did NOT short-circuit with a 403.
    expect((await postJson(srv.socketPath, srv.token, "/sessions", "host")).status).not.toBe(403);
    // REGRESSION GUARD: an absent participant header used to be treated as
    // "host", so anything that could reach the socket and say nothing got full
    // host authority — which is exactly what a raw curl from inside the
    // container does. It must fail closed now.
    expect((await postJson(srv.socketPath, srv.token, "/sessions", null)).status).toBe(403);
    expect((await postJson(srv.socketPath, srv.token, "/sessions", "none")).status).toBe(403);
  });

  it("header-less callers are rejected across every guarded route family", async () => {
    srv = await startServerWith({});
    // Routes whose FIRST act is the identity check. `/sessions/:id/message`
    // and `/sessions/:id/bash` are deliberately absent: they run an
    // isControllable/session pre-check first and answer 409 before ever
    // looking at the participant, so they can't assert 403 here. They're still
    // gated (see the peer-scope tests below) — the pre-check just means an
    // anonymous caller learns "not controllable" before being turned away.
    for (const [method, path] of [
      ["POST", "/sessions"],
      ["POST", "/skill/foo/run"],
      ["POST", "/sessions/s1/permission"],
      ["POST", "/sessions/s1/auto-mode"],
      ["GET", "/shares"],
      ["GET", "/pending-joins"],
    ] as const) {
      const { status } = await reqJson(srv.socketPath, srv.token, method, path, null);
      expect({ path, status }).toEqual({ path, status: 403 });
    }
  });

  it("POST /skill/:name/run rejects a forwarded peer with 403, allows host", async () => {
    srv = await startServerWith({});
    expect((await postJson(srv.socketPath, srv.token, "/skill/foo/run", "peer:share-x")).status).toBe(403);
    expect((await postJson(srv.socketPath, srv.token, "/skill/foo/run", "host")).status).not.toBe(403);
  });
});

describe("peer admit/deny/revoke/list authorization — capability + session scope", () => {
  let srv: CapsServer;

  afterEach(async () => {
    if (srv) await srv.close();
  });

  // Fresh shares/joins created directly against the (real, non-mocked) modules
  // the running server captured after startServerWith's resetModules — so the
  // state we set up is exactly what the route handlers see.
  async function setup() {
    srv = await startServerWith({});
    const shares = await import("./lib/shares");
    const joins = await import("./lib/peer-joins");
    const full = shares.createShare({ sessionId: "S1", publicHost: "h.example", capability: "full" });
    const drive = shares.createShare({ sessionId: "S1", publicHost: "h.example", capability: "drive" });
    const spectate = shares.createShare({ sessionId: "S1", publicHost: "h.example", capability: "spectate" });
    const otherSession = shares.createShare({ sessionId: "S2", publicHost: "h.example", capability: "full" });
    return { shares, joins, full, drive, spectate, otherSession };
  }

  it("/join-admit: drive/spectate peers are rejected; host + full peer (same session) pass; full peer is denied cross-session", async () => {
    const { joins, full, drive, spectate, otherSession } = await setup();
    // One pending ticket in S1; rejections don't consume it, so reuse it.
    const t1 = joins.createJoinTicket({ shareId: full.shareId, sessionId: "S1", peerName: "guest" });
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/join-admit", `peer:${drive.shareId}`, { ticketId: t1.ticketId })).status).toBe(403);
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/join-admit", `peer:${spectate.shareId}`, { ticketId: t1.ticketId })).status).toBe(403);
    // A full peer whose share is in a DIFFERENT session cannot admit into S1.
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/join-admit", `peer:${otherSession.shareId}`, { ticketId: t1.ticketId })).status).toBe(403);
    // Full peer in the SAME session succeeds (consumes t1).
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/join-admit", `peer:${full.shareId}`, { ticketId: t1.ticketId })).status).toBe(200);
    // Host admits a fresh ticket.
    const t2 = joins.createJoinTicket({ shareId: full.shareId, sessionId: "S1", peerName: "guest2" });
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/join-admit", "host", { ticketId: t2.ticketId })).status).toBe(200);
  });

  it("/join-deny: spectate peer rejected; full peer (same session) passes", async () => {
    const { joins, full, spectate } = await setup();
    const t1 = joins.createJoinTicket({ shareId: full.shareId, sessionId: "S1", peerName: "guest" });
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/join-deny", `peer:${spectate.shareId}`, { ticketId: t1.ticketId })).status).toBe(403);
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/join-deny", `peer:${full.shareId}`, { ticketId: t1.ticketId })).status).toBe(200);
  });

  it("/pending-joins: host + full peer allowed; drive/spectate rejected", async () => {
    const { drive, spectate, full } = await setup();
    expect((await reqJson(srv.socketPath, srv.token, "GET", "/pending-joins")).status).toBe(200);
    expect((await reqJson(srv.socketPath, srv.token, "GET", "/pending-joins", `peer:${full.shareId}`)).status).toBe(200);
    expect((await reqJson(srv.socketPath, srv.token, "GET", "/pending-joins", `peer:${drive.shareId}`)).status).toBe(403);
    expect((await reqJson(srv.socketPath, srv.token, "GET", "/pending-joins", `peer:${spectate.shareId}`)).status).toBe(403);
  });

  it("/shares/:id/revoke: drive rejected; full peer (same session) passes; full peer denied cross-session", async () => {
    const { shares, full, drive } = await setup();
    // Fresh disposable targets in S1 (revoke consumes them).
    const target1 = shares.createShare({ sessionId: "S1", publicHost: "h.example", capability: "spectate" });
    const target2 = shares.createShare({ sessionId: "S1", publicHost: "h.example", capability: "spectate" });
    const targetS2 = shares.createShare({ sessionId: "S2", publicHost: "h.example", capability: "spectate" });
    // drive peer can't revoke.
    expect((await reqJson(srv.socketPath, srv.token, "POST", `/shares/${target1.shareId}/revoke`, `peer:${drive.shareId}`)).status).toBe(403);
    // full peer in S1 revokes a S1 share.
    expect((await reqJson(srv.socketPath, srv.token, "POST", `/shares/${target1.shareId}/revoke`, `peer:${full.shareId}`)).status).toBe(200);
    // full peer in S1 cannot revoke a share in S2.
    expect((await reqJson(srv.socketPath, srv.token, "POST", `/shares/${targetS2.shareId}/revoke`, `peer:${full.shareId}`)).status).toBe(403);
    // host revokes anything.
    expect((await reqJson(srv.socketPath, srv.token, "POST", `/shares/${target2.shareId}/revoke`, "host")).status).toBe(200);
  });

  it("POST /shares (create): drive/spectate rejected; host + full peer (own session) pass; full peer denied cross-session", async () => {
    const { full, drive, spectate } = await setup();
    const body = { sessionId: "S1", publicHost: "h.example" };
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/shares", `peer:${drive.shareId}`, body)).status).toBe(403);
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/shares", `peer:${spectate.shareId}`, body)).status).toBe(403);
    // A full peer in S1 cannot mint a link for S2.
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/shares", `peer:${full.shareId}`, { sessionId: "S2", publicHost: "h.example" })).status).toBe(403);
    // Allowed callers clear the capability/scope guard (downstream 404 because the
    // mocked session doesn't exist — the point is only that it's NOT a 403).
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/shares", `peer:${full.shareId}`, body)).status).not.toBe(403);
    expect((await reqJson(srv.socketPath, srv.token, "POST", "/shares", "host", body)).status).not.toBe(403);
  });

  it("GET /shares: host + full peer allowed; spectate rejected", async () => {
    const { full, spectate } = await setup();
    expect((await reqJson(srv.socketPath, srv.token, "GET", "/shares")).status).toBe(200);
    expect((await reqJson(srv.socketPath, srv.token, "GET", "/shares", `peer:${full.shareId}`)).status).toBe(200);
    expect((await reqJson(srv.socketPath, srv.token, "GET", "/shares", `peer:${spectate.shareId}`)).status).toBe(403);
  });
});

describe("/events/stream — SSE client cap", () => {
  let srv: CapsServer;

  afterEach(async () => {
    delete process.env.HOOOP_MAX_SSE_CLIENTS;
    if (srv) await srv.close();
  });

  it("accepts the Nth client and rejects the (N+1)th with 503 + Retry-After", async () => {
    srv = await startServerWith({ HOOOP_MAX_SSE_CLIENTS: "1" });

    const first = await openSseConnection(srv.socketPath, srv.token);
    expect(first.status).toBe(200);

    const second = await openSseConnection(srv.socketPath, srv.token);
    expect(second.status).toBe(503);
    expect(second.headers["retry-after"]).toBe("10");

    first.destroy();
    second.destroy();
  });

  it("decrements the counter when a client disconnects, allowing a new one", async () => {
    srv = await startServerWith({ HOOOP_MAX_SSE_CLIENTS: "1" });

    const first = await openSseConnection(srv.socketPath, srv.token);
    expect(first.status).toBe(200);

    first.destroy();
    // Give the server a tick to process the close event.
    await new Promise((r) => setTimeout(r, 50));

    const second = await openSseConnection(srv.socketPath, srv.token);
    expect(second.status).toBe(200);
    second.destroy();
  });
});
