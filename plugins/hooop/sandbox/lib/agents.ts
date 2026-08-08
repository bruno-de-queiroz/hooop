import { getDb } from "./db";
import { listSessions } from "./sessions";
import { TASK_NOTIFICATION_KIND } from "@shared/turn-kinds";

export interface AgentRun {
  id: number;            // events.id of the PreToolUse(Agent) event
  sessionId: string | null;
  subagentType: string | null;
  model: string | null;  // best-effort extraction from tool_response
  prompt: string | null;
  description: string | null;  // short description from Task input
  startTs: string;
  endTs: string | null;
  durationMs: number | null;
  toolUseCount: number | null;  // number of tool calls the sub-agent made
  result: string | null;
  parentAgentId: number | null;
  // "running"      — Pre fired, Post hasn't, session is still alive.
  // "completed"    — Post fired normally.
  // "interrupted"  — Pre fired, Post never fired, and the parent session has
  //                  no live process or is dormant/ended. The agent will never
  //                  finish; we surface it so it's not stuck pulsing forever.
  status: "running" | "completed" | "interrupted";
}

const STUCK_GRACE_MS = 5 * 60_000;

/**
 * Reconstructs sub-agent runs by walking the events table in id order.
 *
 * Correlation is by the stable ids Claude Code stamps on every hook, NOT by
 * open/close ordering. An earlier version paired PreToolUse↔PostToolUse with a
 * per-session LIFO stack, which silently corrupted results whenever calls
 * didn't close in reverse-open order — i.e. any parallel launch (several Agent
 * calls in one turn, whose acks return in arbitrary order) and, worse, every
 * async top-level launch (whose PostToolUse is only a launch ack, so the frame
 * never popped and poisoned the parent pointer of every later call). We now
 * key on:
 *   - `ctx.tool_use_id` — identical on a call's PreToolUse and PostToolUse, so
 *     a Post finds its Pre directly regardless of interleaving.
 *   - `tool_response.agentId` — the sub-agent's OWN id, exposed on both async
 *     acks and sync completions. Recorded per run so a child launch (whose
 *     PreToolUse carries `ctx.agent_id` = the parent sub-agent's id) can find
 *     its parent run. This is the real nesting signal, immune to interleaving.
 *   - the task-notification's `<tool-use-id>` (primary) / `<task-id>` agentId
 *     (fallback) — resolves an async run once its background agent finishes.
 *
 * Two PostToolUse shapes, both keyed by tool_use_id (verified against
 * claude-code v2.1.220): a top-level launch returns an async ack
 * (`{isAsync:true, status:"async_launched", agentId, resolvedModel}`) with the
 * real result arriving later as a task-notification; a nested launch (issued
 * from inside a sub-agent) completes synchronously, its PostToolUse carrying
 * the result inline (`{status:"completed", agentId, content, totalToolUseCount,
 * resolvedModel, totalDurationMs}`).
 *
 * Cost: scans all Agent rows in the DB. For typical workloads (a few hundred
 * sub-agents) this is fine. If the table grows large, we'd add a materialized
 * agent_runs table updated at ingest time (Phase 8+).
 *
 * Cached: the client refetches /api/agents on EVERY Task/Agent event, and each
 * uncached call full-scans the events table + JSON.parses per row + calls
 * listSessions(). We memoize the full computed array, valid while the max
 * Task/Agent event id is unchanged AND the cache is younger than
 * AGENT_RUNS_CACHE_TTL_MS — the age bound keeps stuck-agent promotion (which
 * depends on wall-clock + the alive-set) prompt even when no new events arrive.
 */
const AGENT_RUNS_CACHE_TTL_MS = 2_000;
let _agentRunsCache: { maxId: number; at: number; value: AgentRun[] } | null = null;

export function listAgentRuns(limit = 50): AgentRun[] {
  const db = getDb();
  // Cheap freshness probe: the max Task/Agent event id. When it (and the age)
  // are unchanged we serve the memoized array. `.get()` is the real
  // better-sqlite3 scalar API; if it's unavailable (e.g. a unit-test db stub)
  // we fall back to maxId = -1, which disables the cache entirely (always
  // recompute) so tests stay isolated and never see a stale memo.
  let maxId = -1;
  try {
    // `kind = ?` hits the indexed events_kind_idx column (see db.ts) rather
    // than scanning every UserPromptSubmit row's raw payload for a substring
    // — this probe runs on every Task/Agent SSE event, so it needs to stay
    // cheap as the events table grows.
    const row = db
      .prepare(
        `SELECT MAX(id) AS m FROM events
         WHERE tool_name IN ('Task','Agent')
            OR kind = ?`
      )
      .get(TASK_NOTIFICATION_KIND) as { m: number | null } | undefined;
    maxId = row?.m ?? 0;
  } catch {
    maxId = -1;
  }
  const now = Date.now();
  if (
    maxId >= 0 &&
    _agentRunsCache &&
    _agentRunsCache.maxId === maxId &&
    now - _agentRunsCache.at < AGENT_RUNS_CACHE_TTL_MS
  ) {
    return _agentRunsCache.value.slice(0, limit);
  }
  const value = computeAgentRuns();
  if (maxId >= 0) _agentRunsCache = { maxId, at: now, value };
  return value.slice(0, limit);
}

/** Full sorted agent-run list (newest first), before any limit slice. */
function computeAgentRuns(): AgentRun[] {
  const db = getDb();
  // Claude Code's sub-agent invocation tool is named `Task` (not `Agent`).
  // We match both to stay forward-compatible.
  const rows = db
    .prepare(
      `SELECT id, ts, session_id, hook_type, payload
       FROM events
       WHERE tool_name IN ('Task', 'Agent')
          OR kind = ?
       ORDER BY id ASC`
    )
    .all(TASK_NOTIFICATION_KIND) as Array<{ id: number; ts: string; session_id: string | null; hook_type: string; payload: string }>;

  const runsById: Map<number, AgentRun> = new Map();
  // tool_use_id → run, built from PreToolUse. A PostToolUse (and the later
  // task-notification) share the same tool_use_id, so they find their run
  // directly — no ordering assumption.
  const runsByToolUseId: Map<string, AgentRun> = new Map();
  // A sub-agent's OWN agentId → its run's event id. Recorded from every
  // PostToolUse that exposes an agentId (async ack OR sync completion). A child
  // launch's PreToolUse carries `ctx.agent_id` = its parent sub-agent's
  // agentId, so this map turns that into the parent run's id (resolved in the
  // final pass below, once every Post has been seen).
  const agentIdToRunId: Map<string, number> = new Map();
  // run event id → the `ctx.agent_id` on its PreToolUse (the sub-agent that
  // ISSUED this launch), or null for a main-agent launch. Deferred lookup so a
  // parent seen after the child still links correctly.
  const launchedBy: Map<number, string | null> = new Map();

  for (const row of rows) {
    let ctx: any = {};
    try { ctx = JSON.parse(row.payload)?.ctx ?? {}; } catch { ctx = {}; }
    const toolUseId = typeof ctx.tool_use_id === "string" ? ctx.tool_use_id : null;

    if (row.hook_type === "PreToolUse") {
      const input = ctx.tool_input && typeof ctx.tool_input === "object" ? ctx.tool_input : {};
      const subagentType = typeof input.subagent_type === "string" ? input.subagent_type : null;
      const prompt = typeof input.prompt === "string" ? input.prompt : null;
      const description = typeof input.description === "string" ? input.description : null;
      const run: AgentRun = {
        id: row.id,
        sessionId: row.session_id,
        subagentType,
        model: null,
        prompt,
        description,
        startTs: row.ts,
        endTs: null,
        durationMs: null,
        toolUseCount: null,
        result: null,
        parentAgentId: null, // resolved in the final pass, via launchedBy
        status: "running",
      };
      runsById.set(row.id, run);
      launchedBy.set(row.id, typeof ctx.agent_id === "string" ? ctx.agent_id : null);
      if (toolUseId) runsByToolUseId.set(toolUseId, run);
    } else if (row.hook_type === "PostToolUse") {
      const run = toolUseId ? runsByToolUseId.get(toolUseId) : undefined;
      if (!run) continue; // no tool_use_id, or a Post with no matching Pre — can't correlate
      const r = ctx.tool_response ?? ctx.tool_result ?? null;
      // Record this sub-agent's own id → run for child→parent linkage. Present
      // on both response shapes.
      if (r && typeof r === "object" && typeof r.agentId === "string") {
        agentIdToRunId.set(r.agentId, run.id);
      }
      if (r && typeof r === "object" && r.isAsync === true) {
        // Async launch ack only — the sub-agent's real work hasn't happened
        // yet; it arrives later as a task-notification (below). Keep the run
        // "running"; grab the best-effort model hint the ack carries.
        run.model = extractModel(r) ?? run.model;
        continue;
      }
      // Sync completion (or any non-ack response) carries the real result.
      run.endTs = row.ts;
      run.status = "completed";
      run.durationMs = extractDurationMs(r) ?? Date.parse(row.ts) - Date.parse(run.startTs);
      if (r != null) {
        run.result = extractAgentText(r).slice(0, 4000);
        run.model = extractModel(r);
        run.toolUseCount = extractToolUseCount(r);
      }
    } else if (row.hook_type === "UserPromptSubmit") {
      const prompt = typeof ctx.prompt === "string" ? ctx.prompt : null;
      const notice = prompt ? parseTaskNotification(prompt) : null;
      // Only a "completed" notification resolves the run — the harness may
      // notify more than once for the same task-id while a backgrounded agent
      // still has live children of its own (see TASK_NOTIFICATION_KIND); an
      // intermediate notification must not prematurely mark it done.
      if (!notice || notice.status !== "completed") continue;
      // Resolve by tool_use_id (primary) or agentId (fallback) — both link
      // back to the launching PreToolUse.
      let run = notice.toolUseId ? runsByToolUseId.get(notice.toolUseId) : undefined;
      if (!run && notice.taskId) {
        const rid = agentIdToRunId.get(notice.taskId);
        if (rid != null) run = runsById.get(rid);
      }
      if (!run) continue;
      run.status = "completed";
      run.endTs = row.ts;
      run.durationMs = notice.durationMs ?? Date.parse(row.ts) - Date.parse(run.startTs);
      run.toolUseCount = notice.toolUseCount ?? run.toolUseCount;
      if (notice.result != null) run.result = notice.result.slice(0, 4000);
    }
  }

  // Resolve parent links now that every Post's agentId is known. A run's parent
  // is the run whose sub-agent issued this launch (its PreToolUse ctx.agent_id).
  for (const run of runsById.values()) {
    const issuer = launchedBy.get(run.id) ?? null;
    run.parentAgentId = issuer ? agentIdToRunId.get(issuer) ?? null : null;
  }

  // Promote stuck "running" agents to "interrupted" when their parent session
  // is no longer alive. Without this, sub-agents from crashed/exited sessions
  // pulse forever in the panel even though they cannot possibly finish.
  const aliveSessions = new Set<string>();
  try {
    for (const s of listSessions()) {
      if (!s.sessionId) continue;
      // Alive means: ambient cli/SDK session with no lifecycle decoration,
      // or an active-session entry that's currently alive.
      if (!s.lifecycle || s.lifecycle === "alive") aliveSessions.add(s.sessionId);
    }
  } catch { /* if sessions can't be read, fall back to leaving status untouched */ }

  const now = Date.now();
  for (const run of runsById.values()) {
    if (run.status !== "running") continue;
    const sid = run.sessionId;
    const sessionDead = !sid || !aliveSessions.has(sid);
    const startMs = Date.parse(run.startTs);
    const elapsed = now - startMs;
    if (sessionDead && elapsed > STUCK_GRACE_MS) {
      run.status = "interrupted";
      run.durationMs = elapsed;
    }
  }

  return Array.from(runsById.values()).sort((a, b) => b.id - a.id);
}

export function getAgentDetail(id: number): AgentRun | null {
  const runs = listAgentRuns(10_000);
  return runs.find((r) => r.id === id) ?? null;
}

/**
 * Best-effort: pull the model id (e.g. "claude-haiku-4-5", "claude-sonnet-4-6")
 * out of a Task tool_response. The response shape isn't strictly documented;
 * we check the spots Claude Code has historically put it.
 */
function extractModel(v: unknown): string | null {
  if (v == null || typeof v !== "object") return null;
  const obj = v as Record<string, any>;
  if (typeof obj.model === "string") return obj.model;
  // Both the async launch ack and the sync completion shape name it
  // `resolvedModel` (verified live) — without this a sub-agent's model shows
  // null even though the response carried it.
  if (typeof obj.resolvedModel === "string") return obj.resolvedModel;
  if (obj.usage && typeof obj.usage.model === "string") return obj.usage.model;
  if (obj.metadata && typeof obj.metadata.model === "string") return obj.metadata.model;
  // Walk nested message objects (sometimes wrapped under .response or .message)
  for (const key of ["response", "message", "result"]) {
    const inner = obj[key];
    if (inner && typeof inner === "object" && typeof inner.model === "string") return inner.model;
  }
  return null;
}

/**
 * Best-effort tool-use count from the Task response. The TUI shows this in
 * the "Done (N tool uses · ...)" summary; we surface it the same way.
 */
function extractToolUseCount(v: unknown): number | null {
  if (v == null || typeof v !== "object") return null;
  const obj = v as Record<string, any>;
  if (typeof obj.tool_uses === "number") return obj.tool_uses;
  if (typeof obj.toolUseCount === "number") return obj.toolUseCount;
  // The sync completion shape names it `totalToolUseCount` (verified live).
  if (typeof obj.totalToolUseCount === "number") return obj.totalToolUseCount;
  if (obj.usage && typeof obj.usage.tool_use_count === "number") return obj.usage.tool_use_count;
  return null;
}

/**
 * Best-effort run duration (ms) from a Task response. The sync completion shape
 * carries `totalDurationMs`; some shapes use `durationMs`. Returns null when
 * absent, so the caller falls back to (endTs − startTs).
 */
function extractDurationMs(v: unknown): number | null {
  if (v == null || typeof v !== "object") return null;
  const obj = v as Record<string, any>;
  if (typeof obj.totalDurationMs === "number") return obj.totalDurationMs;
  if (typeof obj.durationMs === "number") return obj.durationMs;
  return null;
}

/**
 * Extract completion data from a harness-delivered `<task-notification>`
 * block — the real result of an async Agent/Task launch, arriving later as a
 * UserPromptSubmit turn (see TASK_NOTIFICATION_KIND). This is fixed,
 * harness-authored boilerplate (not model text), pulled with targeted regexes
 * rather than a real XML parser since the shape is flat and known. `status`
 * is read as-is ("completed" is the only value the caller treats as
 * terminal) — anything else (or a missing tag) means the background agent is
 * still going. Returns null when `prompt` isn't a notification at all.
 */
function parseTaskNotification(prompt: string): {
  toolUseId: string | null;
  taskId: string | null;
  status: string | null;
  result: string | null;
  toolUseCount: number | null;
  durationMs: number | null;
} | null {
  if (!prompt.startsWith("<task-notification>")) return null;
  // `<tool-use-id>` links straight back to the launching PreToolUse (the
  // primary correlation key); `<task-id>` is the sub-agent's agentId (fallback).
  const toolUseId = /<tool-use-id>([^<]*)<\/tool-use-id>/.exec(prompt)?.[1]?.trim() ?? null;
  const taskId = /<task-id>([^<]*)<\/task-id>/.exec(prompt)?.[1]?.trim() ?? null;
  const status = /<status>([^<]*)<\/status>/.exec(prompt)?.[1]?.trim() ?? null;
  const result = /<result>([\s\S]*?)<\/result>/.exec(prompt)?.[1]?.trim() ?? null;
  const toolUses = /<tool_uses>(\d+)<\/tool_uses>/.exec(prompt)?.[1];
  const durationMs = /<duration_ms>(\d+)<\/duration_ms>/.exec(prompt)?.[1];
  return {
    toolUseId,
    taskId,
    status,
    result,
    toolUseCount: toolUses != null ? parseInt(toolUses, 10) : null,
    durationMs: durationMs != null ? parseInt(durationMs, 10) : null,
  };
}

/**
 * Sub-agent tool_response is usually a wrapped object like
 *   { content: [{ type: "text", text: "..." }], ... }
 * or { text: "..." }. Pull the text out instead of dumping JSON so the panel
 * shows the agent's actual answer rather than the serialized envelope.
 */
function extractAgentText(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  if (typeof v !== "object") return String(v);
  const obj = v as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.message === "string") return obj.message;
  if (typeof obj.result === "string") return obj.result;
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as unknown[])
      .map((c) => {
        if (typeof c === "string") return c;
        const item = c as Record<string, unknown>;
        if (typeof item.text === "string") return item.text;
        if (typeof item.content === "string") return item.content;
        return "";
      })
      .filter((s) => s.length > 0);
    if (texts.length) return texts.join("\n");
  }
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
