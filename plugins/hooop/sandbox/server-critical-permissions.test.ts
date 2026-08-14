/**
 * WHO may answer an escalated permission ask.
 *
 * The gate already refuses to auto-approve the critical set — git, destructive or
 * secret shell commands, secret paths, MCP writes, anything outside the session's
 * folder, publishing a preview — in every unattended mode, and escalates it to a
 * prompt. What it did not do was decide who the prompt belongs to: a
 * full-capability peer could answer any escalated ask, including one raised by
 * their OWN turn. Drive a turn, have the model reach for `rm -rf`, approve it
 * yourself. The comment in active-sessions.ts said "host-only decision"; nothing
 * implemented it.
 *
 * These pin the rule now that it exists, in both directions — a peer must still
 * decide the routine ask sitting right next to the critical one — and pin that the
 * host on an ENROLLED DEVICE counts as the host, which is what makes "only the
 * host" workable rather than a wall: before devices it meant a paired session
 * stalled the moment the operator left their laptop.
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
// One share, bound to the session under test, with a capability each test sets.
// "full" is the interesting one: it is the strongest share there is, so if the rule
// holds for it, it holds.
const share = {
  shareId: "share-1",
  sessionId: "sess-1",
  capability: "full" as "full" | "drive" | "spectate",
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

// ---- the pending ask under test ----
interface Ask { requestId: string; toolName: string; input: unknown; critical?: boolean }
let asks: Ask[] = [];
const getPendingRequests = vi.fn((_id: string) => asks);
const respondToPermission = vi.fn(async () => ({ ok: true as const }));
const createPermissionRequest = vi.fn((_opts: unknown) => ({ requestId: "ask-1", sessionId: "sess-1" }));
let verdict: { decision: "allow" | "deny" | "timeout"; reason?: string | null } = { decision: "deny", reason: "nope" };
const awaitPermissionDecision = vi.fn(async () => verdict);
const withdrawPermissionRequest = vi.fn(() => ({ ok: true }));

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
  // The ask under test, and the call that would settle it.
  getPendingRequests: (...a: unknown[]) => getPendingRequests(...(a as [string])),
  respondToPermission: (...a: unknown[]) => respondToPermission(...(a as [])),
  // The `!bash` escalation: raise a card, park on the decision.
  createPermissionRequest: (opts: unknown) => createPermissionRequest(opts),
  awaitPermissionDecision: (...a: unknown[]) => awaitPermissionDecision(...(a as [])),
  withdrawPermissionRequest: (...a: unknown[]) => withdrawPermissionRequest(...(a as [])),
  peekPermissionDecision: vi.fn(() => undefined),
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
  const dir = mkdtempSync(join(tmpdir(), "sandbox-critical-perms-"));
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
  getActiveSession.mockImplementation((id: string) => ({ sessionId: id, cwd: "/tmp", status: sessionStatus }));
  respondToPermission.mockImplementation(async () => ({ ok: true as const }));
  share.capability = "full";
  verdict = { decision: "deny", reason: "nope" };
  createPermissionRequest.mockImplementation(() => ({ requestId: "ask-1", sessionId: "sess-1" }));
  withdrawPermissionRequest.mockClear();
  // One critical ask and one routine one, side by side in the same session — which
  // is the case that makes this per-request rather than per-viewer.
  asks = [
    { requestId: "danger", toolName: "Bash", input: { command: "rm -rf /workspace" }, critical: true },
    { requestId: "routine", toolName: "Write", input: { file_path: "/tmp/notes.md" } },
  ];
  getPendingRequests.mockImplementation(() => asks);
  prevHome = process.env.HOME;
  fakeHome = mkdtempSync(join(tmpdir(), "sandbox-critical-perms-home-"));
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

const decide = (requestId: string, participant: string | null, extra: Record<string, unknown> = {}) =>
  doRequest(srv.socketPath, "POST", "/sessions/sess-1/permission", srv.token,
    { requestId, decision: "allow", ...extra }, participant);

/** The real enrolment ceremony, so `host:<deviceId>` is a grant the sandbox holds. */
async function enrollDevice(): Promise<string> {
  const minted = await doRequest(srv.socketPath, "POST", "/host-devices/enroll-code", srv.token,
    { publicHost: HOST, label: "phone" });
  const { code } = JSON.parse(minted.body) as { code: string };
  const redeemed = await doRequest(srv.socketPath, "POST", "/host-devices/redeem", srv.token,
    { code, publicHost: HOST }, null);
  return (JSON.parse(redeemed.body) as { deviceId: string }).deviceId;
}

describe("a critical ask is the host's alone", () => {
  it("refuses a FULL peer — the strongest share there is", async () => {
    // The hole: a full share could answer its own turn's `rm -rf`. Not co-driving,
    // the guardrail approving itself.
    const res = await decide("danger", "peer:share-1");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("host");
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("lets the HOST answer it", async () => {
    const res = await decide("danger", "host");
    expect(res.status).toBe(200);
    expect(respondToPermission).toHaveBeenCalled();
  });

  it("lets the host answer it FROM AN ENROLLED DEVICE", async () => {
    // The reason this rule is livable. Before devices, "only the host" meant a
    // paired session stalled as soon as the operator stepped away from the laptop;
    // now the prompt reaches their phone and they can clear it from there.
    const deviceId = await enrollDevice();
    const res = await decide("danger", `host:${deviceId}`);
    expect(res.status).toBe(200);
    expect(respondToPermission).toHaveBeenCalled();
  });

  it("refuses a device whose grant was revoked", async () => {
    const deviceId = await enrollDevice();
    await doRequest(srv.socketPath, "POST", `/host-devices/${deviceId}/revoke`, srv.token);
    const res = await decide("danger", `host:${deviceId}`);
    expect(res.status).toBe(403);
    expect(respondToPermission).not.toHaveBeenCalled();
  });

  it("still lets a full peer answer the ROUTINE ask beside it", async () => {
    // The whole reason this is per-request. Making it per-viewer would take
    // co-driving away to fix the dangerous case.
    const res = await decide("routine", "peer:share-1");
    expect(res.status).toBe(200);
    expect(respondToPermission).toHaveBeenCalled();
  });

  it("checks criticality BEFORE the capability refinements", async () => {
    // A drive peer is refused either way; the message should still be the honest
    // one, and no tool-specific carve-out below may route around the check.
    share.capability = "drive";
    const res = await decide("danger", "peer:share-1");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("host");
  });

  it("tells a peer nothing about the decision they cannot make", async () => {
    // Refused before `decision` is even parsed: a malformed decision on a critical
    // ask must not produce a different error than a well-formed one.
    const bad = await doRequest(srv.socketPath, "POST", "/sessions/sess-1/permission", srv.token,
      { requestId: "danger", decision: "nonsense" }, "peer:share-1");
    expect(bad.status).toBe(403);
    expect(JSON.parse(bad.body).error).toContain("host");
  });
});

describe("standing trust is the host's to grant", () => {
  it("ignores scope:always from a peer, but keeps their decision", async () => {
    // Trust is keyed on the share that DROVE the turn, not on who answers — so a
    // full peer answering their own ask with scope:"always" was granting trust to
    // itself. Not an escalation (they may approve each ask by hand) but it removes
    // the host's sight of their routine asks, self-served, one click.
    const res = await decide("routine", "peer:share-1", { scope: "always" });
    expect(res.status).toBe(200);
    const [, , , , trustPeer] = respondToPermission.mock.calls[0] as unknown[];
    expect(trustPeer).toBe(false);
  });

  it("honours scope:always from the host", async () => {
    const res = await decide("routine", "host", { scope: "always" });
    expect(res.status).toBe(200);
    const [, , , , trustPeer] = respondToPermission.mock.calls[0] as unknown[];
    expect(trustPeer).toBe(true);
  });
});

describe("a guest's destructive `!bash` asks the host", () => {
  // The fast lane bypasses the model AND the permission gate, and peerBashAllowed
  // only ever covered git push, secrets and env dumps. So the most direct
  // destructive path in the product — a guest typing `!rm -rf /workspace` — was the
  // one with nothing in front of it, while peer-policy.ts claimed otherwise.
  const bash = (command: string, participant: string | null) =>
    doRequest(srv.socketPath, "POST", "/sessions/sess-1/bash", srv.token, { command }, participant);

  it("raises a card instead of running it, attributed to the GUEST", async () => {
    const res = await bash("rm -rf /workspace", "peer:share-1");
    expect(res.status).toBe(403);
    expect(createPermissionRequest).toHaveBeenCalledTimes(1);
    const opts = createPermissionRequest.mock.calls[0][0] as {
      toolName: string; input: { command: string }; author: string; shareId: string | null;
    };
    expect(opts.toolName).toBe("Bash");
    expect(opts.input.command).toBe("rm -rf /workspace");
    // Attribution matters: there is no turn behind a shortcut, so without this the
    // guest's command shows on the host's own card as the host's.
    expect(opts.author).toBe("Ana");
    expect(opts.shareId).toBe("share-1");
  });

  it("runs it once the host allows", async () => {
    verdict = { decision: "allow" };
    const res = await bash("git --version", "peer:share-1");
    expect(res.status).toBe(200);
    expect(createPermissionRequest).toHaveBeenCalledTimes(1);
  });

  it("says the host DECLINED, using their reason", async () => {
    verdict = { decision: "deny", reason: "not on my machine" };
    const res = await bash("rm -rf /workspace", "peer:share-1");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("not on my machine");
  });

  it("distinguishes 'nobody answered' from 'the host said no'", async () => {
    // Different sentences, and the guest deserves the accurate one: one means try
    // again later, the other means stop asking.
    verdict = { decision: "timeout" };
    const res = await bash("rm -rf /workspace", "peer:share-1");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("didn't answer");
  });

  it("takes the card BACK when nobody answers in time", async () => {
    // awaitPermissionDecision's timeout only drops the waiter, so the request stays
    // pending. Without withdrawing it, the guest is told nobody answered while the
    // card sits on the host's screen with an Allow button that resolves nothing —
    // they would authorise a destructive command into the void.
    verdict = { decision: "timeout" };
    await bash("rm -rf /workspace", "peer:share-1");
    expect(withdrawPermissionRequest).toHaveBeenCalledTimes(1);
    const [sid, rid] = withdrawPermissionRequest.mock.calls[0] as unknown[];
    expect(sid).toBe("sess-1");
    expect(rid).toBe("ask-1");
  });

  it("leaves the card alone when the host actually decided it", async () => {
    // respondToPermission already removed it; withdrawing again would emit a second
    // event for one ask.
    verdict = { decision: "deny", reason: "no" };
    await bash("rm -rf /workspace", "peer:share-1");
    expect(withdrawPermissionRequest).not.toHaveBeenCalled();

    verdict = { decision: "allow" };
    await bash("git --version", "peer:share-1");
    expect(withdrawPermissionRequest).not.toHaveBeenCalled();
  });

  it("does not ask about a ROUTINE guest command", async () => {
    const res = await bash("echo hello", "peer:share-1");
    expect(res.status).toBe(200);
    expect(createPermissionRequest).not.toHaveBeenCalled();
  });

  it("never asks on the HOST's behalf — they already have a shell", async () => {
    const res = await bash("rm -rf /workspace/build", "host");
    expect(res.status).toBe(200);
    expect(createPermissionRequest).not.toHaveBeenCalled();
  });

  it("still refuses git push outright, without raising a card", async () => {
    // The flat denials come first: an approve button for "push to the host's remote"
    // is a different decision from "delete a build directory", and peerBashAllowed
    // already answered it.
    const res = await bash("git push origin main", "peer:share-1");
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).error).toContain("host-only");
    expect(createPermissionRequest).not.toHaveBeenCalled();
  });

  it("keeps the fast lane closed to a drive share entirely", async () => {
    share.capability = "drive";
    const res = await bash("echo hello", "peer:share-1");
    expect(res.status).toBe(403);
    expect(createPermissionRequest).not.toHaveBeenCalled();
  });
});
