/**
 * server-push.test.ts — the /push route table's authorisation surface.
 *
 * Everything else about notifications is unit-tested in lib/push.test.ts; what
 * this covers is the layer between the socket and that store — who is allowed
 * to call these routes at all, and whether a peer's claims about session scope
 * are believed. That layer had no tests, which is precisely where an
 * endpoint-ownership gap survived review.
 *
 * Same strategy as server.test.ts: mock the heavy deps, run a real server on a
 * temp Unix socket. lib/push is mocked so these assertions are about routing and
 * gating, and nothing touches HOME.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingMessage } from "node:http";

// ---- push store: mocked so we can observe what the routes hand it ----
const addSubscription = vi.fn(() => ({ id: "sub-1" }));
const removeSubscription = vi.fn(() => ({ ok: true }));
const setParticipantActive = vi.fn(() => ({ ok: true }));
const setMute = vi.fn();
const listMutes = vi.fn(() => [] as Array<{ ownerKey: string; sessionId: string | null; mutedAt: number }>);

class PushOwnershipError extends Error {}

vi.mock("./lib/push", () => ({
  vapidPublicKey: () => "test-public-key",
  addSubscription: (...a: unknown[]) => addSubscription(...(a as [])),
  removeSubscription: (...a: unknown[]) => removeSubscription(...(a as [])),
  setParticipantActive: (...a: unknown[]) => setParticipantActive(...(a as [])),
  setMute: (...a: unknown[]) => setMute(...(a as [])),
  listMutes: (...a: unknown[]) => listMutes(...(a as [])),
  ownerKeyFor: (kind: string, shareId: string | null) => (kind === "host" ? "host" : `peer:${shareId}`),
  startPushNotifier: vi.fn(),
  setCanonicalResolver: vi.fn(),
  PushOwnershipError,
}));

// ---- share registry: a controllable peer grant ----
const share = {
  shareId: "share-1",
  sessionId: "sess-peer",
  capability: "spectate" as "full" | "drive" | "spectate",
  publicHost: "x.trycloudflare.com",
  peerName: "Ana",
  createdAt: 0,
  expiresAt: null,
  revoked: false,
  joinedBefore: true,
};
let shareLive = true;

vi.mock("./lib/shares", () => ({
  bootShares: vi.fn(),
  createShare: vi.fn(),
  revokeShare: vi.fn(),
  revokeAllShares: vi.fn(() => ({ revoked: [] })),
  revokeSharesForSession: vi.fn(() => ({ revoked: [] })),
  setSharePeerName: vi.fn(),
  markShareJoined: vi.fn(),
  listShares: vi.fn(() => []),
  getShare: vi.fn(() => (shareLive ? share : null)),
  onSharesRevoked: vi.fn(),
  validateShareById: vi.fn(() => (shareLive ? { ok: true, record: share } : { ok: false, reason: "revoked" })),
  normalizeHost: (h: string) => h,
  // The real gate: notify is the one action every capability permits.
  capabilityAllows: (cap: string, action: string) =>
    action === "notify" ? true : cap === "full" ? true : cap === "drive" && action === "turn",
}));

// ---- remaining heavy deps (mirrors server.test.ts) ----
vi.mock("./lib/ingestor", () => ({
  ingestEventLine: vi.fn(() => ({ ok: true, id: 1 })),
  startIngestor: vi.fn(),
  eventBus: new EventEmitter(),
}));
vi.mock("./lib/sessions", () => ({
  listSessions: () => [], startSessionsWatcher: vi.fn(), stopSessionsWatcher: vi.fn(), sessionsBus: new EventEmitter(),
}));
vi.mock("./lib/active-sessions", () => ({
  startNewConversation: vi.fn(), startSkillSession: vi.fn(),
  isValidSkillName: () => true, writeUserTurn: vi.fn(), isControllable: vi.fn(() => false),
  endSession: vi.fn(), deleteSession: vi.fn(), renameSession: vi.fn(),
  // Identity resolver: every id is already canonical here.
  getActiveSession: vi.fn((id: string) => ({ sessionId: id, cwd: "/tmp", status: "alive" })),
  markSessionActive: vi.fn(), wakeSession: vi.fn(async () => ({})),
  popPendingAuthor: vi.fn(() => ({ author: null, thumbnails: null, kind: null })),
  markTurnFinished: vi.fn(), activeSessionsBus: new EventEmitter(),
  bootActiveSessions: vi.fn(), startIdleSweeper: vi.fn(), shutdownActiveSessions: vi.fn(),
}));
vi.mock("./lib/skills", () => ({ listSkills: () => [], startSkillsWatcher: vi.fn(), stopSkillsWatcher: vi.fn(), skillsBus: new EventEmitter() }));
vi.mock("./lib/commands", () => ({ listSlashCommands: () => [] }));
vi.mock("./lib/agents", () => ({ listAgentRuns: () => [], getAgentDetail: () => undefined }));
vi.mock("./lib/search", () => ({ search: vi.fn(async () => ({ results: [], total: 0 })) }));
vi.mock("./lib/mcps", () => ({ listMcps: () => ({ servers: [] }) }));
vi.mock("./lib/stack", () => ({ getStack: () => ({ plugins: [] }) }));
vi.mock("./lib/identity", () => ({ getIdentity: () => ({ authenticated: false }) }));
vi.mock("./lib/session-model", () => ({
  getSessionModel: () => ({ model: null }),
  resolveDisplayModel: (c: string | null, r: string | null) => c ?? r ?? null,
}));
vi.mock("./lib/events-query", () => ({ listEvents: () => [], getEvent: () => undefined }));
vi.mock("./lib/cwd-policy", () => ({ isAllowedCwd: () => ({ ok: true }), canonicalize: (p: string) => p }));
vi.mock("./lib/db", () => ({ backupEventsDb: vi.fn(), checkpointDb: vi.fn() }));
vi.mock("./rate-limit", () => ({ mutatingLimiter: { check: vi.fn(() => ({ ok: true })) } }));
vi.mock("./logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
vi.mock("./shutdown", () => ({ registerShutdown: vi.fn() }));

// ---- harness ----

interface TestServer { socketPath: string; token: string; close(): Promise<void> }

async function startTestServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-push-routes-"));
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
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => {
        if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
        resolve();
      });
    }),
  };
}

function doRequest(
  socketPath: string, method: string, path: string, token: string,
  body?: unknown, participant: string | null = "host",
): Promise<{ status: number; body: string }> {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "x-sandbox-token": token };
    if (participant) headers["x-hooop-participant"] = participant;
    if (payload != null) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = httpRequest({ socketPath, method, path, headers }, (res: IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

const SUB = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };

let srv: TestServer;

beforeEach(async () => {
  vi.clearAllMocks();
  addSubscription.mockReturnValue({ id: "sub-1" });
  removeSubscription.mockReturnValue({ ok: true });
  setParticipantActive.mockReturnValue({ ok: true });
  listMutes.mockReturnValue([]);
  shareLive = true;
  share.capability = "spectate";
  vi.resetModules();
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
  delete process.env.HOOOP_SANDBOX_TOKEN_FILE;
});

describe("/push — who may call at all", () => {
  it("rejects a request with no participant header", async () => {
    // An absent header must never be read as "host" (see checkParticipant).
    const res = await doRequest(srv.socketPath, "GET", "/push/key", srv.token, undefined, null);
    expect(res.status).toBe(403);
  });

  it("rejects a peer whose share has been revoked", async () => {
    shareLive = false;
    const res = await doRequest(srv.socketPath, "GET", "/push/key", srv.token, undefined, "peer:share-1");
    expect(res.status).toBe(403);
  });

  it("serves the public VAPID key to the host", async () => {
    const res = await doRequest(srv.socketPath, "GET", "/push/key", srv.token);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).publicKey).toBe("test-public-key");
  });

  it("lets even a spectate peer enrol — receiving is output, not input", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/push/subscribe", srv.token, SUB, "peer:share-1");
    expect(res.status).toBe(200);
    expect(addSubscription).toHaveBeenCalledWith(expect.objectContaining({
      ownerKind: "peer", shareId: "share-1", sessionId: "sess-peer", capability: "spectate",
    }));
  });
});

describe("/push — scope comes from the share, never the request body", () => {
  it("ignores any session a peer names and uses their share's", async () => {
    await doRequest(srv.socketPath, "POST", "/push/subscribe", srv.token,
      { ...SUB, sessionId: "someone-elses-session" }, "peer:share-1");
    expect(addSubscription).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-peer" }));
  });

  it("refuses a peer muting a session they aren't in", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/push/mute", srv.token,
      { sessionId: "other-session", muted: true }, "peer:share-1");
    expect(res.status).toBe(403);
    expect(setMute).not.toHaveBeenCalled();
  });

  it("allows a peer muting their own session", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/push/mute", srv.token,
      { sessionId: "sess-peer", muted: true }, "peer:share-1");
    expect(res.status).toBe(200);
    expect(setMute).toHaveBeenCalledWith("peer:share-1", "sess-peer", true);
  });

  it("scopes the host's mute to the host owner key", async () => {
    await doRequest(srv.socketPath, "POST", "/push/mute", srv.token, { sessionId: null, muted: true });
    expect(setMute).toHaveBeenCalledWith("host", null, true);
  });

  it("refuses a peer claiming presence on a session they aren't in", async () => {
    // Otherwise a peer could suppress another session's notifications by
    // asserting they're watching it.
    const res = await doRequest(srv.socketPath, "POST", "/push/presence", srv.token,
      { sessionId: "other-session", active: true }, "peer:share-1");
    expect(res.status).toBe(403);
    expect(setParticipantActive).not.toHaveBeenCalled();
  });
});

describe("/push — presence relay", () => {
  it("records the caller under their own owner key, never one they choose", async () => {
    await doRequest(srv.socketPath, "POST", "/push/presence", srv.token,
      { sessionId: "sess-peer", active: true }, "peer:share-1");
    expect(setParticipantActive).toHaveBeenCalledWith("peer:share-1", "sess-peer", null);
  });

  it("passes the viewer id through so one person's screens don't cancel each other", async () => {
    // The whole point: a beat names the SCREEN it came from, so pocketing the
    // phone clears the phone rather than the laptop in front of you.
    await doRequest(srv.socketPath, "POST", "/push/presence", srv.token,
      { sessionId: "sess-host", active: true, viewerId: "tab-a" });
    expect(setParticipantActive).toHaveBeenCalledWith("host", "sess-host", "tab-a");
  });

  it("clears presence when the tab reports itself inactive", async () => {
    // Passing null rather than letting the beat age out means notifications
    // resume the instant someone backgrounds the tab.
    await doRequest(srv.socketPath, "POST", "/push/presence", srv.token,
      { sessionId: "sess-host", active: false });
    expect(setParticipantActive).toHaveBeenCalledWith("host", null, null);
  });

  it("treats an absent active flag as present, matching the presence route", async () => {
    await doRequest(srv.socketPath, "POST", "/push/presence", srv.token, { sessionId: "sess-host" });
    expect(setParticipantActive).toHaveBeenCalledWith("host", "sess-host", null);
  });

  it("requires a session id", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/push/presence", srv.token, { active: true });
    expect(res.status).toBe(400);
  });
});

describe("/push — endpoint ownership is carried to the store", () => {
  it("passes the caller's owner key when unsubscribing", async () => {
    // The store refuses a mismatch; the route's job is to never let the caller
    // choose whose subscription it is.
    await doRequest(srv.socketPath, "POST", "/push/unsubscribe", srv.token,
      { endpoint: SUB.endpoint }, "peer:share-1");
    expect(removeSubscription).toHaveBeenCalledWith(SUB.endpoint, "peer:share-1");
  });

  it("surfaces a hijack attempt as 403 rather than a 500", async () => {
    addSubscription.mockImplementation(() => { throw new PushOwnershipError("nope"); });
    const res = await doRequest(srv.socketPath, "POST", "/push/subscribe", srv.token, SUB, "peer:share-1");
    expect(res.status).toBe(403);
  });
});

describe("/push — input validation", () => {
  it("rejects a non-https endpoint", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/push/subscribe", srv.token,
      { endpoint: "http://push.example/abc", keys: SUB.keys });
    expect(res.status).toBe(400);
    expect(addSubscription).not.toHaveBeenCalled();
  });

  it("rejects a subscription with no keys", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/push/subscribe", srv.token, { endpoint: SUB.endpoint });
    expect(res.status).toBe(400);
  });

  it("requires an explicit muted boolean", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/push/mute", srv.token, { sessionId: "s1" });
    expect(res.status).toBe(400);
  });
});
