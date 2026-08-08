/**
 * server-ingest.test.ts — integration tests for POST /ingest in server.ts.
 *
 * Tests verify that the route correctly surfaces ingestEventLine failures
 * as HTTP 500 responses instead of silently returning { ok: true }.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingMessage } from "node:http";

// ---- mock heavy deps before any import of server.ts ----

const mockIngestEventLine = vi.fn<(line: string) => { ok: true; id?: number } | { ok: false; reason: string }>();

const HOOK_TOK = "hook-token-".padEnd(64, "h");
const SANDBOX_TOK = "sandbox-token-".padEnd(64, "s");

vi.mock("./auth", () => ({
  sandboxTokenMatches: (t: string | null | undefined) => t === SANDBOX_TOK,
  hookTokenMatches: (t: string | null | undefined) => t === HOOK_TOK,
  sandboxToken: () => SANDBOX_TOK,
  hookToken: () => HOOK_TOK,
  SANDBOX_TOKEN_HEADER: "x-sandbox-token",
  HOOK_TOKEN_HEADER: "x-hook-token",
}));

vi.mock("./lib/ingestor", () => ({
  ingestEventLine: (...a: [string]) => mockIngestEventLine(...a),
  startIngestor: vi.fn(),
  eventBus: new EventEmitter(),
}));

vi.mock("./lib/sessions", () => ({
  listSessions: () => [],
  startSessionsWatcher: vi.fn(),
  stopSessionsWatcher: vi.fn(),
  sessionsBus: new EventEmitter(),
}));

const mockPopPendingAuthor = vi.fn<
  (sessionId: string) => { author: string | null; thumbnails: unknown; kind: string | null; promptOverride: string | null }
>(() => ({ author: null, thumbnails: null, kind: null, promptOverride: null }));

vi.mock("./lib/active-sessions", () => ({
  startNewConversation: vi.fn(),
  startSkillSession: vi.fn(async () => ({ sessionId: "s1" })),
  isValidSkillName: (name: string) => /^[A-Za-z0-9][A-Za-z0-9_:/-]{0,127}$/.test(name),
  writeUserTurn: vi.fn(),
  popPendingAuthor: (...a: [string]) => mockPopPendingAuthor(...a),
  TASK_NOTIFICATION_KIND: "task-notification",
  markTurnFinished: vi.fn(),
  isControllable: vi.fn(() => false),
  endSession: vi.fn(),
  deleteSession: vi.fn(),
  renameSession: vi.fn(),
  activeSessionsBus: new EventEmitter(),
  bootActiveSessions: vi.fn(),
  shutdownActiveSessions: vi.fn(),
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

// ---- helpers ----

interface TestServer {
  socketPath: string;
  hookToken: string;
  close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-ingest-test-"));
  const socketPath = join(dir, "sandbox.sock");

  const { createSandboxServer } = await import("./server");
  // "hook": /ingest is a hook-token route and is served ONLY on the hook
  // listener (see ListenerKind). A control-kind server 404s it, by design.
  const server = createSandboxServer("hook");
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  return {
    socketPath,
    hookToken: HOOK_TOK,
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

function doIngestRequest(
  socketPath: string,
  hookToken: string,
  body: string,
  requestId?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "x-hook-token": hookToken,
      "content-type": "application/json; charset=utf-8",
      "content-length": String(Buffer.byteLength(body)),
    };
    if (requestId) headers["x-request-id"] = requestId;

    const req = httpRequest(
      { socketPath, method: "POST", path: "/ingest", headers },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ---- tests ----

let srv: TestServer;

beforeEach(async () => {
  vi.resetModules();
  mockIngestEventLine.mockReset();
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
});

const VALID_EVENT = JSON.stringify({ hook: "Stop", ts: "2026-05-12T00:00:00Z", ctx: {} });

describe("POST /ingest — result propagation", () => {
  it("returns 200 { ok: true, id } when ingestEventLine returns ok", async () => {
    mockIngestEventLine.mockReturnValueOnce({ ok: true, id: 42 });

    const res = await doIngestRequest(srv.socketPath, srv.hookToken, VALID_EVENT);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(true);
    expect(parsed.id).toBe(42);
  });

  it("returns 200 { ok: true } (no id) when ingestEventLine returns ok without id", async () => {
    mockIngestEventLine.mockReturnValueOnce({ ok: true });

    const res = await doIngestRequest(srv.socketPath, srv.hookToken, VALID_EVENT);

    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(parsed.ok).toBe(true);
  });

  it("returns 500 { error: 'db-ingest-failed', requestId } when ingestEventLine fails with db-ingest-failed", async () => {
    mockIngestEventLine.mockReturnValueOnce({ ok: false, reason: "db-ingest-failed" });

    const res = await doIngestRequest(srv.socketPath, srv.hookToken, VALID_EVENT, "req-abc-123");

    expect(res.status).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("db-ingest-failed");
    expect(parsed.requestId).toBe("req-abc-123");
  });

  it("returns 500 { error: 'audit-log-append-failed' } when ingestEventLine fails with audit-log-append-failed", async () => {
    mockIngestEventLine.mockReturnValueOnce({ ok: false, reason: "audit-log-append-failed" });

    const res = await doIngestRequest(srv.socketPath, srv.hookToken, VALID_EVENT);

    expect(res.status).toBe(500);
    const parsed = JSON.parse(res.body);
    expect(parsed.error).toBe("audit-log-append-failed");
  });

  it("does NOT call ingestEventLine when hook name is invalid", async () => {
    const badEvent = JSON.stringify({ hook: "NotARealHook", ts: "2026-05-12T00:00:00Z", ctx: {} });

    const res = await doIngestRequest(srv.socketPath, srv.hookToken, badEvent);

    expect(res.status).toBe(400);
    expect(mockIngestEventLine).not.toHaveBeenCalled();
  });

  it("returns 401 when hook token is wrong", async () => {
    mockIngestEventLine.mockReturnValueOnce({ ok: true, id: 1 });

    const res = await doIngestRequest(srv.socketPath, "wrong-token-".padEnd(64, "x"), VALID_EVENT);

    expect(res.status).toBe(401);
    expect(mockIngestEventLine).not.toHaveBeenCalled();
  });
});

describe("POST /ingest — task-notification attribution", () => {
  it("tags an author-less UserPromptSubmit whose prompt is a <task-notification> block, instead of leaving it to the null-author-means-host default", async () => {
    mockPopPendingAuthor.mockReturnValueOnce({ author: null, thumbnails: null, kind: null, promptOverride: null });
    mockIngestEventLine.mockReturnValueOnce({ ok: true, id: 7 });

    const event = JSON.stringify({
      hook: "UserPromptSubmit",
      ts: "2026-05-12T00:00:00Z",
      ctx: {
        session_id: "s1",
        prompt: "<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n<result>done</result>\n</task-notification>",
      },
    });

    const res = await doIngestRequest(srv.socketPath, srv.hookToken, event);

    expect(res.status).toBe(200);
    const [line] = mockIngestEventLine.mock.calls[0];
    expect(JSON.parse(line).ctx.kind).toBe("task-notification");
  });

  it("does NOT tag an ordinary author-less prompt as a task-notification", async () => {
    mockPopPendingAuthor.mockReturnValueOnce({ author: null, thumbnails: null, kind: null, promptOverride: null });
    mockIngestEventLine.mockReturnValueOnce({ ok: true, id: 8 });

    const event = JSON.stringify({
      hook: "UserPromptSubmit",
      ts: "2026-05-12T00:00:00Z",
      ctx: { session_id: "s1", prompt: "hi there" },
    });

    const res = await doIngestRequest(srv.socketPath, srv.hookToken, event);

    expect(res.status).toBe(200);
    const [line] = mockIngestEventLine.mock.calls[0];
    expect(JSON.parse(line).ctx.kind).toBeUndefined();
  });
});
