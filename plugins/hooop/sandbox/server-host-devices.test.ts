/**
 * server-host-devices.test.ts — the participant GRAMMAR, at the route layer.
 *
 * The sandbox has always known two spellings of "who is calling": `host` and
 * `peer:<shareId>`. This adds a third, `host:<deviceId>`, for the operator on one
 * of their own enrolled devices — and a third spelling of the most powerful
 * identity in the system is exactly the kind of change that deserves tests at the
 * boundary rather than only in the registry beneath it.
 *
 * So these run a real server on a temp Unix socket against the REAL device
 * registry (HOME redirected), and ask the questions that matter: does a live
 * device get host powers, does a dead one lose them instantly, and can anything
 * that merely LOOKS like `host:` talk its way in.
 *
 * Same mock strategy as server-push.test.ts for the heavy deps.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs";
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
  createShare: vi.fn(() => ({ ...share, shareId: "new-share" })),
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

// ---- session registry: controllable status, so dormancy can be simulated ----
let sessionStatus = "alive";
const getActiveSession = vi.fn((id: string) => ({ sessionId: id, cwd: "/tmp", status: sessionStatus }));
const wakeSession = vi.fn(async (_sessionId: string) => ({}));

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
  getActiveSession: (...a: unknown[]) => getActiveSession(...(a as [string])),
  markSessionActive: vi.fn(), wakeSession: (...a: unknown[]) => wakeSession(...(a as [string])),
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

let prevHome: string | undefined;
let fakeHome: string;

async function startTestServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-host-devices-"));
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

const HOST = "abc123.trycloudflare.com";

let srv: TestServer;

beforeEach(async () => {
  vi.clearAllMocks();
  sessionStatus = "alive";
  prevHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), "sandbox-host-devices-home-"));
  process.env.HOME = fakeHome;
  vi.resetModules();
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

/** Walk the real ceremony: host mints a code, the device redeems it. */
async function enrollFully(opts: { label?: string; sessionId?: string } = {}) {
  const minted = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
    { publicHost: HOST, label: opts.label ?? "Pixel", sessionId: opts.sessionId ?? null });
  expect(minted.status).toBe(200);
  const { code } = JSON.parse(minted.body) as { code: string };
  // No participant header at all: the phone holds nothing yet, which is the whole
  // problem the code exists to solve.
  const redeemed = await doRequest(srv.socketPath, "POST", "/host-devices/redeem", srv.token,
    { code, publicHost: HOST }, null);
  expect(redeemed.status).toBe(200);
  return JSON.parse(redeemed.body) as { deviceId: string; sessionId: string | null };
}

async function enrollDevice(label = "Pixel"): Promise<string> {
  return (await enrollFully({ label })).deviceId;
}

describe("host device enrollment routes", () => {
  it("mints a code for the host and redeems it into a device", async () => {
    const deviceId = await enrollDevice();
    expect(deviceId).toBeTruthy();
    const list = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token);
    expect(list.status).toBe(200);
    expect(JSON.parse(list.body).devices).toHaveLength(1);
  });

  it("answers 409 with a plain reason when the device list is full", async () => {
    // The host is authenticated here, so this is the one enrollment failure we
    // spell out — the redeem side has to stay opaque, which would otherwise leave
    // them reading "invalid or expired code" on the phone for a full list.
    for (let i = 0; i < 8; i++) await enrollDevice(`d${i}`);
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST });
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).error).toContain("revoke one first");
  });

  it("refuses to mint a code for a peer", async () => {
    // A guest handing out host credentials would invert the entire trust model.
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST }, "peer:share-1");
    expect(res.status).toBe(403);
  });

  it("refuses to mint a code for a caller with no participant header", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST }, null);
    expect(res.status).toBe(403);
  });

  it("refuses to redeem a code on a different hostname", async () => {
    const minted = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST });
    const { code } = JSON.parse(minted.body) as { code: string };
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/redeem", srv.token,
      { code, publicHost: "evil.example.com" }, null);
    expect(res.status).toBe(403);
  });

  it("refuses a bogus code", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/redeem", srv.token,
      { code: "NOTREAL1", publicHost: HOST }, null);
    expect(res.status).toBe(403);
  });

  it("never lists devices to a peer", async () => {
    await enrollDevice();
    const res = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token, undefined, "peer:share-1");
    expect(res.status).toBe(403);
  });
});

describe("the `host:<deviceId>` participant", () => {
  it("is the HOST: it passes a host-only route", async () => {
    const deviceId = await enrollDevice();
    const res = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token, undefined, `host:${deviceId}`);
    expect(res.status).toBe(200);
  });

  it("loses everything the moment the device is revoked", async () => {
    const deviceId = await enrollDevice();
    const revoke = await doRequest(srv.socketPath, "POST", `/host-devices/${deviceId}/revoke`, srv.token);
    expect(revoke.status).toBe(200);
    const after = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token, undefined, `host:${deviceId}`);
    expect(after.status).toBe(403);
  });

  it("can revoke ITSELF (the sign-this-phone-out button)", async () => {
    const deviceId = await enrollDevice();
    const res = await doRequest(srv.socketPath, "POST", `/host-devices/${deviceId}/revoke`, srv.token,
      undefined, `host:${deviceId}`);
    expect(res.status).toBe(200);
    const after = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token, undefined, `host:${deviceId}`);
    expect(after.status).toBe(403);
  });

  it("an INVENTED device id is not the host", async () => {
    // The load-bearing assertion. If the sandbox trusted the string shape rather
    // than the registry, `host:anything` would be a total auth bypass — and the
    // dashboard is explicitly the untrusted side of this boundary.
    const res = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token, undefined, "host:made-up");
    expect(res.status).toBe(403);
  });

  it("an EMPTY device id is not the host either", async () => {
    const res = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token, undefined, "host:");
    expect(res.status).toBe(403);
  });

  it("reports a dead device as revoked rather than malformed", async () => {
    // The distinction is the difference between "log out and scan again" and
    // "something is broken", so the message has to pick the right one.
    // Any route guarded by checkParticipant will do; revoking a share is one
    // that resolves its target first, so the 403 we read is the participant gate's.
    const res = await doRequest(srv.socketPath, "POST", "/shares/share-1/revoke", srv.token,
      undefined, "host:made-up");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("device");
  });

  it("shares its identity with the local host, not its own", async () => {
    // One person, several screens: the device sees the same share list the laptop
    // does, because it is not a separate participant.
    const deviceId = await enrollDevice();
    const asHost = await doRequest(srv.socketPath, "GET", "/shares", srv.token);
    const asDevice = await doRequest(srv.socketPath, "GET", "/shares", srv.token, undefined, `host:${deviceId}`);
    expect(asDevice.status).toBe(200);
    expect(asDevice.body).toEqual(asHost.body);
  });
});

describe("device liveness probe (for the front process's live feeds)", () => {
  it("answers 200 while enrolled and 404 once revoked", async () => {
    const deviceId = await enrollDevice();
    // Deliberately reachable with no participant identity: the front process
    // holds the WebSockets and has none to present.
    const live = await doRequest(srv.socketPath, "GET", `/host-devices/${deviceId}`, srv.token, undefined, null);
    expect(live.status).toBe(200);
    await doRequest(srv.socketPath, "POST", `/host-devices/${deviceId}/revoke`, srv.token);
    const dead = await doRequest(srv.socketPath, "GET", `/host-devices/${deviceId}`, srv.token, undefined, null);
    expect(dead.status).toBe(404);
  });

  it("404s an unknown device", async () => {
    const res = await doRequest(srv.socketPath, "GET", "/host-devices/nope", srv.token, undefined, null);
    expect(res.status).toBe(404);
  });
});

describe("tunnel teardown", () => {
  it("revoke-all clears enrolled devices along with shares", async () => {
    // Every device is bound to the tunnel hostname that just disappeared, so a
    // survivor would be dangling HOST authority rather than a stale guest link.
    const deviceId = await enrollDevice();
    const res = await doRequest(srv.socketPath, "POST", "/shares/revoke-all", srv.token);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body).devicesRevoked).toBe(1);
    const after = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token, undefined, `host:${deviceId}`);
    expect(after.status).toBe(403);
  });
});

describe("last seen", () => {
  it("starts at the moment of enrollment, not at nothing", async () => {
    // "not used yet" about a device that just walked in reads as a broken
    // feature. Redeeming the code IS the device talking to us.
    const deviceId = await enrollDevice();
    const list = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token);
    const [d] = JSON.parse(list.body).devices as Array<{ deviceId: string; lastSeenAt: number | null }>;
    expect(d.deviceId).toBe(deviceId);
    expect(d.lastSeenAt).toBeGreaterThan(0);
  });

  it("advances on ANY request the device makes, not just guarded ones", async () => {
    // The bug this covers: last-seen was only stamped by the participant guards,
    // and most read routes never consult the participant at all — so a phone
    // loading the transcript and the file tree looked idle.
    const deviceId = await enrollDevice();
    const before = JSON.parse(
      (await doRequest(srv.socketPath, "GET", "/host-devices", srv.token)).body,
    ).devices[0].lastSeenAt as number;

    await new Promise((r) => setTimeout(r, 5));
    // A plain read route that does not look at the participant at all.
    const read = await doRequest(srv.socketPath, "GET", "/sessions", srv.token, undefined, `host:${deviceId}`);
    expect(read.status).toBe(200);

    const after = JSON.parse(
      (await doRequest(srv.socketPath, "GET", "/host-devices", srv.token)).body,
    ).devices[0].lastSeenAt as number;
    expect(after).toBeGreaterThan(before);
  });

  it("advances on the liveness probe, so a device with an open feed reads as here", async () => {
    const deviceId = await enrollDevice();
    const before = JSON.parse(
      (await doRequest(srv.socketPath, "GET", "/host-devices", srv.token)).body,
    ).devices[0].lastSeenAt as number;

    await new Promise((r) => setTimeout(r, 5));
    await doRequest(srv.socketPath, "GET", `/host-devices/${deviceId}`, srv.token, undefined, null);

    const after = JSON.parse(
      (await doRequest(srv.socketPath, "GET", "/host-devices", srv.token)).body,
    ).devices[0].lastSeenAt as number;
    expect(after).toBeGreaterThan(before);
  });

  it("never stamps a revoked device back to life", async () => {
    const deviceId = await enrollDevice();
    await doRequest(srv.socketPath, "POST", `/host-devices/${deviceId}/revoke`, srv.token);
    const read = await doRequest(srv.socketPath, "GET", "/sessions", srv.token, undefined, `host:${deviceId}`);
    // The read route itself doesn't gate on the participant, so it still answers —
    // the point is that the dead device is not resurrected in the registry.
    expect(read.status).toBe(200);
    const list = await doRequest(srv.socketPath, "GET", "/host-devices", srv.token);
    expect(JSON.parse(list.body).devices).toHaveLength(0);
  });
});

describe("waking a dormant session", () => {
  it("wakes it when a device is added from that session's dialog", async () => {
    // Adding a device to a session you are looking at should leave that session
    // running, or the new screen arrives at a session with no agent behind it.
    sessionStatus = "dormant";
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST, sessionId: "sess-1" });
    expect(res.status).toBe(200);
    expect(wakeSession).toHaveBeenCalledWith("sess-1");
  });

  it("leaves an already-awake session alone", async () => {
    sessionStatus = "alive";
    await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST, sessionId: "sess-1" });
    expect(wakeSession).not.toHaveBeenCalled();
  });

  it("never tries to revive an EXPIRED session", async () => {
    sessionStatus = "expired";
    await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST, sessionId: "sess-1" });
    expect(wakeSession).not.toHaveBeenCalled();
  });

  it("still mints the code when the session is unknown", async () => {
    // The sessionId is a hint, not a parameter of the grant. A stale one must not
    // cost the host their code.
    getActiveSession.mockReturnValueOnce(undefined as never);
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST, sessionId: "gone" });
    expect(res.status).toBe(200);
    expect(wakeSession).not.toHaveBeenCalled();
  });

  it("wakes it when a SHARE is created for it, the other way somebody arrives", async () => {
    // Same helper, same reasoning: a guest who redeems a link and is admitted
    // should not land in a session with no agent running. Asserted here beside the
    // device case because there is one wake path, not two.
    sessionStatus = "dormant";
    const res = await doRequest(srv.socketPath, "POST", "/shares", srv.token,
      { sessionId: "sess-1", publicHost: HOST });
    expect(res.status).toBe(200);
    expect(wakeSession).toHaveBeenCalledWith("sess-1");
  });

  it("still mints the code when waking fails", async () => {
    sessionStatus = "dormant";
    wakeSession.mockRejectedValueOnce(new Error("nope"));
    const res = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST, sessionId: "sess-1" });
    expect(res.status).toBe(200);
  });
});

describe("where the device lands", () => {
  it("comes back with the session the code was minted from", async () => {
    // A peer is redirected to the one session their share binds them to. A device
    // has no such binding, so without this it arrived with nothing selected — the
    // "Start a session" form, as if the enrollment had gone somewhere else.
    const { sessionId } = await enrollFully({ sessionId: "sess-1" });
    expect(sessionId).toBe("sess-1");
  });

  it("follows a resume that swapped the id mid-enrollment", async () => {
    // The code lives for two minutes; `claude --resume` can rename the session
    // inside that window, and sending the device to the old id would drop it on
    // the session list.
    const minted = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST, sessionId: "sess-1" });
    const { code } = JSON.parse(minted.body) as { code: string };
    getActiveSession.mockImplementation(() => ({ sessionId: "sess-1-resumed", cwd: "/tmp", status: sessionStatus }));

    const redeemed = await doRequest(srv.socketPath, "POST", "/host-devices/redeem", srv.token,
      { code, publicHost: HOST }, null);
    expect((JSON.parse(redeemed.body) as { sessionId: string }).sessionId).toBe("sess-1-resumed");
  });

  it("lands nowhere in particular when the session has gone", async () => {
    const minted = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
      { publicHost: HOST, sessionId: "sess-1" });
    const { code } = JSON.parse(minted.body) as { code: string };
    getActiveSession.mockReturnValue(undefined as never);

    const redeemed = await doRequest(srv.socketPath, "POST", "/host-devices/redeem", srv.token,
      { code, publicHost: HOST }, null);
    expect(redeemed.status).toBe(200);
    expect((JSON.parse(redeemed.body) as { sessionId: string | null }).sessionId).toBeNull();
  });

  it("is null when the host minted the code outside any session", async () => {
    const { sessionId } = await enrollFully({});
    expect(sessionId).toBeNull();
  });
});
