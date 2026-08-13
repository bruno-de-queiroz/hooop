/**
 * server.test.ts — integration tests for the HTTP router in server.ts.
 *
 * Tests focus on the POST /skill/:name/run handler (the protocol-mismatch fix)
 * and verify that existing auth/rate-limit invariants still hold.
 *
 * Strategy: vi.mock() all heavy transitive deps before importing server.ts,
 * then start a real http.Server on a temp Unix socket and make requests with
 * node's built-in http.request. No external process is spawned.
 */

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest, type IncomingMessage } from "node:http";
// Mocked (see vi.mock below) — imported here so the bash test can inspect calls.
import { ingestEventLine } from "./lib/ingestor";
import { markSessionActive, startNewConversation, destroySession, setSessionBurnAfterUse, endSession, getActiveSession } from "./lib/active-sessions";

// ---- mock heavy deps before any import of server.ts ----

// Skill runs are regular sessions now: the route calls startSkillSession, which
// spawns a controllable slot and queues the `/<skill> <args>` first turn.
const mockStartSkillSession =
  vi.fn<(skill: string, args?: string, author?: string | null) => Promise<{ sessionId: string }>>();

vi.mock("./lib/ingestor", () => ({
  ingestEventLine: vi.fn(() => ({ ok: true, id: 1 })),
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
  startNewConversation: vi.fn(async () => ({ sessionId: "new-sess", meta: {} })),
  startSkillSession: (...a: Parameters<typeof mockStartSkillSession>) => mockStartSkillSession(...a),
  isValidSkillName: (name: string) => /^[A-Za-z0-9][A-Za-z0-9_:/-]{0,127}$/.test(name),
  writeUserTurn: vi.fn(),
  isControllable: vi.fn(() => false),
  endSession: vi.fn(),
  // The plain (non-burn) /end path alias-expands before it ends, so a share or
  // preview minted under a prior id is still reachable. Identity is enough here
  // — the alias semantics themselves are active-sessions.ts's own tests.
  expandSessionIds: vi.fn((id: string) => [id]),
  renameSession: vi.fn(),
  // Bash/chat side-channels: a live session in a real, writable cwd so `spawn`
  // works, plus the wake + active-marking hooks (asserted by the bash test).
  getActiveSession: vi.fn((id: string) => ({ sessionId: id, cwd: "/tmp", status: "alive" })),
  markSessionActive: vi.fn(),
  wakeSession: vi.fn(async () => ({})),
  popPendingAuthor: vi.fn(() => ({ author: null, thumbnails: null, kind: null })),
  markTurnFinished: vi.fn(),
  activeSessionsBus: new EventEmitter(),
  bootActiveSessions: vi.fn(),
  startIdleSweeper: vi.fn(),
  shutdownActiveSessions: vi.fn(),
  // Full teardown + burn-flag toggle (see server.ts's DELETE/burn-after-use
  // routes, which now just call through to these).
  destroySession: vi.fn(async () => ({ deleted: true, workspaceRemoved: true, sharesRevoked: 0, previewsStopped: 0 })),
  setSessionBurnAfterUse: vi.fn((sessionId: string, burn: boolean) => ({ sessionId, burnAfterUse: burn })),
}));

// checkParticipant's peer path re-validates a share through lib/shares — real
// enough logic (capabilityAllows) that it's worth keeping rather than
// stubbing to a constant, so the burn-after-use capability tests below
// exercise the actual gate. Records are seeded per-test via mockShareRecords.
const mockShareRecords = new Map<string, { sessionId: string; capability: "full" | "drive" | "spectate"; peerName: string | null }>();

vi.mock("./lib/shares", () => ({
  bootShares: vi.fn(),
  createShare: vi.fn(),
  revokeShare: vi.fn(),
  revokeAllShares: vi.fn(),
  setSharePeerName: vi.fn(),
  markShareJoined: vi.fn(),
  listShares: vi.fn(() => []),
  getShare: vi.fn((shareId: string) => mockShareRecords.get(shareId)),
  validateShareById: (shareId: string) => {
    const record = mockShareRecords.get(shareId);
    if (!record) return { ok: false, reason: "revoked or expired" };
    return { ok: true, record };
  },
  capabilityAllows: (capability: "full" | "drive" | "spectate", action: string) => {
    if (action === "notify") return true;
    if (capability === "full") return true;
    if (capability === "drive") return action === "turn";
    return false;
  },
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
  resolveDisplayModel: (configured: string | null, resolved: string | null) => configured ?? resolved ?? null,
}));
vi.mock("./lib/events-query", () => ({ listEvents: () => [], getEvent: () => undefined }));
// `canonicalize` is needed by lib/landlock-policy (it resolves every allow-list
// entry before handing it to the wrapper); the bash fast-lane fails closed if
// it's missing, so this mock has to cover it too.
vi.mock("./lib/cwd-policy", () => ({
  isAllowedCwd: () => ({ ok: true }),
  canonicalize: (p: string) => p,
}));
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
  token: string;
  close(): Promise<void>;
}

async function startTestServer(): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-server-test-"));
  const socketPath = join(dir, "sandbox.sock");
  const tokenFile = join(dir, "sandbox.token");
  const token = "test-token-".padEnd(64, "x");
  writeFileSync(tokenFile, token);

  // Point auth module at our temp token file.
  process.env.HOOOP_SANDBOX_TOKEN_FILE = tokenFile;

  // Re-import server after mocks are installed so the route table is fresh.
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

interface Response {
  status: number;
  contentType: string | undefined;
  body: string;
}

function doRequest(
  socketPath: string,
  method: string,
  path: string,
  token: string,
  body?: string,
  // Guarded routes now require an explicit participant — an absent header is
  // 403, not "host" (see checkParticipant). The dashboard proxy always sets
  // this, so "host" is the realistic default for these tests.
  participant: string | null = "host",
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      "x-sandbox-token": token,
    };
    if (participant) headers["x-hooop-participant"] = participant;
    if (body != null) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(body));
    }
    const req = httpRequest(
      { socketPath, method, path, headers },
      (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const ct = res.headers["content-type"];
          resolve({
            status: res.statusCode ?? 0,
            contentType: Array.isArray(ct) ? ct[0] : ct,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    if (body != null) req.write(body);
    req.end();
  });
}

// ---- tests ----

let srv: TestServer;

const originalAsAgent = process.env.HOOOP_AS_AGENT;

beforeEach(async () => {
  vi.resetModules();
  // The bash-streaming tests below run REAL commands and assert their exit
  // codes. lib/as-agent.ts routes a spawn through the setuid hooop-as-agent
  // helper whenever HOOOP_AS_AGENT is set, and that helper fail-closes with exit
  // 125 here — so `exit 3` came back as 125 and the suite passed or failed
  // purely on whether the machine had the var set (green on a laptop, red inside
  // a hooop sandbox). Unset it so these tests always exercise the plain spawn
  // they were written for; as-agent.test.ts owns the helper path and sets the
  // var explicitly.
  delete process.env.HOOOP_AS_AGENT;
  mockStartSkillSession.mockReset();
  mockStartSkillSession.mockResolvedValue({ sessionId: "sess-default" });
  (startNewConversation as unknown as ReturnType<typeof vi.fn>).mockClear();
  (destroySession as unknown as ReturnType<typeof vi.fn>).mockClear();
  (setSessionBurnAfterUse as unknown as ReturnType<typeof vi.fn>).mockClear();
  (endSession as unknown as ReturnType<typeof vi.fn>).mockClear();
  mockShareRecords.clear();
  srv = await startTestServer();
});

afterEach(async () => {
  await srv.close();
  delete process.env.HOOOP_SANDBOX_TOKEN_FILE;
  if (originalAsAgent === undefined) delete process.env.HOOOP_AS_AGENT;
  else process.env.HOOOP_AS_AGENT = originalAsAgent;
});

describe("POST /skill/:name/run — JSON response contract", () => {
  it("returns 200 application/json { sessionId } when the skill session starts", async () => {
    mockStartSkillSession.mockResolvedValueOnce({ sessionId: "sess-abc-123" });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/triage-issue/run",
      srv.token,
      JSON.stringify({ args: "check ticket JIRA-42" }),
    );

    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);
    const parsed = JSON.parse(res.body);
    expect(parsed).toEqual({ sessionId: "sess-abc-123" });
    expect(parsed.sessionId).toBeTypeOf("string");
    expect(parsed.sessionId.length).toBeGreaterThan(0);
  });

  it("does NOT send text/event-stream (old broken behaviour)", async () => {
    mockStartSkillSession.mockResolvedValueOnce({ sessionId: "s1" });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/my-skill/run",
      srv.token,
      JSON.stringify({ args: "" }),
    );

    expect(res.contentType).not.toMatch(/text\/event-stream/);
  });

  it("passes skill name, args and host author to startSkillSession", async () => {
    mockStartSkillSession.mockResolvedValueOnce({ sessionId: "s2" });

    await doRequest(
      srv.socketPath,
      "POST",
      "/skill/my-day/run",
      srv.token,
      JSON.stringify({ args: "some args here" }),
    );

    expect(mockStartSkillSession).toHaveBeenCalledWith("my-day", "some args here", "host");
  });

  it("returns 404 application/json when skill is unknown", async () => {
    mockStartSkillSession.mockRejectedValueOnce(
      new Error("unknown skill or command: no-such-skill"),
    );

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/no-such-skill/run",
      srv.token,
      JSON.stringify({ args: "" }),
    );

    expect(res.status).toBe(404);
    expect(res.contentType).toMatch(/application\/json/);
    const parsed = JSON.parse(res.body);
    expect(typeof parsed.error).toBe("string");
    expect(parsed.error).toMatch(/unknown skill or command/);
  });

  it("returns 400 for an invalid skill name (contains space)", async () => {
    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/not%20valid/run",
      srv.token,
      JSON.stringify({ args: "" }),
    );

    expect(res.status).toBe(400);
    expect(res.contentType).toMatch(/application\/json/);
  });

  it("returns 400 when body is not application/json", async () => {
    const req = httpRequest(
      {
        socketPath: srv.socketPath,
        method: "POST",
        path: "/skill/my-skill/run",
        headers: {
          "x-sandbox-token": srv.token,
          "content-type": "text/plain",
          "content-length": "4",
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          expect(res.statusCode).toBe(415);
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          expect(typeof body.error).toBe("string");
        });
      }
    );
    req.write("hi{}");
    await new Promise<void>((resolve, reject) => {
      req.on("error", reject);
      req.end(resolve);
    });
  });

  it("returns 401 when sandbox token is missing", async () => {
    mockStartSkillSession.mockResolvedValueOnce({ sessionId: "s3" });

    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/skill/my-skill/run",
      "wrong-token-" + "x".repeat(52),
      JSON.stringify({ args: "" }),
    );

    expect(res.status).toBe(401);
    expect(res.contentType).toMatch(/application\/json/);
  });

  it("returns 413 (or connection reset) when body exceeds size limit (>16KB)", async () => {
    // Body limit is MAX_BYTES_ARGS = 16 * 1024. The server calls req.destroy()
    // after the limit is exceeded, which may close the connection before the
    // 413 response is fully written — clients see either a 413 or ECONNRESET.
    const hugeArgs = "x".repeat(20 * 1024);
    const body = JSON.stringify({ args: hugeArgs });
    let status: number | undefined;
    try {
      const res = await doRequest(
        srv.socketPath,
        "POST",
        "/skill/my-skill/run",
        srv.token,
        body,
      );
      status = res.status;
    } catch (e: any) {
      // ECONNRESET is acceptable: the server aborted the over-size request.
      if (e?.code !== "ECONNRESET" && e?.message !== "socket hang up") throw e;
      status = 413; // treat connection reset as effective 413
    }
    expect(status).toBe(413);
  });
});

// The `!bash` fast lane streams: the sandbox emits a "running" BashShortcut
// snapshot and RESPONDS IMMEDIATELY, then emits throttled progress snapshots and
// a final "done" snapshot as the command runs. This is what keeps a long-running
// command from blocking (and timing out) the request, and what lets the
// transcript render a live card. Every snapshot shares one run_id.
describe("POST /sessions/:id/bash — streaming snapshots", () => {
  const snapshots = () =>
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((e) => e.hook === "BashShortcut")
      .map((e) => e.ctx.tool_response);

  // The command runs in the BACKGROUND (that's the feature), so a test must wait
  // for the terminal snapshot before asserting — and before afterEach tears the
  // server down (closeAllConnections would kill the in-flight child).
  const waitForDone = async (timeoutMs = 5_000): Promise<any> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const done = snapshots().find((s) => s.status === "done");
      if (done) return done;
      if (Date.now() > deadline) throw new Error("timed out waiting for the 'done' snapshot");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("responds immediately with a runId and a 'running' snapshot, before the command finishes", async () => {
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    const startedAt = Date.now();
    const res = await doRequest(
      srv.socketPath,
      "POST",
      "/sessions/sid-bash-1/bash",
      srv.token,
      JSON.stringify({ command: "sleep 0.6; echo late-output" }),
    );
    const elapsed = Date.now() - startedAt;

    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(typeof body.runId).toBe("string");
    // The whole point: the response does NOT wait for the command.
    expect(elapsed).toBeLessThan(500);

    const first = snapshots();
    expect(first).toHaveLength(1);
    expect(first[0].status).toBe("running");
    expect(first[0].run_id).toBe(body.runId);
    expect(first[0].exit_code).toBeNull();

    // ...and the final "done" snapshot lands later, with the output + exit code,
    // sharing the same run_id so the UI updates one card in place.
    const done = await waitForDone();
    expect(done.run_id).toBe(body.runId);
    expect(done.exit_code).toBe(0);
    expect(done.stdout).toContain("late-output");
    expect(snapshots().every((s) => s.run_id === body.runId)).toBe(true);
  });

  it("marks the session active (and wakes it) for a side-channel bash", async () => {
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    (markSessionActive as unknown as ReturnType<typeof vi.fn>).mockClear();
    await doRequest(
      srv.socketPath,
      "POST",
      "/sessions/sid-bash-2/bash",
      srv.token,
      JSON.stringify({ command: "echo quick" }),
    );
    expect((markSessionActive as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    expect((markSessionActive as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("sid-bash-2");
    await waitForDone(); // let the child finish before teardown
  });

  it("reports a non-zero exit code on the done snapshot", async () => {
    (ingestEventLine as unknown as ReturnType<typeof vi.fn>).mockClear();
    await doRequest(
      srv.socketPath,
      "POST",
      "/sessions/sid-bash-3/bash",
      srv.token,
      JSON.stringify({ command: "exit 3" }),
    );
    const done = await waitForDone();
    expect(done.exit_code).toBe(3);
  });
});

// idleTtlMs is this session's own idle-dormancy window: bounded 0..24h so a
// single conversation can't hold one of the install's three controllable
// slots forever (see server.ts's comment above the check). burnAfterUse is a
// plain boolean flag. Both are validated before startNewConversation is ever
// called.
describe("POST /sessions — idleTtlMs / burnAfterUse validation", () => {
  it("accepts idleTtlMs: 0 (never go dormant) and passes it through", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ idleTtlMs: 0 }));
    expect(res.status).toBe(200);
    expect((startNewConversation as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ idleTtlMs: 0 });
  });

  it("accepts a valid positive idleTtlMs and passes it through", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ idleTtlMs: 60_000 }));
    expect(res.status).toBe(200);
    expect((startNewConversation as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ idleTtlMs: 60_000 });
  });

  it("rejects a negative idleTtlMs", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ idleTtlMs: -1 }));
    expect(res.status).toBe(400);
    expect(startNewConversation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects a non-integer idleTtlMs", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ idleTtlMs: 1.5 }));
    expect(res.status).toBe(400);
    expect(startNewConversation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects an idleTtlMs over the 24h cap", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ idleTtlMs: 86_400_001 }));
    expect(res.status).toBe(400);
    expect(startNewConversation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects a string idleTtlMs", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ idleTtlMs: "60000" }));
    expect(res.status).toBe(400);
    expect(startNewConversation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean burnAfterUse", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ burnAfterUse: "yes" }));
    expect(res.status).toBe(400);
    expect(startNewConversation as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("accepts a boolean burnAfterUse and passes it through", async () => {
    const res = await doRequest(srv.socketPath, "POST", "/sessions", srv.token, JSON.stringify({ burnAfterUse: true }));
    expect(res.status).toBe(200);
    expect((startNewConversation as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toMatchObject({ burnAfterUse: true });
  });
});

// The burn-after-use route is CANCEL-ONLY, and keeps auto-mode's capability gate
// for that: host or full-access peer, drive/spectate rejected. Arming is not
// reachable here — see the `burn: true` test for why that matters.
describe("POST /sessions/:id/burn-after-use", () => {
  it("rejects a non-boolean body", async () => {
    const res = await doRequest(
      srv.socketPath, "POST", "/sessions/sid-burn-1/burn-after-use", srv.token,
      JSON.stringify({ burn: "yes" }),
    );
    expect(res.status).toBe(400);
    expect(setSessionBurnAfterUse as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("lets the host cancel it and returns { ok, sessionId, burnAfterUse }", async () => {
    const res = await doRequest(
      srv.socketPath, "POST", "/sessions/sid-burn-2/burn-after-use", srv.token,
      JSON.stringify({ burn: false }),
    );
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, sessionId: "sid-burn-2", burnAfterUse: false });
  });

  it("refuses to ARM burn-after-use, even for the host", async () => {
    // Privilege hole this closes: the capability gate below admits a full-access
    // PEER (inherited from auto-mode, a reversible toggle). If `burn: true` were
    // accepted, a co-driver invited to pair on code could schedule the deletion
    // of the host's transcript, workspace, events and shares on the next idle
    // timeout — destroying the record of who armed it along with it. Arming
    // stays where it is auditable and host-only: session creation.
    const res = await doRequest(
      srv.socketPath, "POST", "/sessions/sid-burn-5/burn-after-use", srv.token,
      JSON.stringify({ burn: true }),
    );
    expect(res.status).toBe(400);
    expect(setSessionBurnAfterUse as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rejects a drive-capability peer", async () => {
    mockShareRecords.set("share-drive-1", { sessionId: "sid-burn-3", capability: "drive", peerName: "Ada" });
    const res = await doRequest(
      srv.socketPath, "POST", "/sessions/sid-burn-3/burn-after-use", srv.token,
      JSON.stringify({ burn: false }), "peer:share-drive-1",
    );
    expect(res.status).toBe(403);
    expect(setSessionBurnAfterUse as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  // NB this one passes on the STRENGTH OF checkParticipant, not the route's own
  // capability line: spectate never satisfies the "turn" requirement, so it is
  // rejected before the `capabilityAllows(..., "permission")` check is reached.
  // Kept as end-to-end documentation of who gets in; the drive-capability test
  // above is the real pin on the route's extra gate (verified by mutation: only
  // that one fails when the gate is deleted).
  it("rejects a spectate-capability peer", async () => {
    mockShareRecords.set("share-spectate-1", { sessionId: "sid-burn-4", capability: "spectate", peerName: "Bo" });
    const res = await doRequest(
      srv.socketPath, "POST", "/sessions/sid-burn-4/burn-after-use", srv.token,
      JSON.stringify({ burn: false }), "peer:share-spectate-1",
    );
    expect(res.status).toBe(403);
    expect(setSessionBurnAfterUse as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

describe("POST /sessions/:id/end (burn-after-use)", () => {
  it("hands a burn session's whole teardown to destroySession instead of ending it first", async () => {
    // Ordering regression: an earlier version ended the session and THEN
    // destroyed it. endSession clears the slot's alias entries, and `claude
    // --resume` re-keys a session mid-life, so destroying afterwards could no
    // longer see a share or preview minted under a prior id — leaving an
    // aliased share unrevoked and an aliased preview still running. The burn
    // path must therefore go straight to destroySession, which expands the
    // aliases itself before the teardown that clears them (and runs endSession
    // internally via deleteSession, so nothing is skipped).
    (getActiveSession as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (id: string) => ({ sessionId: id, cwd: "/tmp", status: "alive", burnAfterUse: true }),
    );
    const res = await doRequest(srv.socketPath, "POST", "/sessions/sid-burn-end/end", srv.token);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect((destroySession as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("sid-burn-end");
    // Not called directly by the route — destroySession owns that step now.
    expect(endSession as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("leaves an ordinary session on the plain end path", async () => {
    // Default getActiveSession mock reports no burnAfterUse.
    const res = await doRequest(srv.socketPath, "POST", "/sessions/sid-end-plain/end", srv.token);
    expect(res.status).toBe(200);
    expect(endSession as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith("sid-end-plain");
    expect(destroySession as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });
});

// The teardown itself (expandSessionIds -> deleteSession -> revoke shares ->
// reap previews) moved into active-sessions.ts's destroySession so the idle
// sweeper and this route can't drift apart; the response shape must stay
// identical to before that move.
describe("DELETE /sessions/:id", () => {
  it("returns { ok, deleted, workspaceRemoved, sharesRevoked, previewsStopped } from destroySession", async () => {
    const res = await doRequest(srv.socketPath, "DELETE", "/sessions/sid-del-1", srv.token);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      ok: true, deleted: true, workspaceRemoved: true, sharesRevoked: 0, previewsStopped: 0,
    });
    expect((destroySession as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("sid-del-1");
  });
});
