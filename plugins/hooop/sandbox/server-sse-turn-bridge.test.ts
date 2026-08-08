/**
 * Pins the `turn → sessions` SSE bridge added in Phase 6.
 *
 * Why this exists: result frames in `active-sessions.ts` update
 * `slot.meta.lastStats.totals` and emit `activeSessionsBus.emit("turn", ...)`.
 * That doesn't touch CLAUDE_SESSIONS_DIR, so the file-watcher backed
 * `sessionsBus.change` doesn't fire. Without the bridge in server.ts,
 * the dashboard would never refresh /api/sessions after a turn end,
 * and the StatsStrip would forever read `tokens: 0 in / 0 out`.
 *
 * This test asserts the bridge: an `activeSessionsBus.emit("turn")` on
 * the sandbox side produces a `sessions` SSE frame on the wire.
 */
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Shared module-scope bus so the test can emit and the route can react.
const mockActiveSessionsBus = new EventEmitter();
mockActiveSessionsBus.setMaxListeners(50);

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
  isValidSkillName: (name: string) => /^[A-Za-z0-9][A-Za-z0-9_:/-]{0,127}$/.test(name),
  writeUserTurn: vi.fn(),
  isControllable: vi.fn(() => false),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  bootActiveSessions: vi.fn(),
  shutdownActiveSessions: vi.fn(),
  activeSessionsBus: mockActiveSessionsBus,
}));
vi.mock("./lib/skills", () => ({ listSkills: () => [], startSkillsWatcher: vi.fn(), stopSkillsWatcher: vi.fn(), skillsBus: new EventEmitter() }));
vi.mock("./lib/commands", () => ({ listSlashCommands: () => [] }));
vi.mock("./lib/agents", () => ({ listAgentRuns: () => [], getAgentDetail: () => undefined }));
vi.mock("./lib/search", () => ({ search: vi.fn(async () => ({ results: [], total: 0 })) }));
vi.mock("./lib/mcps", () => ({ listMcps: () => ({ servers: [] }) }));
vi.mock("./lib/stack", () => ({ getStack: () => ({ plugins: [] }) }));
vi.mock("./lib/identity", () => ({ getIdentity: () => ({ authenticated: false }) }));
vi.mock("./lib/session-model", () => ({ getSessionModel: () => ({ model: null }) }));
vi.mock("./lib/session-summary", () => ({ getSessionSummary: () => null }));
vi.mock("./lib/events-query", () => ({ listEvents: () => [], getEvent: () => undefined }));
vi.mock("./lib/cwd-policy", () => ({ isAllowedCwd: () => ({ ok: true }), isAlreadyAllowed: () => true }));
vi.mock("./lib/db", () => ({ backupEventsDb: vi.fn(), checkpointDb: vi.fn() }));
vi.mock("./lib/files", () => ({
  listFiles: vi.fn(async () => []),
  CwdPolicyError: class extends Error {},
}));
vi.mock("./rate-limit", () => ({
  mutatingLimiter: { check: vi.fn(() => ({ ok: true })) },
}));
vi.mock("./logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
}));
vi.mock("./shutdown", () => ({ registerShutdown: vi.fn() }));

interface TestServer {
  socketPath: string;
  token: string;
  close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-sse-turn-test-"));
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

let srv: TestServer;

beforeEach(async () => {
  vi.resetModules();
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
  // Drain bus subscribers so they don't bleed across tests.
  mockActiveSessionsBus.removeAllListeners();
});

function collectSseFrames(
  count: number,
  filter?: (event: string | null) => boolean,
): Promise<Array<{ event: string | null; data: string }>> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ event: string | null; data: string }> = [];
    const req = httpRequest(
      {
        socketPath: srv.socketPath,
        method: "GET",
        path: "/events/stream",
        headers: { "x-sandbox-token": srv.token },
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE returned ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf-8");
        let buf = "";
        let curEvent: string | null = null;
        const dataLines: string[] = [];
        const flush = () => {
          if (dataLines.length === 0) {
            curEvent = null;
            return;
          }
          const f = { event: curEvent, data: dataLines.join("\n") };
          curEvent = null;
          dataLines.length = 0;
          if (!filter || filter(f.event)) {
            frames.push(f);
            if (frames.length >= count) {
              req.destroy();
              resolve(frames);
            }
          }
        };
        res.on("data", (chunk: string) => {
          buf += chunk;
          let idx: number;
          while ((idx = buf.indexOf("\n")) !== -1) {
            const line = buf.slice(0, idx).replace(/\r$/, "");
            buf = buf.slice(idx + 1);
            if (line === "") {
              flush();
              continue;
            }
            if (line.startsWith(":")) continue;
            if (line.startsWith("event:")) {
              curEvent = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).replace(/^ /, ""));
              continue;
            }
          }
        });
        res.on("error", (e) => {
          if (frames.length < count) reject(e);
        });
      },
    );
    req.on("error", (e) => {
      if (frames.length < count) reject(e);
    });
    req.end();
    setTimeout(() => {
      if (frames.length < count) reject(new Error(`SSE timeout: got ${frames.length}/${count} frames`));
    }, 2000);
  });
}

describe("/events/stream — turn bridge", () => {
  it("emits a `sessions` SSE frame when activeSessionsBus emits `turn`", async () => {
    const p = collectSseFrames(1, (evt) => evt === "sessions");

    // Give the SSE connection a tick to establish before emitting.
    await new Promise((r) => setTimeout(r, 30));

    mockActiveSessionsBus.emit("turn", { sessionId: "turn-test-1", result: "ok" });

    const frames = await p;
    expect(frames).toHaveLength(1);
    expect(frames[0].event).toBe("sessions");
    const payload = JSON.parse(frames[0].data);
    expect(payload).toMatchObject({ changed: true });
  });
});
