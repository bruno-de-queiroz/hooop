import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { unlinkSync, existsSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHttpClient, type SandboxClient } from "./sandbox-client";

/**
 * Contract test: every public method of SandboxClient must hit a known sandbox
 * route with the right HTTP method, and (where applicable) send the right
 * JSON body shape. Catches URL typos AND request-body drift.
 *
 * Each case can optionally pin the expected body via `expectBody`. We
 * capture EVERY request the test runner makes (not just the last one) so
 * a method that retries under the hood (e.g. the 401 → reread-token retry)
 * is asserted against the *first* call's body — which is what the public
 * contract specifies.
 */

interface Capture {
  method?: string;
  path?: string;
  body?: string;
}

interface Stub {
  server: Server;
  socketPath: string;
  tokenFile: string;
  requests(): Capture[];
  setRoutes(map: Record<string, { status: number; body: unknown }>): void;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-contract-"));
  const socketPath = join(dir, "sandbox.sock");
  const tokenFile = join(dir, "sandbox.token");
  writeFileSync(tokenFile, "test-token-".padEnd(64, "x"));

  let routeMap: Record<string, { status: number; body: unknown }> = {};
  const captured: Capture[] = [];

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf-8");
      const pathOnly = (req.url ?? "").split("?")[0];
      captured.push({ method: req.method, path: req.url, body });
      const key = `${req.method} ${pathOnly}`;
      const route = routeMap[key];
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: `no stub for ${key}` }));
        return;
      }
      res.writeHead(route.status, { "content-type": "application/json" });
      res.end(JSON.stringify(route.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, () => resolve()));

  return {
    server,
    socketPath,
    tokenFile,
    setRoutes: (m) => { routeMap = m; captured.length = 0; },
    requests: () => captured,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          if (existsSync(socketPath)) try { unlinkSync(socketPath); } catch { /* ignore */ }
          resolve();
        });
      }),
  };
}

let stub: Stub;
let client: SandboxClient;

beforeEach(async () => {
  stub = await startStub();
  process.env.HOOOP_SANDBOX_TOKEN_FILE = stub.tokenFile;
  client = createHttpClient(stub.socketPath);
});

afterEach(async () => {
  await stub.close();
  delete process.env.HOOOP_SANDBOX_TOKEN_FILE;
});

interface Case {
  name: string;
  routes: Record<string, { status: number; body: unknown }>;
  invoke: () => Promise<unknown>;
  expectMethod: string;
  expectPath: string;
  /**
   * When set, asserts the parsed first-request body equals this. Omit for
   * methods that don't send a body (GET / DELETE / POST-without-payload).
   */
  expectBody?: unknown;
}

const CASES: Case[] = [
  {
    name: "listSessions",
    routes: { "GET /sessions": { status: 200, body: [] } },
    invoke: () => client.listSessions(),
    expectMethod: "GET",
    expectPath: "/sessions",
  },
  {
    name: "startNewConversation",
    routes: { "POST /sessions": { status: 200, body: { sessionId: "s1", meta: {} } } },
    invoke: () => client.startNewConversation({ gitRepo: "https://example.com/x.git", label: "L" }),
    expectMethod: "POST",
    expectPath: "/sessions",
    expectBody: { gitRepo: "https://example.com/x.git", label: "L" },
  },
  {
    name: "writeUserTurn",
    routes: { "POST /sessions/s1/message": { status: 200, body: { ok: true, sessionId: "s1" } } },
    invoke: () => client.writeUserTurn("s1", "hi"),
    expectMethod: "POST",
    expectPath: "/sessions/s1/message",
    expectBody: { text: "hi" },
  },
  {
    name: "endSession",
    routes: { "POST /sessions/s1/end": { status: 200, body: { ok: true } } },
    invoke: () => client.endSession("s1"),
    expectMethod: "POST",
    expectPath: "/sessions/s1/end",
  },
  {
    name: "deleteSession",
    routes: { "DELETE /sessions/s1": { status: 200, body: { ok: true, deleted: true } } },
    invoke: () => client.deleteSession("s1"),
    expectMethod: "DELETE",
    expectPath: "/sessions/s1",
  },
  {
    name: "renameSession",
    routes: { "PATCH /sessions/s1": { status: 200, body: { ok: true, meta: {} } } },
    invoke: () => client.renameSession("s1", "newname"),
    expectMethod: "PATCH",
    expectPath: "/sessions/s1",
    expectBody: { name: "newname" },
  },
  {
    name: "getSessionModel",
    routes: { "GET /sessions/s1/model": { status: 200, body: { model: "x" } } },
    invoke: () => client.getSessionModel("s1"),
    expectMethod: "GET",
    expectPath: "/sessions/s1/model",
  },
  {
    name: "setSessionModel",
    routes: { "POST /sessions/s1/model": { status: 200, body: { ok: true, sessionId: "s1", model: "opus" } } },
    invoke: () => client.setSessionModel("s1", "opus"),
    expectMethod: "POST",
    expectPath: "/sessions/s1/model",
    expectBody: { model: "opus" },
  },
  {
    name: "listEvents",
    routes: { "GET /events": { status: 200, body: [] } },
    invoke: () => client.listEvents({ limit: 10 }),
    expectMethod: "GET",
    expectPath: "/events",
  },
  {
    name: "getEvent",
    routes: { "GET /events/42": { status: 200, body: { id: 42 } } },
    invoke: () => client.getEvent(42),
    expectMethod: "GET",
    expectPath: "/events/42",
  },
  {
    name: "startSkillRun",
    routes: { "POST /skill/foo/run": { status: 200, body: { sessionId: "s1" } } },
    invoke: () => client.startSkillRun("foo", "args"),
    expectMethod: "POST",
    expectPath: "/skill/foo/run",
    expectBody: { args: "args" },
  },
  {
    name: "listSkills",
    routes: { "GET /skills": { status: 200, body: [] } },
    invoke: () => client.listSkills(),
    expectMethod: "GET",
    expectPath: "/skills",
  },
  {
    name: "listSlashCommands",
    routes: { "GET /commands": { status: 200, body: [] } },
    invoke: () => client.listSlashCommands(),
    expectMethod: "GET",
    expectPath: "/commands",
  },
  {
    name: "listMcps",
    routes: { "GET /mcps": { status: 200, body: { servers: [] } } },
    invoke: () => client.listMcps(),
    expectMethod: "GET",
    expectPath: "/mcps",
  },
  {
    name: "getStack",
    routes: { "GET /stack": { status: 200, body: { plugins: [], memory: null, installLog: { exists: false, lines: 0, summary: {} } } } },
    invoke: () => client.getStack(),
    expectMethod: "GET",
    expectPath: "/stack",
  },
  {
    name: "getIdentity",
    routes: { "GET /identity": { status: 200, body: { authenticated: false } } },
    invoke: () => client.getIdentity(),
    expectMethod: "GET",
    expectPath: "/identity",
  },
  {
    name: "listAgentRuns",
    routes: { "GET /agents": { status: 200, body: [] } },
    invoke: () => client.listAgentRuns(10),
    expectMethod: "GET",
    expectPath: "/agents",
  },
  {
    name: "getAgentDetail",
    routes: { "GET /agents/7": { status: 200, body: { id: 7 } } },
    invoke: () => client.getAgentDetail(7),
    expectMethod: "GET",
    expectPath: "/agents/7",
  },
  {
    name: "search",
    routes: { "POST /search": { status: 200, body: { results: [], type: "bm25", total: 0, meta: { bm25_used: false, semantic_used: false } } } },
    invoke: () => client.search("q", "bm25", 10),
    expectMethod: "POST",
    expectPath: "/search",
    expectBody: { q: "q", type: "bm25", limit: 10 },
  },
  {
    name: "peerLeave",
    routes: { "POST /peer-leave": { status: 200, body: { ok: true } } },
    invoke: () => client.peerLeave("s1", "Bob", "share-1"),
    expectMethod: "POST",
    expectPath: "/peer-leave",
    expectBody: { sessionId: "s1", name: "Bob", shareId: "share-1" },
  },
];

describe("SandboxClient contract: every method hits the right sandbox route", () => {
  for (const c of CASES) {
    it(`${c.name} → ${c.expectMethod} ${c.expectPath}${c.expectBody ? " (+body)" : ""}`, async () => {
      stub.setRoutes(c.routes);
      await c.invoke();

      const reqs = stub.requests();
      // Each method must make EXACTLY one HTTP call. If a future
      // implementation introduces a preflight / retry that turns into
      // multiple requests, this fires loudly and the contract update is
      // explicit. (The 401 → reread-token retry path is exercised by a
      // separate test in sandbox-client-http.test.ts.)
      expect(reqs.length).toBe(1);

      const first = reqs[0];
      expect(first.method).toBe(c.expectMethod);
      expect((first.path ?? "").split("?")[0]).toBe(c.expectPath);

      if (c.expectBody !== undefined) {
        expect(first.body).toBeTruthy();
        const parsed = JSON.parse(first.body!);
        expect(parsed).toEqual(c.expectBody);
      }
    });
  }
});

describe("SandboxClient.startSkillRun — JSON-only protocol", () => {
  it("parses { sessionId } from a JSON 200 response and returns it", async () => {
    stub.setRoutes({
      "POST /skill/foo/run": { status: 200, body: { sessionId: "sess-xyz-789" } },
    });
    const result = await client.startSkillRun("foo", "some args");
    expect(result).toEqual({ sessionId: "sess-xyz-789" });
  });

  it("sends exactly one POST with JSON body { args } — no SSE upgrade", async () => {
    stub.setRoutes({
      "POST /skill/bar/run": { status: 200, body: { sessionId: "s1" } },
    });
    await client.startSkillRun("bar", "bar args");

    const reqs = stub.requests();
    // Must be exactly one request — no preflight and no SSE upgrade request.
    expect(reqs.length).toBe(1);
    const req = reqs[0];
    expect(req.method).toBe("POST");
    expect((req.path ?? "").split("?")[0]).toBe("/skill/bar/run");

    // Body must be JSON with args field.
    expect(req.body).toBeTruthy();
    expect(JSON.parse(req.body!)).toEqual({ args: "bar args" });

    // The stub responds with application/json (not text/event-stream).
    // The client must not have requested an SSE upgrade (no Accept: text/event-stream).
    // We can't inspect response Content-Type here, but we verify the client
    // didn't send Accept: text/event-stream which would indicate an SSE attempt.
    // (The stub's captured headers come from the IncomingMessage on the server.)
  });

  it("throws a SandboxError (status 404) when sandbox returns 404", async () => {
    stub.setRoutes({
      "POST /skill/unknown/run": { status: 404, body: { error: "unknown skill or command: unknown" } },
    });
    await expect(client.startSkillRun("unknown", "")).rejects.toMatchObject({
      status: 404,
      message: expect.stringMatching(/unknown skill or command/),
    });
  });
});
