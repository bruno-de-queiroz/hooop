import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, type FSWatcher } from "node:fs";
import { watchSafe } from "./watch-safe";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { CLAUDE_SESSIONS_DIR } from "./paths";
import { getActiveSession, listActiveSessions, bootActiveSessions, aliasesFor, isResumeInFlight } from "./active-sessions";

export interface SessionInfo {
  id: string;           // filename without .json (the PID)
  path: string;
  mtime: string;        // ISO timestamp
  size: number;
  // Parsed from the JSON body — present on healthy session files.
  sessionId?: string;   // UUID used in event.session_id (the one to filter on)
  pid?: number;
  cwd?: string;
  entrypoint?: string;  // "cli" (interactive) | "sdk-cli" (background SDK) | ...
  kind?: string;        // "interactive" | ...
  version?: string;
  status?: string;      // "busy" | "idle" | undefined
  startedAt?: number;
  updatedAt?: number;
  // Decoration from spawn.ts when this session was started by a dashboard skill run.
  skill?: string;
  skillArgs?: string;
  runId?: string;
  // Decoration from active-sessions.ts when this session is dashboard-controllable.
  controllable?: boolean;
  lifecycle?: "provisioning" | "alive" | "dormant" | "ended" | "expired" | "error";
  // Failure reason for a session in the "error" lifecycle (e.g. a git clone that
  // failed during provisioning). Absent otherwise.
  error?: string;
  // Tail of `git clone --progress`'s live output, present only while
  // lifecycle === "provisioning". Lets the dashboard show clone progress
  // instead of a spinner that looks frozen on a large repo.
  cloneProgress?: string;
  // True while a model turn is in flight (from the active-session registry).
  // Drives the "model is thinking" indicator for all viewers, including late
  // joiners who read it off this row rather than the live event stream.
  turnActive?: boolean;
  // True when unattended auto-approval (auto mode) is engaged. Surfaced from the
  // active-session registry so every viewer's header shows the "Auto mode" pill,
  // late joiners included.
  autoMode?: boolean;
  // Per-session idle-dormancy window and burn-after-use flag, surfaced from the
  // active-session registry for the same reason autoMode is: every viewer and
  // late joiner reads lifecycle state off this row rather than the event
  // stream, so the settings panel and header pills render correctly on load,
  // not just after a live update. null/absent idleTtlMs means "install
  // default"; 0 means "never go dormant".
  idleTtlMs?: number | null;
  burnAfterUse?: boolean;
  displayName?: string | null;  // user-set name or first-prompt auto-name
  // Historical ids the same conversation has been known by. Populated when
  // `claude --resume` minted a new internal session_id under the hood, or
  // when a pending-X spawn id was swapped to a canonical UUID. The
  // dashboard uses this on load to widen its SSE event filter so events
  // under any historical id still join the transcript for the URL the
  // user is on. Absent when no aliases exist.
  aliases?: string[];
  // Last-turn telemetry (model, mode, usage, duration). Surfaced from the
  // active-session registry; absent until the first result frame.
  lastStats?: {
    v: 1;
    model?: string | null;
    mode?: string | null;
    usage?: {
      input_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      output_tokens?: number;
    };
    turnDurationMs?: number;
    turnEndedAt?: number;
    // Context window this session's model runs against and the auto-compact
    // trigger percentage, as configured by the sandbox at spawn. See LastStats
    // in active-sessions.ts.
    contextWindow?: number;
    // The window claude actually enforces this incarnation (frozen at spawn);
    // the dashboard meter prefers it. See LastStats in active-sessions.ts.
    autoCompactWindow?: number;
    autoCompactPct?: number;
  };
}

/**
 * Push-based session change notifications. Subscribers receive a "change" event
 * whenever a session file is created, modified, or deleted in
 * ~/.claude/sessions/. The /api/stream SSE handler relays these to browsers.
 */
export const sessionsBus = new EventEmitter();
sessionsBus.setMaxListeners(100);

const _cache: Map<string, SessionInfo> = new Map();
let _watcher: FSWatcher | null = null;
let _started = false;

export function readSessionMeta(file: string): SessionInfo | null {
  try {
    const stat = statSync(file);
    const id = file.split("/").pop()!.replace(/\.json$/, "");
    const info: SessionInfo = {
      id,
      path: file,
      mtime: stat.mtime.toISOString(),
      size: stat.size,
    };
    try {
      const body = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
      info.sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
      info.pid = typeof body.pid === "number" ? body.pid : undefined;
      info.cwd = typeof body.cwd === "string" ? body.cwd : undefined;
      info.entrypoint = typeof body.entrypoint === "string" ? body.entrypoint : undefined;
      info.kind = typeof body.kind === "string" ? body.kind : undefined;
      info.version = typeof body.version === "string" ? body.version : undefined;
      info.status = typeof body.status === "string" ? body.status : undefined;
      info.startedAt = typeof body.startedAt === "number" ? body.startedAt : undefined;
      info.updatedAt = typeof body.updatedAt === "number" ? body.updatedAt : undefined;
    } catch {
      // Partial / corrupt JSON — surface the file but without parsed fields.
    }
    // Prune stale sdk-cli files whose PID is dead. Each dashboard-spawned
    // claude writes one of these, and they linger on container restart /
    // ungraceful exit, polluting the sidebar with phantom entries that have
    // no registry slot (so they render as read-only). Only sdk-cli is safe to
    // check: cli (the user's TUI) lives in another container and its PID
    // namespace is inaccessible from here.
    if (info.entrypoint === "sdk-cli" && typeof info.pid === "number" && !isPidAlive(info.pid)) {
      try { unlinkSync(file); } catch { /* ignore */ }
      return null;
    }
    return info;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  // /proc first, because these pids belong to `claude` — which runs as the
  // MODEL's uid while this server runs as its own. kill(pid, 0) across that
  // boundary always throws EPERM, so the signal probe below can no longer tell
  // "alive" from "gone" and the callers that prune stale session files on a
  // false answer would either never prune or prune a live session. Directory
  // existence needs no permission over the target at all, and costs one stat
  // rather than a fork through the setuid helper — which matters because this
  // runs once per session file on every refresh.
  if (process.platform === "linux") return existsSync(`/proc/${pid}`);

  try {
    // Non-Linux (dev/test on macOS): same uid, so the signal probe is accurate.
    // Signal 0 is a permission probe: returns normally if the process exists
    // and we can signal it, throws ESRCH if the PID doesn't exist, EPERM if
    // it exists but we lack permission (still alive).
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

function refreshAll() {
  if (!existsSync(CLAUDE_SESSIONS_DIR)) return;
  _cache.clear();
  for (const name of readdirSync(CLAUDE_SESSIONS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const info = readSessionMeta(join(CLAUDE_SESSIONS_DIR, name));
    if (info) _cache.set(info.id, info);
  }
}

export function startSessionsWatcher() {
  if (_started) return;
  _started = true;
  if (!existsSync(CLAUDE_SESSIONS_DIR)) {
    // Directory may not exist yet on a fresh install; nothing to watch.
    return;
  }
  refreshAll();
  // fs.watch is push-based; no polling.
  _watcher = watchSafe(CLAUDE_SESSIONS_DIR, (_eventType, filename) => {
    if (!filename || !filename.toString().endsWith(".json")) return;
    const file = join(CLAUDE_SESSIONS_DIR, filename.toString());
    if (!existsSync(file)) {
      _cache.delete(filename.toString().replace(/\.json$/, ""));
    } else {
      const info = readSessionMeta(file);
      if (info) _cache.set(info.id, info);
    }
    sessionsBus.emit("change");
  });
}

export function stopSessionsWatcher() {
  if (_watcher) {
    _watcher.close();
    _watcher = null;
  }
  _started = false;
}

export function listSessions(): SessionInfo[] {
  // Ensure the active-sessions registry has loaded its checkpoint. This is
  // idempotent and protects us from module-bundling quirks where the
  // instrumentation hook ran the boot in a different module instance.
  bootActiveSessions();

  // Decorate with skill metadata + active-sessions controllability at read
  // time. Two `<pid>.json` files can carry the same sessionId (e.g. the
  // user's TUI plus a dashboard `--resume` of that conversation), so we
  // dedupe by sessionId and keep the freshest entry (largest mtime). Files
  // without a sessionId fall back to the pid-keyed bucket.
  const dedupe = new Map<string, SessionInfo>();
  for (const info of _cache.values()) {
    const key = info.sessionId ?? `pid:${info.id}`;
    const existing = dedupe.get(key);
    if (existing) {
      const a = Date.parse(info.mtime);
      const b = Date.parse(existing.mtime);
      if (!(a > b)) continue;
    }
    // Suppress the transient orphan row produced mid-resume. When
    // `claude --resume` mints a new session_id it writes a fresh
    // <newId>.jsonl before our stdout parser swaps the slot, so for ~200ms
    // this cache entry has no registry decoration and would render with a
    // null displayName (sidebar/header fall back to the cwd basename or an
    // id slice — the visible name flicker). A dashboard-spawned session
    // (entrypoint "sdk-cli") ALWAYS gets a registry slot once its id
    // settles, so an undecorated sdk-cli row during an in-flight resume in
    // this cwd is necessarily that orphan. Skip it; the decorated row for
    // the same conversation is still emitted and keeps the real name.
    if (
      info.sessionId &&
      info.entrypoint === "sdk-cli" &&
      !getActiveSession(info.sessionId) &&
      isResumeInFlight(info.cwd)
    ) {
      continue;
    }

    const decorated = { ...info };
    if (info.sessionId) {
      const active = getActiveSession(info.sessionId);
      if (active) {
        // Skill-launched sessions carry the skill/args on their registry meta
        // (they're regular sessions now — no separate run record). Surface them
        // so the sidebar can badge the row as a skill run.
        if (active.skill) {
          decorated.skill = active.skill;
          decorated.skillArgs = active.skillArgs ?? undefined;
        }
        decorated.controllable = active.status !== "expired";
        decorated.lifecycle = active.status;
        if (active.status === "error" && active.errorMessage) decorated.error = active.errorMessage;
        if (active.status === "provisioning" && active.cloneProgress) decorated.cloneProgress = active.cloneProgress;
        decorated.displayName = active.displayName;
        decorated.turnActive = active.turnActive === true;
        decorated.autoMode = active.autoMode === true;
        decorated.idleTtlMs = active.idleTtlMs ?? null;
        decorated.burnAfterUse = active.burnAfterUse === true;
        // The registry's lastSeenAt is the authoritative activity clock for a
        // controllable session: it advances on turn boundaries AND on
        // model-free side-channel activity (`!bash` / `>chat`, via
        // markSessionActive), neither of which ever touches claude's
        // <pid>.json — so its file mtime/updatedAt would leave a chat/bash
        // looking like no activity at all. Surface lastSeenAt (ms epoch) as
        // updatedAt so the dashboard's "unseen"/recently-active cue reacts to
        // a chat/bash, not just to model turns. Bump mtime in lockstep so the
        // row's relative-time label agrees.
        if (typeof active.lastSeenAt === "number" && Number.isFinite(active.lastSeenAt)) {
          // Clamp UP, never override: mid-turn claude can rewrite its
          // <pid>.json (a newer file updatedAt) in the gap between the
          // turn-start and turn-end lastSeenAt bumps, so a blind assignment
          // would tick the activity clock backwards. Math.max keeps it
          // monotonic. (A file updatedAt in legacy seconds is dwarfed by the
          // ms lastSeenAt, so the max lands on lastSeenAt — still correct.)
          const activity = Math.max(decorated.updatedAt ?? 0, active.lastSeenAt);
          decorated.updatedAt = activity;
          const activityIso = new Date(activity).toISOString();
          if (activityIso > decorated.mtime) decorated.mtime = activityIso;
        }
        if (active.lastStats) decorated.lastStats = active.lastStats;
        // Backfill creation time from the registry when Claude's <pid>.json
        // body didn't carry one (older versions / partial writes).
        decorated.startedAt ??= active.startedAt;
      }
      const a = aliasesFor(info.sessionId);
      if (a.length > 0) decorated.aliases = a;
    }
    dedupe.set(key, decorated);
  }

  const out: SessionInfo[] = Array.from(dedupe.values());
  const seen = new Set<string>(dedupe.keys());

  // Surface every registered session the file cache hasn't already covered.
  // A dashboard session now owns its id from spawn (--session-id), so its
  // registry row carries the SAME id claude will write into its <pid>.json —
  // once that file lands, the top loop's file row supersedes this one (deduped
  // via `seen` on sessionId). Until then (e.g. a freshly-created session with no
  // model turn yet, or a dormant one), this is the only row, so the session is
  // visible/selectable/chattable/bashable from the moment it's created — no
  // longer gated on claude writing a file after the first turn.
  //
  // (Historically this loop skipped `pending-` rows whose cwd matched an sdk-cli
  // cache file, to hide the ~200ms provisional-id spawn race. With ids owned at
  // spawn there is no provisional id and no race, and the shared workspace cwd
  // made that heuristic hide brand-new sessions outright — so it's gone.)
  for (const a of listActiveSessions()) {
    if (seen.has(a.sessionId)) continue;
    const al = aliasesFor(a.sessionId);
    out.push({
      id: `dormant:${a.sessionId.slice(0, 8)}`,
      path: "",
      mtime: new Date(a.lastSeenAt).toISOString(),
      // updatedAt mirrors mtime here (both from lastSeenAt) so the client's
      // activity clock — which prefers updatedAt — moves on a chat/bash to a
      // registry-only row, matching the file-backed decoration above.
      updatedAt: a.lastSeenAt,
      size: 0,
      sessionId: a.sessionId,
      cwd: a.cwd,
      kind: "interactive",
      entrypoint: "sdk-cli",
      startedAt: a.startedAt,
      runId: a.runId ?? undefined,
      skill: a.via === "skill" ? a.label : undefined,
      controllable: a.status !== "expired",
      lifecycle: a.status,
      ...(a.status === "error" && a.errorMessage ? { error: a.errorMessage } : {}),
      ...(a.status === "provisioning" && a.cloneProgress ? { cloneProgress: a.cloneProgress } : {}),
      displayName: a.displayName,
      turnActive: a.turnActive === true,
      autoMode: a.autoMode === true,
      idleTtlMs: a.idleTtlMs ?? null,
      burnAfterUse: a.burnAfterUse === true,
      ...(al.length > 0 ? { aliases: al } : {}),
      ...(a.lastStats ? { lastStats: a.lastStats } : {}),
    });
  }

  return out.sort((a, b) => (b.mtime > a.mtime ? 1 : -1));
}
