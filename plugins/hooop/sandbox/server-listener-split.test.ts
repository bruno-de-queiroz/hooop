/**
 * The control/hook listener partition.
 *
 * The sandbox serves one route table over TWO Unix sockets: control routes on
 * the volume the dashboard container shares, and the three hook routes on a
 * container-local socket the in-container hook scripts use. The split exists
 * because the hook scripts are children of the model's own claude process — so
 * whatever they can reach, a compromised model can reach. Confining them to
 * their own listener means a request arriving there cannot even NAME a control
 * route, no matter which credential it presents.
 *
 * These tests assert that property directly, plus the table-wide invariant that
 * every route is served by exactly one listener. Without that last one, a
 * future route that forgets its `auth` tag silently defaults to "sandbox" and
 * nothing notices.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import { EventEmitter } from "node:events";

// Same shape of mocks as the other server tests: stub every heavy dep so the
// route table can be exercised without a DB, a claude subprocess or a watcher.
vi.mock("./lib/ingestor", () => ({
  ingestEventLine: vi.fn(() => ({ ok: true, id: 1 })),
  eventsBus: new EventEmitter(),
}));
vi.mock("./lib/sessions", () => ({
  listSessions: () => [],
  getSession: () => undefined,
  sessionsBus: new EventEmitter(),
  startSessionsWatcher: vi.fn(),
  stopSessionsWatcher: vi.fn(),
  isPidAlive: () => false,
}));
vi.mock("./lib/active-sessions", () => ({
  listActiveSessions: () => [],
  getActiveSession: () => undefined,
  isControllable: () => false,
  startNewConversation: vi.fn(),
  writeUserTurn: vi.fn(),
  interruptSession: vi.fn(),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  getPendingRequests: () => [],
  respondToPermission: vi.fn(),
  createPermissionRequest: vi.fn(() => ({ requestId: "r1", sessionId: "s1" })),
  peekPermissionDecision: vi.fn(() => null),
  awaitPermissionDecision: vi.fn(async () => ({ decision: "timeout", reason: null })),
  popPendingAuthor: () => ({ author: null, thumbnails: null, kind: null, promptOverride: null }),
  markSessionActive: vi.fn(),
  markTurnFinished: vi.fn(),
  setSessionAutoMode: vi.fn(),
  setSessionModel: vi.fn(),
  startSkillSession: vi.fn(),
  trustPeerForSession: vi.fn(),
  sessionRootFromCwd: () => null,
  activeSessionsBus: new EventEmitter(),
  startIdleSweeper: vi.fn(),
  stopIdleSweeper: vi.fn(),
}));
vi.mock("./lib/skills", () => ({ listSkills: () => [], startSkillsWatcher: vi.fn(), stopSkillsWatcher: vi.fn(), skillsBus: new EventEmitter() }));
vi.mock("./lib/commands", () => ({ listSlashCommands: () => [] }));
vi.mock("./lib/agents", () => ({ listAgentRuns: () => [], getAgentDetail: () => undefined }));
vi.mock("./lib/search", () => ({ search: vi.fn(async () => ({ results: [], total: 0 })) }));
vi.mock("./lib/mcps", () => ({ listMcps: () => ({ servers: [] }) }));
vi.mock("./lib/stack", () => ({ getStack: () => ({ plugins: [] }) }));
vi.mock("./lib/identity", () => ({ getIdentity: () => ({ authenticated: false }) }));
vi.mock("./lib/session-model", () => ({ getSessionModel: () => null, setSessionModelPref: vi.fn() }));
vi.mock("./lib/events-query", () => ({ listEvents: () => [], getEvent: () => undefined }));
vi.mock("./lib/cwd-policy", () => ({ isAllowedCwd: () => ({ ok: true }), canonicalize: (p: string) => p }));
vi.mock("./lib/db", () => ({ backupEventsDb: vi.fn(), checkpointDb: vi.fn() }));
vi.mock("./lib/file-watch", () => ({ startFileWatcher: vi.fn(), stopFileWatcher: vi.fn(), fileChangeBus: new EventEmitter() }));
// Must match the real export shape: dispatch calls mutatingLimiter.check()
// BEFORE its try/catch, so a wrong mock throws unhandled and the request hangs
// rather than failing loudly.
vi.mock("./rate-limit", () => ({ mutatingLimiter: { check: vi.fn(() => ({ ok: true, resetSec: 0 })) } }));
vi.mock("./logger", () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() } }));
vi.mock("./shutdown", () => ({ registerShutdown: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };
let dir = "";
const SANDBOX_TOKEN = "sandbox-token-".padEnd(64, "x");
const HOOK_TOKEN = "hook-token-".padEnd(64, "y");

interface Listener {
  socketPath: string;
  close(): Promise<void>;
}

async function start(kind: "control" | "hook", name: string): Promise<Listener> {
  const socketPath = join(dir, `${name}.sock`);
  const { createSandboxServer } = await import("./server");
  const server = createSandboxServer(kind);
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));
  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function req(
  socketPath: string,
  method: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let body: string | undefined;
    if (method !== "GET") {
      body = "{}";
      h["content-type"] = "application/json";
      h["content-length"] = String(Buffer.byteLength(body));
    }
    const r = httpRequest({ socketPath, method, path, headers: h }, (res) => {
      res.resume();
      resolve({ status: res.statusCode ?? 0 });
    });
    r.on("error", reject);
    if (body) r.write(body);
    r.end();
  });
}

let control: Listener;
let hook: Listener;

beforeEach(async () => {
  vi.resetModules();
  dir = mkdtempSync(join(tmpdir(), "listener-split-"));
  const sandboxTokenFile = join(dir, "sandbox.token");
  writeFileSync(sandboxTokenFile, SANDBOX_TOKEN);
  process.env.HOOOP_SANDBOX_TOKEN_FILE = sandboxTokenFile;

  // hookToken() reads $STATE_DIR/hook.token; mock the module so both tokens
  // are known and distinct.
  vi.doMock("./auth", () => ({
    SANDBOX_TOKEN_HEADER: "x-sandbox-token",
    HOOK_TOKEN_HEADER: "x-hook-token",
    sandboxTokenMatches: (t: string | null) => t === SANDBOX_TOKEN,
    hookTokenMatches: (t: string | null) => t === HOOK_TOKEN,
    sandboxToken: () => SANDBOX_TOKEN,
    hookToken: () => HOOK_TOKEN,
  }));

  control = await start("control", "control");
  hook = await start("hook", "hook");
});

afterEach(async () => {
  await control?.close();
  await hook?.close();
  rmSync(dir, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

const asHost = { "x-sandbox-token": SANDBOX_TOKEN, "x-hooop-participant": "host" };
const asHook = { "x-hook-token": HOOK_TOKEN };

describe("listener partition", () => {
  it("a valid SANDBOX token on the HOOK listener cannot reach a control route", async () => {
    // The threat: the model's process tree can reach the hook socket by
    // design. If it ever also obtained the sandbox token, the socket it can
    // reach must still not serve the control plane.
    for (const [method, path] of [
      ["POST", "/sessions"],
      ["POST", "/sessions/s1/permission"],
      ["POST", "/sessions/s1/auto-mode"],
      ["POST", "/sessions/s1/bash"],
      ["GET", "/shares"],
    ] as const) {
      const { status } = await req(hook.socketPath, method, path, asHost);
      // 404, not 403 — the wrong socket must not confirm the route exists.
      expect({ path, status }).toEqual({ path, status: 404 });
    }
  });

  it("a valid HOOK token on the CONTROL listener cannot reach a hook route", async () => {
    for (const [method, path] of [
      ["POST", "/ingest"],
      ["POST", "/permission-ask"],
      ["GET", "/permission-wait?requestId=x"],
    ] as const) {
      const { status } = await req(control.socketPath, method, path, asHook);
      expect({ path, status }).toEqual({ path, status: 404 });
    }
  });

  it("each listener does serve its own routes", async () => {
    // Guard against "everything 404s" trivially satisfying the two tests above.
    expect((await req(hook.socketPath, "POST", "/permission-ask", asHook)).status).not.toBe(404);
    expect((await req(control.socketPath, "GET", "/shares", asHost)).status).not.toBe(404);
  });

  it("/health answers on BOTH listeners (the root healthcheck needs it)", async () => {
    expect((await req(control.socketPath, "GET", "/health", {})).status).toBe(200);
    expect((await req(hook.socketPath, "GET", "/health", {})).status).toBe(200);
  });

  it("every route is served by exactly one listener, and only /health by both", async () => {
    // The invariant that catches a future route with a forgotten auth tag:
    // `add()` defaults to "sandbox", so a hook route that omits it would
    // silently move to the control plane.
    const { routeTable } = await import("./server");
    const table = routeTable();
    expect(table.length).toBeGreaterThan(10); // sanity: the table actually loaded

    const both = table.filter((r) => r.auth === "none").map((r) => r.path);
    expect(both).toEqual(["/health"]);

    // Exactly the three hook routes, and nothing else, live on the hook side.
    const hookRoutes = table.filter((r) => r.auth === "hook").map((r) => r.path).sort();
    expect(hookRoutes).toEqual(["/ingest", "/permission-ask", "/permission-wait"]);
  });
});
