import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("./db", () => ({
  getDb: () => mockDb,
}));
vi.mock("./sessions", () => ({
  listSessions: () => mockSessions,
}));

let mockDb: any;
let mockSessions: any[];

beforeEach(() => {
  mockSessions = [];
  mockDb = {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
    })),
  };
});

import { listAgentRuns } from "./agents";

// ── row builders ──────────────────────────────────────────────────────────
// Correlation is by ctx.tool_use_id (Pre↔Post) and ctx.agent_id (child→parent),
// exactly as Claude Code stamps them — so the fixtures carry those ids
// explicitly rather than relying on event ordering.

function preRow(opts: {
  id: number;
  tuid?: string;
  ts?: string;
  session?: string | null;
  toolInput?: Record<string, unknown>;
  agentId?: string; // ctx.agent_id — the sub-agent that ISSUED this launch (nesting)
  rawPayload?: string; // escape hatch for malformed-payload tests
}) {
  const ctx: Record<string, unknown> = { tool_input: opts.toolInput ?? {} };
  if (opts.tuid !== undefined) ctx.tool_use_id = opts.tuid;
  if (opts.agentId !== undefined) ctx.agent_id = opts.agentId;
  return {
    id: opts.id,
    ts: opts.ts ?? "2026-05-12T10:00:00Z",
    session_id: opts.session === undefined ? "session-1" : opts.session,
    hook_type: "PreToolUse",
    payload: opts.rawPayload ?? JSON.stringify({ ctx }),
  };
}

function postRow(opts: {
  id: number;
  tuid?: string;
  ts?: string;
  session?: string | null;
  response?: unknown; // ctx.tool_response
  result?: unknown; // ctx.tool_result
  rawPayload?: string;
}) {
  const ctx: Record<string, unknown> = {};
  if (opts.tuid !== undefined) ctx.tool_use_id = opts.tuid;
  if (opts.response !== undefined) ctx.tool_response = opts.response;
  if (opts.result !== undefined) ctx.tool_result = opts.result;
  return {
    id: opts.id,
    ts: opts.ts ?? "2026-05-12T10:00:05Z",
    session_id: opts.session === undefined ? "session-1" : opts.session,
    hook_type: "PostToolUse",
    payload: opts.rawPayload ?? JSON.stringify({ ctx }),
  };
}

function notifRow(opts: { id: number; ts?: string; session?: string; prompt: string }) {
  const session = opts.session ?? "session-1";
  return {
    id: opts.id,
    ts: opts.ts ?? "2026-05-12T10:02:20Z",
    session_id: session,
    hook_type: "UserPromptSubmit",
    payload: JSON.stringify({ ctx: { session_id: session, prompt: opts.prompt } }),
  };
}

/** Build a `<task-notification>` body. */
function taskNotification(o: {
  toolUseId?: string;
  taskId?: string;
  status?: string;
  result?: string;
  toolUses?: number;
  durationMs?: number;
}): string {
  const parts = ["<task-notification>"];
  if (o.taskId) parts.push(`<task-id>${o.taskId}</task-id>`);
  if (o.toolUseId) parts.push(`<tool-use-id>${o.toolUseId}</tool-use-id>`);
  if (o.status) parts.push(`<status>${o.status}</status>`);
  if (o.result != null) parts.push(`<result>${o.result}</result>`);
  if (o.toolUses != null || o.durationMs != null) {
    parts.push(
      `<usage>${o.toolUses != null ? `<tool_uses>${o.toolUses}</tool_uses>` : ""}${
        o.durationMs != null ? `<duration_ms>${o.durationMs}</duration_ms>` : ""
      }</usage>`,
    );
  }
  parts.push("</task-notification>");
  return parts.join("\n");
}

function setRows(rows: unknown[]) {
  mockDb.prepare.mockReturnValue({ all: vi.fn(() => rows) });
}

describe("listAgentRuns", () => {
  it("returns empty array when no events", () => {
    setRows([]);
    expect(listAgentRuns()).toEqual([]);
  });

  it("creates completed run from Pre + Post pair", () => {
    const preTs = "2026-05-12T10:00:00Z";
    const postTs = "2026-05-12T10:00:05Z";
    setRows([
      preRow({ id: 1, tuid: "t1", ts: preTs, toolInput: { subagent_type: "claude-code", prompt: "do something" } }),
      postRow({
        id: 2,
        tuid: "t1",
        ts: postTs,
        response: { content: [{ type: "text", text: "done" }], usage: { model: "claude-opus-4-1" } },
      }),
    ]);

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      id: 1,
      sessionId: "session-1",
      subagentType: "claude-code",
      prompt: "do something",
      startTs: preTs,
      endTs: postTs,
      status: "completed",
      result: "done",
      model: "claude-opus-4-1",
    });
    expect(runs[0].durationMs).toBe(5000);
  });

  it("marks Pre without Post as running when session is alive", () => {
    setRows([preRow({ id: 1, tuid: "t1", toolInput: { subagent_type: "agent" } })]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 1, status: "running", endTs: null, durationMs: null });
  });

  it("marks Pre as interrupted when session is not alive and > 5min old", () => {
    const oldTs = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    setRows([preRow({ id: 1, tuid: "t1", ts: oldTs, toolInput: { subagent_type: "agent" } })]);
    mockSessions = []; // session not alive

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe("interrupted");
    expect(runs[0].durationMs).toBeGreaterThan(6 * 60 * 1000 - 100);
  });

  it("keeps Pre as running when session not alive but < 5min old (grace period)", () => {
    const recentTs = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    setRows([preRow({ id: 1, tuid: "t1", ts: recentTs, toolInput: { subagent_type: "agent" } })]);
    mockSessions = []; // not alive

    const runs = listAgentRuns();
    expect(runs[0].status).toBe("running");
    expect(runs[0].durationMs).toBeNull();
  });

  it("links a nested agent to its parent via ctx.agent_id (not open/close order)", () => {
    // Parent launched by the main agent (no agent_id). Its async ack exposes
    // agentId "AGENT_PARENT". The child launch is issued from inside the parent
    // sub-agent, so its PreToolUse carries agent_id = "AGENT_PARENT".
    setRows([
      preRow({ id: 1, tuid: "tp", toolInput: { subagent_type: "parent" } }),
      postRow({ id: 2, tuid: "tp", response: { isAsync: true, status: "async_launched", agentId: "AGENT_PARENT" } }),
      preRow({ id: 3, tuid: "tc", toolInput: { subagent_type: "child" }, agentId: "AGENT_PARENT" }),
      postRow({ id: 4, tuid: "tc", response: { status: "completed", agentId: "AGENT_CHILD", content: "ok" } }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns();
    expect(runs.find((r) => r.id === 1)).toMatchObject({ parentAgentId: null });
    expect(runs.find((r) => r.id === 3)).toMatchObject({ parentAgentId: 1 });
  });

  it("extracts text from content array with {type:text, text:...}", () => {
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: {} }),
      postRow({
        id: 2,
        tuid: "t1",
        response: {
          content: [
            { type: "text", text: "hello" },
            { type: "text", text: "world" },
          ],
        },
      }),
    ]);
    expect(listAgentRuns()[0].result).toBe("hello\nworld");
  });

  it("extracts model from tool_response.usage.model", () => {
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: {} }),
      postRow({ id: 2, tuid: "t1", response: { content: "ok", usage: { model: "claude-haiku-4-5" } } }),
    ]);
    expect(listAgentRuns()[0].model).toBe("claude-haiku-4-5");
  });

  it("extracts toolUseCount from tool_response.usage.tool_use_count", () => {
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: {} }),
      postRow({ id: 2, tuid: "t1", response: { content: "result", usage: { tool_use_count: 3 } } }),
    ]);
    expect(listAgentRuns()[0].toolUseCount).toBe(3);
  });

  it("extracts model/toolUseCount/duration from the sync-completion shape (resolvedModel, totalToolUseCount, totalDurationMs)", () => {
    // The nested/sync PostToolUse shape uses different field names than the
    // usage.* variants above — verified live against claude-code v2.1.220.
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: { subagent_type: "general-purpose" } }),
      postRow({
        id: 2,
        tuid: "t1",
        response: {
          status: "completed",
          agentId: "AGENT_X",
          content: [{ type: "text", text: "INNER" }],
          resolvedModel: "claude-sonnet-5",
          totalToolUseCount: 4,
          totalDurationMs: 1544,
        },
      }),
    ]);
    expect(listAgentRuns()[0]).toMatchObject({
      status: "completed",
      result: "INNER",
      model: "claude-sonnet-5",
      toolUseCount: 4,
      durationMs: 1544,
    });
  });

  it("respects limit parameter (50 by default, last 50 by id desc)", () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      preRow({ id: i + 1, tuid: `t${i + 1}`, ts: `2026-05-12T10:${String(i).padStart(2, "0")}:00Z`, toolInput: {} }),
    );
    setRows(rows);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns(5);
    expect(runs).toHaveLength(5);
    // Sorted by id descending
    expect(runs[0].id).toBe(10);
    expect(runs[4].id).toBe(6);
  });

  it("handles malformed JSON in payload gracefully (creates the run, can't correlate)", () => {
    setRows([
      preRow({ id: 1, rawPayload: "not json" }),
      postRow({ id: 2, rawPayload: "bad json" }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    // A malformed Pre still yields a run (id only); a malformed Post can't
    // correlate (no tool_use_id) so it's ignored — the run stays running rather
    // than being paired to the wrong thing. The point is: no crash, no bogus pair.
    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ id: 1, subagentType: null, prompt: null, result: null, status: "running" });
  });

  it("handles null session_id (ambient cli session)", () => {
    setRows([preRow({ id: 1, tuid: "t1", session: null, toolInput: { subagent_type: "agent" } })]);
    mockSessions = [];
    expect(listAgentRuns()[0].sessionId).toBeNull();
  });

  it("keeps an async-launched agent running (not completed) until its task-notification lands", () => {
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: { subagent_type: "Explore", description: "Map the codebase" } }),
      postRow({
        id: 2,
        tuid: "t1",
        ts: "2026-05-12T10:00:01Z",
        response: { isAsync: true, status: "async_launched", agentId: "agent-xyz", resolvedModel: "claude-opus-4-8" },
      }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns();
    expect(runs).toHaveLength(1);
    // Not "completed" and no bogus result from the launch acknowledgment — the
    // sub-agent's own work hasn't happened yet. Model hint from the ack survives.
    expect(runs[0]).toMatchObject({ status: "running", endTs: null, result: null, model: "claude-opus-4-8" });
  });

  it("resolves an async run via its task-notification, matched by tool-use-id (primary key)", () => {
    const notifyTs = "2026-05-12T10:02:20Z";
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: { subagent_type: "Explore" } }),
      postRow({
        id: 2,
        tuid: "t1",
        ts: "2026-05-12T10:00:01Z",
        // agentId here deliberately DIFFERS from the notification's task-id to
        // prove tool-use-id (not agentId) is the primary match.
        response: { isAsync: true, status: "async_launched", agentId: "some-other-id" },
      }),
      notifRow({
        id: 3,
        ts: notifyTs,
        prompt: taskNotification({
          toolUseId: "t1",
          taskId: "unrelated-task-id",
          status: "completed",
          result: "the real findings",
          toolUses: 7,
          durationMs: 139000,
        }),
      }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    expect(listAgentRuns()[0]).toMatchObject({
      status: "completed",
      endTs: notifyTs,
      result: "the real findings",
      toolUseCount: 7,
      durationMs: 139000,
    });
  });

  it("resolves an async run via task-notification by agentId when no tool-use-id is present (fallback)", () => {
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: { subagent_type: "Explore" } }),
      postRow({
        id: 2,
        tuid: "t1",
        ts: "2026-05-12T10:00:01Z",
        response: { isAsync: true, status: "async_launched", agentId: "agent-xyz" },
      }),
      notifRow({ id: 3, prompt: taskNotification({ taskId: "agent-xyz", status: "completed", result: "found it" }) }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    expect(listAgentRuns()[0]).toMatchObject({ status: "completed", result: "found it" });
  });

  it("does NOT resolve the run on a non-completed task-notification (still-running background children)", () => {
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: {} }),
      postRow({
        id: 2,
        tuid: "t1",
        ts: "2026-05-12T10:00:01Z",
        response: { isAsync: true, status: "async_launched", agentId: "agent-xyz" },
      }),
      notifRow({ id: 3, prompt: taskNotification({ toolUseId: "t1", taskId: "agent-xyz", status: "running" }) }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    expect(listAgentRuns()[0]).toMatchObject({ status: "running", endTs: null, result: null });
  });

  it("uses tool_result as fallback when tool_response missing", () => {
    setRows([
      preRow({ id: 1, tuid: "t1", toolInput: {} }),
      postRow({ id: 2, tuid: "t1", result: { text: "fallback result" } }),
    ]);
    expect(listAgentRuns()[0].result).toBe("fallback result");
  });

  // ── regression: the parallel/async correlation bug ────────────────────────

  it("pairs parallel launches to the RIGHT run even when Posts arrive out of open order", () => {
    // Two agents launched in one turn; their completions arrive in REVERSE
    // order (B before A). A LIFO stack would swap their results — id-keyed
    // pairing must not.
    setRows([
      preRow({ id: 1, tuid: "tA", ts: "2026-05-12T10:00:00Z", toolInput: { subagent_type: "A" } }),
      preRow({ id: 2, tuid: "tB", ts: "2026-05-12T10:00:01Z", toolInput: { subagent_type: "B" } }),
      postRow({ id: 3, tuid: "tB", ts: "2026-05-12T10:00:02Z", response: { status: "completed", content: "B-result" } }),
      postRow({ id: 4, tuid: "tA", ts: "2026-05-12T10:00:03Z", response: { status: "completed", content: "A-result" } }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns();
    expect(runs.find((r) => r.id === 1)).toMatchObject({ subagentType: "A", result: "A-result", status: "completed" });
    expect(runs.find((r) => r.id === 2)).toMatchObject({ subagentType: "B", result: "B-result", status: "completed" });
  });

  it("an open async launch does NOT corrupt the parent of a later unrelated launch (cascade regression)", () => {
    // Agent A launches async and never resolves (ack only, no notification). A
    // later, unrelated top-level agent C must still have parentAgentId null —
    // the old stack left A's frame open and mis-parented everything after it.
    const recent = () => new Date(Date.now() - 30_000).toISOString();
    setRows([
      preRow({ id: 1, tuid: "tA", ts: recent(), toolInput: { subagent_type: "A" } }),
      postRow({ id: 2, tuid: "tA", ts: recent(), response: { isAsync: true, status: "async_launched", agentId: "AGENT_A" } }),
      preRow({ id: 3, tuid: "tC", ts: recent(), toolInput: { subagent_type: "C" } }),
      postRow({ id: 4, tuid: "tC", ts: recent(), response: { status: "completed", content: "C done" } }),
    ]);
    mockSessions = [{ sessionId: "session-1", lifecycle: "alive" }];

    const runs = listAgentRuns();
    expect(runs.find((r) => r.id === 1)).toMatchObject({ status: "running" });
    expect(runs.find((r) => r.id === 3)).toMatchObject({
      status: "completed",
      result: "C done",
      parentAgentId: null, // NOT 1 — this is the bug the fix closes
    });
  });
});
