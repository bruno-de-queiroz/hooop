import { ChildProcess } from "node:child_process";
import { killChildAsAgent, mkdirShared, spawnAsAgent } from "./as-agent";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  unlinkSync,
  rmSync,
  readdirSync,
  copyFileSync,
  statSync,
  realpathSync,
} from "node:fs";
import { join, dirname, relative, sep, isAbsolute } from "node:path";
import type { Writable } from "node:stream";
import { STATE_DIR, CLAUDE_SESSIONS_DIR, SESSIONS_ROOT, sessionWorkdir, HOOK_SOCKET } from "./paths";
import { ingestEventLine } from "./ingestor";
import { deleteEventsForSessions, listEventSessionIds } from "./db";
import { discoverInstalledPluginDirs } from "./plugin-paths";
import { isCwdAllowed, sessionScratchDir } from "./cwd-policy";
import { bashConfinementEnv } from "./landlock-policy";
import { isCriticalBash, isCriticalTool } from "./peer-policy";
import {
  PreviewError,
  awaitSettled,
  describePreview,
  emitPreviewEvent,
  getPreview,
  listPreviews,
  previewForSession,
  reapPreviewsForSessions,
  rebuildPreview,
  refreshAll,
  restartPreview,
  startPreview,
  stopPreview,
  summarizePreviews,
} from "./previews";
import { validatePreviewSpec, PREVIEW_LIMITS, type PreviewSpec } from "@shared/preview-spec";
import { toClaudeFileRefs } from "@shared/file-mentions";
import { driveQueue, describeDriveResult } from "./preview-drive";
// Both are leaf modules (neither imports this one), so the idle sweeps can reuse
// the same revocation the delete-session path uses without an import cycle.
import { revokeSharesForSession } from "./shares";
import { dropJoinsForShare } from "./peer-joins";
import { randomSessionName } from "./random-name";
import { listSlashCommands, NATIVE_PASSTHROUGH_COMMANDS } from "./commands";
import { listSkills } from "./skills";
import { log } from "@shared/logger";
import { windowForModel, DEFAULT_WINDOW } from "@shared/model-windows";
import { AGENT_DIRECTIVE_KIND, TASK_NOTIFICATION_KIND } from "@shared/turn-kinds";

/**
 * Long-lived `claude --input-format=stream-json --output-format=stream-json`
 * subprocesses, one per controllable session. The dashboard's two-way write
 * path lives here.
 *
 * Stream-json input shape (verified against claude-code v2.1.138):
 *
 *   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"..."}]}}\n
 *
 * Multiple turns over one subprocess are supported; the same session_id flows
 * back on every assistant + result frame.
 *
 * The actual event ingest path (hook -> /api/ingest -> SQLite) is untouched.
 * We only parse stream-json output enough to: (a) learn the spawned sessionId,
 * (b) know when a turn finishes (the `result` frame), and (c) capture the
 * model's final text for an optional run output buffer.
 *
 * Cross-restart recovery: registry mutations atomically write a checkpoint
 * to `~/.claude/hooop/active-sessions.json`. On boot we read it back as
 * `status: "dormant"` and revive on first write attempt via `claude --resume`.
 */

// "provisioning": a git-clone session whose repo is still being cloned in the
// background. The session is visible (so the dashboard can show a "cloning…"
// state) but NOT yet drivable — it flips to "alive" once the clone succeeds, or
// "error" (with meta.errorMessage) if it fails.
export type LifecycleStatus = "provisioning" | "alive" | "dormant" | "ended" | "expired" | "error";

/**
 * Per-turn telemetry captured from stream-json frames. Populated incrementally:
 *   - system/init frame → model, mode
 *   - result frame      → usage, turnDurationMs, turnEndedAt
 * Dashboard renders this in the active-session header (context fill %, last
 * turn time, tokens). Versioned via `v` so the dashboard can fall back
 * gracefully when the schema evolves.
 */
export interface LastStats {
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
  turnEndedAt?: number;     // ms epoch — for relative-time rendering

  // Context window (denominator for the dashboard's "ctx %") this session's
  // model runs against, and the percentage of it at which auto-compaction is
  // configured to fire. Bound to the model via windowForModel: seeded at spawn
  // when --model is known, then (re)bound from the resolved id the init frame
  // reports — so it always tracks the ACTUAL model, never a spawn-time guess.
  // Left unset when the model can't be sized; the dashboard then falls back to
  // its own model table. autoCompactPct matches the CLAUDE_AUTOCOMPACT_PCT_OVERRIDE
  // we hand claude (and the CLAUDE_CODE_AUTO_COMPACT_WINDOW is this contextWindow).
  contextWindow?: number;
  // The window claude actually enforces this incarnation (= the value handed to
  // CLAUDE_CODE_AUTO_COMPACT_WINDOW at spawn). Frozen for the process's life;
  // the dashboard meter prefers it over contextWindow so the bar + auto-compact
  // marker agree with when compaction really fires. See spawnControllable.
  autoCompactWindow?: number;
  autoCompactPct?: number;

  // Cumulative across all turns of this session, summed at end of each
  // turn. Survives dormant→alive (kept in the checkpoint). The dashboard's
  // stats strip renders these as "total tokens" — derived from registry
  // state instead of walking event payloads on the client, which would
  // otherwise require fetching EventRowFull for every Stop event.
  totals?: {
    input_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
    output_tokens: number;
    turns: number;
  };
}

export interface ActiveSessionMeta {
  sessionId: string;
  runId: string | null;     // vestigial; retained for checkpoint compatibility
  label: string;            // initial label (skill base name, "new conversation", or user-provided)
  displayName: string | null; // friendly name; auto-set from first prompt if not user-provided
  cwd: string;
  via: "skill" | "new-conversation" | "resumed";
  // Set for a skill-launched session (via === "skill"): the invoked skill/command
  // name and its args. Surfaced by lib/sessions.ts so the sidebar can badge the
  // row as a skill run — the same labeling the old detached-run path provided.
  skill?: string | null;
  skillArgs?: string | null;
  startedAt: number;
  lastSeenAt: number;
  status: LifecycleStatus;
  // Configured `--model` override for this session (CLI alias or full id), or
  // null for the user's default. Set at creation and by `/model`; persisted so
  // it survives dormant→awake — wakeSession re-applies it on every resume.
  model?: string | null;
  // Unattended approval: when true, createPermissionRequest auto-approves routine
  // tool calls (Write/Edit/safe Bash/ordinary MCP) without a dashboard card; only
  // the critical set (git, destructive/secret bash, writes to secret paths)
  // and AskUserQuestion still prompt. A durable host choice — persisted like
  // `model`, re-applied on wake — and broadcast via the session row so every
  // viewer's header reflects it. Set only by setSessionAutoMode (host/full-peer).
  autoMode?: boolean;
  // How long this session may sit idle before it goes dormant, overriding the
  // install-wide IDLE_TTL_MS default for this session only. `null`/absent means
  // "use the install default"; a positive number is this session's own window;
  // `0` means "never" — this session opts out of idle-dormancy entirely. A
  // durable host choice, persisted like `model`/`autoMode` and re-applied on
  // wake (see effectiveIdleTtl, consulted by the idle sweeps instead of the
  // install constant directly).
  idleTtlMs?: number | null;
  // When true, this session does not go dormant on going idle — it destroys
  // itself instead (transcript, workspace, events, shares, previews; see
  // destroySession). Set only by setSessionBurnAfterUse or at creation;
  // persisted like `autoMode` so it survives dormant→awake up until the moment
  // it actually fires.
  burnAfterUse?: boolean;
  // Ephemeral (NOT persisted): true while a model turn is in flight. Set at
  // writeUserTurn, cleared on the result frame or on child exit. Broadcast via
  // the session row so EVERY connected peer — and late joiners reading
  // /api/sessions — see the "model is thinking" indicator, not just clients
  // that happened to witness the UserPromptSubmit event.
  turnActive?: boolean;
  pid?: number;
  exitCode?: number | null;
  errorMessage?: string;
  lastStats?: LastStats;    // last turn's telemetry; missing until first turn completes
  // Tail of `git clone --progress`'s output (stdout+stderr, \r-delimited
  // updates normalized to \n), so the dashboard can show live clone progress
  // instead of a spinner that looks frozen on a large repo. Set only while
  // status === "provisioning"; the slot is discarded once the clone finishes
  // (success or failure), so this never lingers past that.
  cloneProgress?: string;
  // The spec of the last preview this session ran, kept AFTER the preview is
  // gone so the dashboard can offer a one-click restart instead of making the
  // human retype what they already told us. Set when idle-dormancy releases a
  // preview (see onSessionWentDormant); persisted, so it survives the restart
  // too. Reviving deliberately does NOT auto-start it — a surprise `npm ci` and
  // a silently claimed slot are worse than a button.
  lastPreviewSpec?: PreviewSpec | null;
  // Why that preview is no longer running. Only "idle" today; a field rather
  // than a boolean because the panel's wording depends on the reason, and an
  // explicit stop must NOT leave a "we stopped this for you" message behind.
  lastPreviewStoppedReason?: "idle" | null;
}

/**
 * One outstanding permission ask the model has emitted via a stream-json
 * `control_request` frame. The model pauses until we write a matching
 * `control_response` to stdin. REAL (non-synthetic) asks are intentionally NOT
 * persisted to the checkpoint: a sandbox restart kills the child anyway, so any
 * open ask is dead. SYNTHETIC plan reviews (`synthetic: true`) ARE persisted and
 * carried across revive — no hook waits on them, and losing a plan the user was
 * about to approve is a real bug (see CheckpointFile.pendingReviews). Keyed by
 * `requestId` (claude's UUID for the frame).
 */
export interface PendingPermissionRequest {
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  input: unknown;
  decisionReason: string | null;
  receivedAt: number;
  /** Display name of whoever drove the turn this ask came from ("host" or a
   * peer's name). Lets the dashboard show "from $peer" and offer the
   * host an "allow all from $peer" action. */
  author: string | null;
  /** Share id of the driving peer (null for the host). The trust key for
   * session-scoped auto-approve. Not surfaced to clients. */
  shareId: string | null;
  /**
   * True when this ask is in the CRITICAL set: git, a destructive or secret
   * Bash command, a secret path, an MCP write, a path outside the session's
   * workdir, or publishing a preview.
   *
   * Recorded at creation rather than recomputed at decision time, so the
   * question "is this dangerous?" is answered exactly once, by the code that
   * already answers it to decide whether to escalate. Two evaluations of the
   * same predicate against a slot whose cwd may have changed is how the gate and
   * the decision gate come to disagree, and the disagreement that matters is the
   * one where the gate escalates to a human and the decision path then lets the
   * wrong human answer.
   *
   * What it BUYS: the ask becomes host-only to answer. The gate already refuses
   * to auto-approve a critical call in every unattended mode (approved plan,
   * trusted peer, auto mode) — but "escalate to a human" was not the same as
   * "escalate to the HOST", and a full-capability peer could answer their own
   * turn's `rm -rf`. See the permission route.
   */
  critical?: boolean;
  /** True for a plan review SYNTHESIZED from a plan-mode turn that ended
   * WITHOUT a blocking ExitPlanMode ask (weaker models write the plan as prose
   * and stop). No hook waits on it — approve/reject dispatch a follow-up turn
   * rather than resolving a permission gate. */
  synthetic?: boolean;
  /** True when this ask was raised while the session was in a `/plan` turn
   * (slot.planTurnActive). AskUserQuestion is allowed to surface during plan
   * mode (clarifying questions are read-only); this flag lets the answer relay
   * keep the session in plan mode instead of silently dropping enforcement. */
  planMode?: boolean;
}

interface LiveSlot {
  meta: ActiveSessionMeta;
  child?: ChildProcess;
  stdin?: Writable;
  writeQueue: Promise<void>;
  outBuf: string;           // tail of last stream-json output
  outBufBytes: number;
  pendingRequests: PendingPermissionRequest[];
  // FIFO of authors for turns written via writeUserTurn but whose
  // UserPromptSubmit hook event hasn't been ingested yet. Pushed in stdin
  // order (writeQueue serializes), popped on each real UserPromptSubmit so the
  // transcript can attribute "who sent this" in a shared session. Every real
  // turn has an author ("host" or a peer name) — never null; only a turn NOT
  // sent via writeUserTurn (replay/compaction) has no queued author, surfaced as
  // a null pop when the queue is empty. Bounded by max length + child close so a
  // crash can't mis-attribute a later turn.
  pendingAuthors: Array<{ author: string; shareId: string | null; at: number; thumbnails?: TurnImage[]; kind?: string | null; promptOverride?: string }>;
  // Who drove the turn currently executing (set when its UserPromptSubmit is
  // attributed, valid until the next turn). Lets a PreToolUse permission ask
  // — which fires later in the same turn — know which peer triggered it.
  currentTurn: { author: string; shareId: string | null } | null;
  // Share ids the host has granted session-scoped "allow all" to. In-memory
  // only (resets on sandbox restart / session end, by design). A PreToolUse
  // ask from a trusted peer auto-approves (except git, which always
  // escalates to the host).
  trustedShareIds: Set<string>;
  // ---- plan-review tracking (per turn) ----
  // Latest REAL assistant text seen this turn — fallback plan content when a
  // submit_plan/ExitPlanMode call carries an empty `plan` arg (see the gate's
  // plan-capture path). `<synthetic>` frames (usage-limit notices, "(no
  // content)", compaction summaries) are excluded — they aren't a plan.
  lastAssistantText?: string;
  // Usage block of the most recent REAL assistant message this turn (input +
  // cache_create + cache_read + output for that single API call). This — NOT
  // the `result` frame's usage — is the true context-window occupancy: the
  // result frame reports usage CUMULATIVELY across every API round-trip in the
  // turn, so an agentic turn (many tool calls, each re-reading the prompt from
  // cache) inflates cache_read to N× the real prompt and pins the ctx meter at
  // ~100% while the window is nearly empty. The last assistant message's usage
  // is the size of the prompt on the final call ≈ the current conversation
  // size, matching claude's own /context indicator. `<synthetic>` frames are
  // excluded (they aren't real model calls).
  lastAssistantUsage?: {
    input_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
    output_tokens?: number;
  };
  // A compaction (auto OR manual /compact) fired during THIS turn. The
  // compact_boundary handler sets it (and drops usage to the post-compaction
  // size) so the turn's trailing `result` frame — whose usage aggregates the
  // pre-compaction summarization read and would otherwise slam the meter back to
  // ~100% right after a compact — doesn't clobber that figure. Reset each turn.
  compactedThisTurn?: boolean;
  // A compact_boundary frame just landed and its summary has not arrived yet.
  //
  // This is what makes a synthetic USER frame a compaction rather than merely
  // synthetic. Claude marks isSynthetic on ANY message the harness injects that
  // the user did not type, and a compaction summary is only one of them — the
  // image-downscale notice ("[Image: original 2560x2000, displayed at ...]") is
  // another, and it fires on every oversized image a session reads. Treating
  // isSynthetic alone as "this is a compaction" put ten "Context compacted"
  // markers in one design session that never compacted once.
  //
  // Ordering makes the gate safe: claude emits compact_boundary BEFORE the
  // summary (verified live — boundary, then the isSynthetic user frame, then
  // result), for manual and auto alike. One-shot rather than turn-scoped so a
  // big image read LATER in an auto-compacted turn can't inherit the tag.
  compactSummaryPending?: boolean;
  // This turn was launched in plan mode (`/plan`, or a reject-revise turn).
  planTurnActive?: boolean;
  // A native passthrough command (`/compact`, `/cost`) we dispatched bare is
  // in flight, holding the command's name. Claude runs these WITHOUT emitting a
  // UserPromptSubmit or a Stop hook (see writeUserTurn), so `markTurnFinished`
  // — which only ever runs off the real Stop hook via server.ts's /ingest —
  // never fires for them and `turnActive` would stay true forever, pinning
  // every viewer's "thinking" indicator on after the command had finished.
  // The synthetic-frame handler consumes this to end the turn itself.
  //
  // Keyed on "we dispatched the command" rather than on the frame kind
  // ON PURPOSE: auto-compaction emits the SAME synthetic summary frame and the
  // same kind=compaction row, but its turn CONTINUES past the boundary. Only a
  // manual dispatch sets this, so auto-compaction can't clear the indicator
  // out from under a turn that is still running.
  nativeCommandPending?: string | null;
  // This turn executes a just-APPROVED plan: the host already reviewed and
  // approved it, so its tool calls auto-allow without raising per-tool
  // permission cards. Scoped to the single execution turn — set on the approval
  // "proceed" turn (writeUserTurn autoAllowRun), reset at the result frame.
  autoAllowPlanRun?: boolean;
  // One-shot: set right before an INTENTIONAL, self-recovering kill (`/stop`,
  // `/model`). The child's close handler consumes it to keep the visible
  // lifecycle "alive" instead of flipping to dormant — the next turn revives
  // the child transparently, so a user-initiated restart shouldn't read as the
  // session going idle. Cleared on consume so a later genuine exit still flips.
  suppressDormantOnce?: boolean;
  // One-shot: set right before the idle-TTL sweeper kills the child. claude
  // exits NON-ZERO on SIGTERM (see suppressDormantOnce), which would otherwise
  // read as "ended"; this flag forces the close handler to mark the slot
  // "dormant" (idle + resumable) instead. Cleared on consume.
  reapToDormant?: boolean;
  // Set by destroySession before it does anything else, and never persisted
  // (it lives on the slot, not on meta — a checkpoint write mid-teardown must
  // never claim a session is "destroying" after a restart). destroySession's
  // own path (deleteSession -> endSession) kills the child, whose close
  // handler would otherwise see meta.burnAfterUse still set and call
  // destroySession right back — this flag is what breaks that recursion: the
  // close handler's burn branch is skipped whenever it's already true, and
  // destroySession itself no-ops (returns a zero result) on re-entry.
  destroying?: boolean;
  // True when this child was spawned via `claude --resume` (reviving a dormant
  // slot). A resume can fail at runtime even when a transcript exists — a
  // corrupt/partial .jsonl or a claude version that can't read an older
  // transcript makes `--resume` exit before consuming stdin, so the turn we
  // just wrote is silently swallowed. writeUserTurn watches for that (a
  // frame-less early exit on a resume spawn) and recovers. A fresh spawn
  // (--session-id) never sets this: it always starts, so there's nothing to
  // fall back to.
  resumeSpawn?: boolean;
  // Set true the moment the stdout parser reads ANY valid stream-json frame —
  // proof the subprocess came alive and is emitting. Used to distinguish a
  // healthy (re)spawn from a resume that died before producing anything.
  sawFirstFrame?: boolean;
  // One-shot resolver installed by waitForResumeOutcome; the parser calls it on
  // the first frame so a caller can stop waiting the instant the child is
  // confirmed alive (rather than waiting out the timeout).
  notifyFirstFrame?: () => void;
}

const MAX_PENDING_AUTHORS = 8;

const CHECKPOINT_FILE = join(STATE_DIR, "active-sessions.json");
const CHECKPOINT_TMP = CHECKPOINT_FILE + ".tmp";
const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const MAX_OUT_BYTES = 64 * 1024;
const PRUNE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// Idle-TTL reaping. `claude -p --input-format=stream-json` is a PERSISTENT
// process: it stays alive between turns (and even with no turn ever sent),
// waiting for the next stream-json message. So nothing makes an idle session
// exit on its own — the "close → dormant" transition only ever fired on
// restart/kill. The sandbox therefore owns idle-dormancy now: a periodic sweep
// kills the subprocess of any session with no activity for its effective TTL,
// which routes through the normal close handler → "dormant" → revive-on-next-turn
// via --resume.
//
// IDLE_TTL_MS is the INSTALL-WIDE DEFAULT only — the value a session falls back
// to when it has no `meta.idleTtlMs` of its own. Every sweep consults
// effectiveIdleTtl(slot), never this constant directly. Tunable via
// HOOOP_SESSION_IDLE_TTL_MS (0 disables reaping BY DEFAULT — a session with its
// own explicit idleTtlMs still reaps/never-reaps on its own terms).
const IDLE_TTL_MS = (() => {
  const raw = process.env.HOOOP_SESSION_IDLE_TTL_MS;
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 30 * 60 * 1000; // 30 minutes
})();
const IDLE_SWEEP_INTERVAL_MS = 60 * 1000;
let _idleSweeper: ReturnType<typeof setInterval> | null = null;

/**
 * The idle-dormancy window that actually governs this slot: its own
 * `meta.idleTtlMs` when the host set one, otherwise the install-wide default
 * (IDLE_TTL_MS). `??` (not `||`) is load-bearing — `0` is a real, meaningful
 * value here ("never go dormant") and must NOT fall through to the default the
 * way `0 || IDLE_TTL_MS` would silently do.
 */
function effectiveIdleTtl(slot: LiveSlot): number {
  return slot.meta.idleTtlMs ?? IDLE_TTL_MS;
}

// True from the moment shutdownActiveSessions() starts draining until the
// process exits. Read by the child close handler to NOT start a burn-after-use
// teardown on the way down.
//
// A drain kills every child, and each of those exits looks exactly like the
// clean/idle exit that a burn is supposed to fire on (the pre-existing comment
// in the close handler says as much). Burning there is unsafe in a way burning
// on idle is not: the drainer resolves on the same close event the teardown
// starts from, so shutdown races ahead to process.exit(0) while the unlink /
// workspace rm / event purge / preview stop are still in flight — and endSession
// has ALREADY dropped the session from the checkpoint by then, so the next boot
// has no record to retry from. The result is the exact opposite of what the flag
// promises: a half-deleted session, left behind forever.
//
// Skipping it here loses nothing. The slot stays checkpointed as dormant, and
// burnRestoredSessions() destroys it completely at the next boot, where the
// teardown can actually run to completion. "A restart burns the session" still
// holds; it just happens on the way up instead of the way down.
// Never reset: the only caller is the shutdown path, and the process is exiting.
let _draining = false;

// How long a session may sit idle before its PEER SHARES are revoked. Much
// longer than the dormancy TTL on purpose: revocation is permanent (share ids are
// deleted, and resuming cannot restore them, so the host must re-invite), which
// makes it the wrong response to someone stepping out for lunch. Dormancy
// releases the preview at the short mark; this closes the door properly at the
// long one. Measured from the same session idleness clock — never from share age
// or preview traffic. Tunable via HOOOP_SESSION_SHARE_GRACE_MS (0 disables).
const SHARE_GRACE_MS = (() => {
  const raw = process.env.HOOOP_SESSION_SHARE_GRACE_MS;
  if (raw != null && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 4 * 60 * 60 * 1000; // 4 hours
})();

// ---- Auto-compaction config ----------------------------------------------
// hooop runs claude as a LOCAL (non-remote) `claude -p` subprocess. Since
// Claude Code 2.1.159, auto-compaction is silently gated OFF for such
// sessions unless CLAUDE_CODE_AUTO_COMPACT_WINDOW / autoCompactWindow /
// CLAUDE_CODE_REMOTE is set (upstream issue #64520) — so long conversations
// grow unbounded until the model errors with "Prompt is too long". We enable
// it explicitly at spawn by handing claude a per-model window + trigger pct.
//
// The window MUST be per-model: one value can't serve both a 200k model (where
// a large window means compaction never fires before the hard limit) and a 1M
// model (where a small window compacts absurdly early). The table + resolver
// live in @shared/model-windows so the sandbox (this file) and the dashboard
// (lib/model-limits.ts) can't drift. windowForModel returns null for an
// unresolvable model — callers MUST NOT substitute a guessed per-family size;
// here we fall back only to the AUTO_COMPACT_WINDOW_FLOOR for the env, and the
// init frame binds the real window once claude reports the resolved model.
// Re-exported so existing importers (and tests) keep resolving it from here.
export { windowForModel };

// Auto-compaction is ALWAYS on (hooop never lets a headless `claude -p` session
// grow until it dies with "Prompt is too long"). It needs a window to size the
// trigger against; when we can't resolve one from the model (unqualified
// default at spawn), fall back to the smallest real window so compaction still
// fires before ANY model's hard ceiling — never leave it unconfigured.
const AUTO_COMPACT_WINDOW_FLOOR = DEFAULT_WINDOW;

// Percentage of the window at which compaction fires. Tunable via
// HOOOP_AUTO_COMPACT_PCT (clamped to 1..100); defaults to 85, leaving headroom
// under the model's hard context_window_exceeded ceiling.
export function autoCompactPct(): number {
  const raw = process.env.HOOOP_AUTO_COMPACT_PCT;
  if (raw != null && raw.trim() !== "") {
    const n = Math.round(Number(raw));
    if (Number.isFinite(n) && n >= 1 && n <= 100) return n;
  }
  return 85;
}

function readModelField(file: string): string | null {
  try {
    if (!existsSync(file)) return null;
    const m = (JSON.parse(readFileSync(file, "utf-8")) as { model?: unknown }).model;
    return typeof m === "string" && m.trim() !== "" ? m.trim() : null;
  } catch {
    return null;
  }
}

// A session created WITHOUT an explicit --model falls back to claude's own
// configured default, which we can't observe until the init frame — too late to
// size the auto-compact window the process was already handed. So we resolve
// that default up-front from the same config claude reads, in claude's own
// precedence order (ANTHROPIC_MODEL env > project .claude/settings[.local].json
// > user ~/.claude/settings.json), and hand claude --model explicitly. That
// makes the window model-bound at spawn (no floor, meter == auto-compact
// window). Returns null only when NOTHING is configured anywhere — then claude
// picks its built-in default and we fall back to the safe floor.
//
// This deliberately couples to claude's config layout; hooop already owns
// ~/.claude and per-project .claude, so mirroring its resolution here is
// consistent with how tightly the two are bound.
export function resolveConfiguredModel(cwd: string): string | null {
  const env = process.env.ANTHROPIC_MODEL?.trim();
  if (env) return env;
  for (const file of [
    join(cwd, ".claude", "settings.local.json"),
    join(cwd, ".claude", "settings.json"),
    join(homedir(), ".claude", "settings.json"),
  ]) {
    const m = readModelField(file);
    if (m) return m;
  }
  return null;
}

/**
 * Lifecycle events. Subscribers (SSE stream route) get notified when sessions
 * transition between alive/dormant/ended/expired/error.
 */
export const activeSessionsBus = new EventEmitter();
activeSessionsBus.setMaxListeners(100);

const slots = new Map<string, LiveSlot>();        // canonical sessionId -> slot
const aliases = new Map<string, string>();        // any id (pending) -> canonical
let _bootDone = false;

// cwd -> expiry epoch ms. Marks a `claude --resume` whose new session_id
// hasn't landed on stdout yet. listSessions() uses this to suppress the
// transient undecorated orphan cache row during the swap window. Bounded by
// a short TTL so a crashed/never-swapped resume can't hide rows forever.
const resumingCwds = new Map<string, number>();
const RESUME_INFLIGHT_TTL_MS = 15_000;

function markResumeInFlight(cwd: string): void {
  resumingCwds.set(cwd, Date.now() + RESUME_INFLIGHT_TTL_MS);
}
function clearResumeInFlight(cwd: string): void {
  resumingCwds.delete(cwd);
}
/** True when a resume for this cwd is mid-swap (and not past its TTL). */
export function isResumeInFlight(cwd: string | undefined): boolean {
  if (!cwd) return false;
  const exp = resumingCwds.get(cwd);
  if (exp === undefined) return false;
  if (Date.now() > exp) {
    resumingCwds.delete(cwd);
    return false;
  }
  return true;
}

function canonical(id: string): string {
  return aliases.get(id) ?? id;
}
function getSlot(id: string): LiveSlot | undefined {
  return slots.get(canonical(id));
}

/**
 * Inverse alias lookup. Returns every id that has been remapped to
 * `canonicalId` — i.e. the historical ids the same conversation has been
 * known by (e.g. the pre-resume id when `claude --resume` minted a new internal
 * id). Normally empty now that a session owns its id from spawn. The dashboard
 * uses this to rebuild its `aliases` filter after a page reload so events
 * arriving under any historical id still join the transcript for the open URL.
 */
export function aliasesFor(canonicalId: string): string[] {
  const out: string[] = [];
  for (const [old, current] of aliases.entries()) {
    if (current === canonicalId) out.push(old);
  }
  return out;
}

/**
 * Returns the full set of session ids a given id is known by — the
 * canonical (resolving the id through the alias map if necessary)
 * plus every historical alias pointing at that canonical. Used by
 * `listEvents` so the initial transcript fetch for a session shows
 * every event ever logged under any of its prior ids.
 *
 * For an unknown id (not in the registry, e.g. a deleted session)
 * returns `[id]` — we have no alias info to expand with.
 */
export function expandSessionIds(id: string): string[] {
  const canonicalId = aliases.get(id) ?? id;
  const acc = new Set<string>([canonicalId]);
  for (const [old, current] of aliases.entries()) {
    if (current === canonicalId) acc.add(old);
  }
  return [...acc];
}

// ---------- Public API ----------

export function bootActiveSessions() {
  if (_bootDone) return;
  _bootDone = true;
  mkdirSync(STATE_DIR, { recursive: true });
  loadCheckpoint();
}

/**
 * Remember the spec of the preview a session is (or was) running, and why it
 * stopped.
 *
 * The spec is kept even after an explicit stop, purely so the Browser panel can
 * prefill its form with what this session used last — retyping a run command you
 * already gave us is busywork. The REASON is what the panel's wording keys off,
 * and it is cleared on any deliberate start or stop: telling someone "we stopped
 * this because the session went idle" when they stopped it themselves is worse
 * than saying nothing.
 */
export function rememberPreviewSpec(
  sessionId: string,
  spec: PreviewSpec | null,
  reason: "idle" | null,
): void {
  const slot = getSlot(sessionId);
  if (!slot) return;
  if (spec) slot.meta.lastPreviewSpec = spec;
  slot.meta.lastPreviewStoppedReason = reason;
  saveCheckpoint();
}

/** The synthetic plan reviews in a slot's pending queue (durable across restart/revive). */
function pendingReviewsOf(slot: LiveSlot): PendingPermissionRequest[] {
  return slot.pendingRequests.filter((r) => r.synthetic);
}

/**
 * Re-validate a preview spec read back from the checkpoint.
 *
 * The checkpoint is a file on disk and this spec is handed to a form and then to
 * `startPreview`, so it re-enters through the same validator every other spec
 * does rather than being trusted for having once been valid. A spec that no
 * longer passes is dropped, not repaired: the offer to restart simply disappears,
 * which is the safe direction.
 */
function restoreLastPreviewSpec(raw: unknown): PreviewSpec | null {
  if (!raw) return null;
  const parsed = validatePreviewSpec(raw);
  return parsed.ok ? parsed.spec : null;
}

/**
 * Release the preview of any session that has gone quiet.
 *
 * Keyed on SESSION idleness (`lastSeenAt`), deliberately — not on the dormancy
 * transition, and not on traffic to the preview itself. The transition is the
 * wrong hook twice over: in print mode claude exits after every turn, so
 * "dormant" is the normal state between answers rather than a sign of
 * abandonment, and `sweepIdleSessions` only scans `alive` slots, so a session
 * that answered and then sat idle for hours would never be revisited at all.
 * Idleness is the thing we actually mean.
 *
 * Why release: slots are an install-wide pool of THREE, and dormancy is where
 * sessions live. Held forever, a handful of quiet sessions own the whole pool
 * with nothing to reclaim it — and a shared preview belonging to a session nobody
 * is driving is a public app with no driver.
 *
 * The spec is remembered first (and persisted) so the dashboard can offer a
 * one-click restart. Reviving deliberately does NOT restart it: a surprise
 * `npm ci` and a silently claimed slot are worse than a button.
 *
 * Peer shares are NOT touched here — see sweepIdleShares for why they wait.
 *
 * Exported and `now`-parameterized to match sweepIdleSessions, so it is testable
 * without wall-clock. Returns the previewIds it released.
 */
export async function sweepIdlePreviews(now: number = Date.now()): Promise<string[]> {
  const released: string[] = [];
  for (const slot of [...slots.values()]) {
    if (slot.meta.turnActive) continue;            // a turn in flight is not idle
    // Per-slot, not the install constant directly — a session can shorten,
    // lengthen, or (via 0) opt entirely out of its own idle-dormancy window.
    const ttl = effectiveIdleTtl(slot);
    if (ttl <= 0) continue;                        // this session opted out
    if (now - slot.meta.lastSeenAt < ttl) continue;

    // Alias-expanded for the same reason the end/delete callers are: `claude
    // --resume` re-keys a session mid-life, and a preview minted under a prior
    // id still belongs to this conversation.
    const ids = expandSessionIds(slot.meta.sessionId);
    const rec = previewForSession(ids);
    if (!rec) continue;

    rememberPreviewSpec(slot.meta.sessionId, rec.spec, "idle");

    const reaped = await reapPreviewsForSessions(ids);
    if (reaped.length === 0) continue;
    released.push(...reaped);
    // Say it where the user is reading, not only in a log: they will come back
    // to a session whose app is no longer running and deserve to know why.
    try {
      ingestLifecycleNotice(
        slot.meta.sessionId,
        "preview-idle-release",
        "host",
        `Preview "${rec.spec.name}" was stopped because this session went idle. Its slot is free again — you can start it back up from the Browser panel.`,
      );
    } catch { /* best-effort transcript record */ }
  }
  if (released.length) {
    log.info("active-sessions", "released previews for idle sessions", { count: released.length });
  }
  return released;
}

/**
 * Revoke the peer shares of any session that has been idle past the grace window.
 *
 * Separate from the preview sweep because the two have different costs. A
 * released preview can be restarted with one click; a revoked share is GONE —
 * the id is deleted, resuming cannot restore it, and the host has to issue a
 * fresh invite. That asymmetry is the whole reason for a longer window: cutting a
 * pairing because nobody typed for half an hour would punish a lunch break, while
 * leaving a session exposed indefinitely is the thing we are trying to stop.
 *
 * Same `lastSeenAt` clock as the preview sweep, so this is session idleness and
 * not share age — an old share on an active session is left alone.
 *
 * Returns the share ids it revoked.
 */
export function sweepIdleShares(now: number = Date.now()): string[] {
  // Deliberately NOT effectiveIdleTtl/meta.idleTtlMs — a per-session dormancy
  // window is about how quickly a session goes quiet-and-resumable, which is
  // reversible. Revocation is not: it deletes the share id outright, so it must
  // stay keyed on the single install-wide SHARE_GRACE_MS for every session,
  // never inherit a short (or zero) per-session override.
  if (SHARE_GRACE_MS <= 0) return []; // disabled
  const revokedAll: string[] = [];
  for (const slot of [...slots.values()]) {
    if (slot.meta.turnActive) continue;
    if (now - slot.meta.lastSeenAt < SHARE_GRACE_MS) continue;

    const ids = expandSessionIds(slot.meta.sessionId);
    const { revoked } = revokeSharesForSession(ids);
    if (revoked.length === 0) continue;
    // A pending join for a share that no longer exists is a dead end; drop it
    // with the share, exactly as the delete-session path does.
    for (const id of revoked) dropJoinsForShare(id);
    revokedAll.push(...revoked);
    try {
      ingestLifecycleNotice(
        slot.meta.sessionId,
        "share-idle-revoke",
        "host",
        revoked.length === 1
          ? "This session had been idle for a long time, so its share link was revoked. Share it again to invite someone back in."
          : `This session had been idle for a long time, so its ${revoked.length} share links were revoked. Share it again to invite someone back in.`,
      );
    } catch { /* best-effort transcript record */ }
  }
  if (revokedAll.length) {
    log.info("active-sessions", "revoked shares for idle sessions", { count: revokedAll.length });
  }
  return revokedAll;
}

/**
 * Reap idle sessions: any alive slot with no activity for IDLE_TTL_MS and no
 * turn in flight transitions to "dormant" (the next turn revives it via
 * --resume). A slot with a live subprocess is reaped by killing its child; a
 * childless "alive" slot (one marked active by a side-channel `!bash`/`>chat`
 * via markSessionActive, which never spawns claude) is demoted directly since
 * there's no process to kill. Exported + `now`-parameterized so it's
 * unit-testable without wall-clock. Returns the ids it reaped.
 */
export function sweepIdleSessions(now: number = Date.now()): string[] {
  const reaped: string[] = [];
  const burned: string[] = [];
  let demotedDirectly = false;
  for (const slot of slots.values()) {
    if (slot.meta.status !== "alive") continue;   // dormant/ended/expired: nothing to reap
    if (slot.meta.turnActive) continue;           // never interrupt an in-flight turn
    // A pending plan review used to block reaping, from when losing it was a real
    // risk. It no longer is, and the guard cost more than it bought: such a
    // session sat in Active forever holding a live subprocess. Synthetic reviews
    // are checkpointed, nothing clears them on child close, /pending-requests
    // reads the slot rather than the child, and a decision revives the session
    // through writeUserTurn. So the card survives dormancy — which is the whole
    // point of it being durable.
    const ttl = effectiveIdleTtl(slot);
    if (ttl <= 0) continue;                        // this session opted out of dormancy
    if (now - slot.meta.lastSeenAt < ttl) continue;
    const sid = slot.meta.sessionId;
    if (slot.meta.burnAfterUse) {
      // Burn-after-use has no dormant state to land in — it destroys itself
      // instead of sitting resumable. Do NOT set reapToDormant (that flag
      // exists solely to force the close handler onto "dormant"); destroy
      // fire-and-forget instead, the same way startIdleSweeper already
      // fire-and-forgets the async preview sweep, so one slow teardown
      // (workspace rm, share revoke, preview stop) can't stall this tick or
      // the sessions still waiting behind it in this same loop. The re-entrancy
      // guard on destroySession (slot.destroying) also means the close handler
      // this triggers won't loop back here.
      //
      // Write the lifecycle before firing, for the same reason the close
      // handler's burn branch does: the teardown takes seconds (endSession
      // waits on the child), and until it lands this slot would otherwise
      // still advertise itself as "alive" — a row the dashboard offers to
      // drive, and a burn the header offers to cancel, for a session already
      // past saving. setSessionBurnAfterUse and writeUserTurn now refuse on
      // `destroying`; this is what makes the UI stop inviting it.
      slot.meta.status = "ended";
      activeSessionsBus.emit("change", { sessionId: sid, status: "ended" });
      burned.push(sid);
      void destroySession(sid).catch((e) =>
        log.warn("active-sessions", "idle burn-after-use destroy failed", {
          sessionId: sid, err: String((e as any)?.message ?? e),
        }),
      );
      continue;
    }
    if (slot.child && !slot.child.killed) {
      // A live subprocess: force the close handler to land on "dormant" (claude
      // exits non-zero on SIGTERM). Keep the slot registered so --resume can
      // revive it.
      slot.reapToDormant = true;
      killChildAsAgent(slot.child, "SIGTERM");
    } else {
      // A childless "alive" slot: it was marked active by a side-channel
      // `!bash`/`>chat` (markSessionActive) without ever spawning claude. There's
      // no process to kill — demote the lifecycle directly so the dashboard's
      // Active group returns it to Dormant now that it's gone quiet.
      slot.meta.status = "dormant";
      demotedDirectly = true;
      activeSessionsBus.emit("change", { sessionId: sid, status: "dormant" });
    }
    reaped.push(sid);
  }
  if (demotedDirectly) saveCheckpoint();
  if (reaped.length) log.info("active-sessions", "idle-reaped sessions to dormant", { count: reaped.length });
  if (burned.length) log.info("active-sessions", "idle-burned sessions (burn-after-use)", { count: burned.length });
  // Both are "ids this sweep acted on" — the existing return contract callers
  // (and this file's tests) rely on; burning is just a different action than
  // demoting, not a different category of result.
  return [...reaped, ...burned];
}

/**
 * Start the periodic idle-TTL sweeper. Called once from server startup (NOT
 * from bootActiveSessions, which fires in unit tests too — the interval is a
 * server-runtime concern). Idempotent.
 *
 * One interval drives all three sweeps: demote idle sessions, release their
 * previews, and — much later — revoke their shares. Each is independently
 * guarded, so a failure in one still lets the others run.
 *
 * Deliberately runs even when the install-wide IDLE_TTL_MS default is 0
 * (disabled): a session with its own explicit `meta.idleTtlMs` must still
 * reap on schedule — see effectiveIdleTtl — and disabling the DEFAULT must not
 * silently disable every session's ability to opt back in. The interval
 * itself costs nothing to keep running unconditionally: it ticks every 60s
 * and is unref'd (see below), so each sweep just no-ops per-slot when that
 * slot's own effective ttl happens to be 0 too.
 */
export function startIdleSweeper() {
  if (_idleSweeper) return; // idempotent
  _idleSweeper = setInterval(() => {
    try { sweepIdleSessions(); } catch (e) {
      log.warn("active-sessions", "idle sweep failed", { err: String((e as any)?.message ?? e) });
    }
    // Async, and deliberately not awaited: releasing a preview talks to a runner
    // container over HTTP, and the sweeper must not become a place where a slow
    // runner delays the next tick.
    void sweepIdlePreviews().catch((e) =>
      log.warn("active-sessions", "idle preview sweep failed", { err: String((e as any)?.message ?? e) }),
    );
    try { sweepIdleShares(); } catch (e) {
      log.warn("active-sessions", "idle share sweep failed", { err: String((e as any)?.message ?? e) });
    }
  }, IDLE_SWEEP_INTERVAL_MS);
  // Don't keep the event loop alive just for the sweeper.
  if (typeof _idleSweeper.unref === "function") _idleSweeper.unref();
}

export function listActiveSessions(): ActiveSessionMeta[] {
  return Array.from(slots.values())
    .map((s) => ({ ...s.meta }))
    .sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

export function getActiveSession(sessionId: string): ActiveSessionMeta | undefined {
  const s = getSlot(sessionId);
  return s ? { ...s.meta } : undefined;
}

/**
 * Mark a session as freshly active from a side-channel message (a `!bash`
 * shortcut or a `>` chat) — bump lastSeenAt, PROMOTE a dormant/ended slot to
 * "alive" so it surfaces in the dashboard's Active group, and broadcast a
 * `change` so every viewer's list re-groups/re-sorts.
 *
 * The session lifecycle is decoupled from the claude subprocess: "alive" here
 * means "recently in use", NOT "a child process is running". We deliberately do
 * NOT spawn claude — that is exactly what caused the dormant→alive→ended
 * print-mode flicker (`claude --resume` with no turn to run exits immediately).
 * The next real model turn lazily revives the child on its own, because both
 * writeUserTurn and wakeSession gate revival on `!slot.child`, not on status.
 * A childless "alive" slot is demoted back to "dormant" by sweepIdleSessions
 * once it's been quiet for the idle TTL, so the Active group stays honest.
 *
 * Does NOT set turnActive (no model turn is running, so it must not show
 * "thinking"). No-op for an unknown/expired session.
 */
export function markSessionActive(sessionId: string): void {
  const slot = getSlot(sessionId);
  // A provisioning (still-cloning) or errored session must never be promoted to
  // "alive" by a side-channel `!bash`/`>chat` — that would flip it drivable
  // before its workspace exists. Expired is terminal. All are no-ops here.
  // `destroying` joins them: promoting a session back to "alive" while its
  // burn-after-use teardown runs would put a row the dashboard reads as drivable
  // on top of a workspace being deleted.
  if (
    !slot ||
    slot.destroying ||
    slot.meta.status === "expired" ||
    slot.meta.status === "provisioning" ||
    slot.meta.status === "error"
  ) return;
  slot.meta.lastSeenAt = Date.now();
  // Promote to "alive" on the transition only (status !== "alive"), so a
  // streaming `!bash` that calls this every ~500ms doesn't re-checkpoint or
  // re-log on every flush once the slot is already active.
  if (slot.meta.status !== "alive") {
    slot.meta.status = "alive";
    // A dormant/ended slot has, by definition, already exited (the close handler
    // is what set that status), yet slot.child lingers as a stale reference with
    // killed=false — the codebase's liveness invariant is the STATUS, not the
    // child handle. Drop the stale handle so this childless "alive" slot is
    // unambiguous: writeUserTurn/wakeSession --resume on the next real turn
    // (they gate on !slot.child), and sweepIdleSessions demotes it directly
    // instead of SIGTERM-ing a dead pid.
    slot.child = undefined;
    saveCheckpoint();
  }
  activeSessionsBus.emit("change", { sessionId: slot.meta.sessionId, status: slot.meta.status });
}

export function isControllable(sessionId: string): boolean {
  const s = getSlot(sessionId);
  // Anything that's still "ours" (in the registry) and not terminally expired
  // counts as controllable — writeUserTurn revives via --resume if the slot
  // is dormant or its subprocess has ended. Print-mode built-in slash commands
  // exit the subprocess after one frame, so "ended" sessions must remain
  // writable or we'd silently drop the user into a spawn-new branch.
  // A "provisioning" session (git clone still running) is NOT yet drivable — it
  // becomes controllable only once it flips to "alive".
  return !!s && s.meta.status !== "expired" && s.meta.status !== "provisioning";
}

export function isAlive(sessionId: string): boolean {
  const s = getSlot(sessionId);
  return !!s && s.meta.status === "alive" && !!s.child && !s.child.killed;
}

/**
 * Derive a safe workspace subdirectory name from a git URL: take the last path
 * segment, drop a trailing `.git`, strip any query/fragment, and keep only
 * filesystem-safe characters. Falls back to "repo" if nothing usable remains.
 */
export function repoDirNameFromUrl(gitRepo: string): string {
  let tail = gitRepo.trim();
  tail = tail.split(/[?#]/)[0]; // drop query/fragment
  tail = tail.replace(/\/+$/, ""); // trailing slashes
  tail = tail.split(/[/:]/).pop() ?? ""; // last path/scp segment
  tail = tail.replace(/\.git$/i, "");
  tail = tail.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");
  // Reject "." / ".." / all-dots so the target can't resolve to WORKSPACE_DIR
  // itself or its parent.
  if (!tail || /^\.+$/.test(tail)) return "repo";
  return tail;
}

// Bound how much clone-progress text a provisioning slot holds and how often
// a single progress chunk is allowed to trigger an SSE "change" fan-out — git
// can emit a `\r`-updated progress line dozens of times a second, and every
// emit wakes every connected dashboard client to re-fetch the session list.
const CLONE_PROGRESS_MAX_CHARS = 8_000;
const CLONE_PROGRESS_EMIT_THROTTLE_MS = 300;
const CLONE_TIMEOUT_MS = 5 * 60_000;

/**
 * Clone `gitRepo` into `targetDir` (a fresh, session-private path) and return
 * it. Each session gets its own clone — there is no cross-session reuse.
 *
 * Spawned (not execFile) so we can stream git's `--progress` output into
 * `slot.meta.cloneProgress` as it arrives — a multi-minute clone of a large
 * repo otherwise looks frozen behind a bare spinner. Async so a slow clone
 * can't block the single-threaded server event loop — that would stall every
 * other session, the SSE fan-out, and the permission-gate long-polls. We
 * clone into a temp sibling and rename it into place on success, so a
 * failed/partial clone never leaves a poisoned tree at the session cwd.
 */
async function cloneRepoIntoWorkspace(sessionId: string, gitRepo: string, targetDir: string): Promise<string> {
  const parent = dirname(targetDir);
  mkdirShared(parent);
  const tmp = join(parent, `.clone-${randomUUID()}`);
  log.info("active-sessions", "git clone", { gitRepo, targetDir });

  let lastEmit = 0;
  const onOutput = (chunk: Buffer) => {
    const slot = slots.get(sessionId);
    if (!slot || slot.meta.status !== "provisioning") return;
    // git rewrites its progress line in place with `\r` on a real terminal;
    // normalize that to `\n` so each update reads as its own line in the
    // dashboard's log frame instead of collapsing onto one line.
    const combined = (slot.meta.cloneProgress ?? "") + chunk.toString("utf-8").replace(/\r/g, "\n");
    slot.meta.cloneProgress =
      combined.length > CLONE_PROGRESS_MAX_CHARS ? combined.slice(-CLONE_PROGRESS_MAX_CHARS) : combined;
    const now = Date.now();
    if (now - lastEmit < CLONE_PROGRESS_EMIT_THROTTLE_MS) return;
    lastEmit = now;
    activeSessionsBus.emit("change", { sessionId, status: "provisioning" });
  };

  let stderrTail = "";
  let timedOut = false;
  try {
    await new Promise<void>((resolve, reject) => {
      // `--` guards against a URL that looks like a flag. `--progress` forces
      // git to report progress even though stderr isn't a TTY (it otherwise
      // stays silent to a pipe). Inherits process env so GH_TOKEN (forwarded
      // by the launcher) is available for gh-authed https.
      // As the model's uid: the clone IS the tree claude then edits, and a repo
      // owned by the server would make every `git` call the model makes fail
      // "dubious ownership" — including the ones from its own Bash tool, which
      // no `-c safe.directory` in lib/git.ts can reach.
      const child = spawnAsAgent("git", ["clone", "--progress", "--", gitRepo, tmp], {
        cwd: parent,
        env: process.env,
      });
      const killTimer = setTimeout(() => {
        timedOut = true;
        killChildAsAgent(child, "SIGTERM");
      }, CLONE_TIMEOUT_MS);
      child.stderr?.on("data", (d: Buffer) => {
        stderrTail = (stderrTail + d.toString("utf-8")).slice(-4_000);
        onOutput(d);
      });
      child.stdout?.on("data", onOutput);
      child.on("error", (e) => {
        clearTimeout(killTimer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(killTimer);
        if (code === 0) resolve();
        else reject(new Error(timedOut ? "git clone timed out" : stderrTail.trim() || `git clone exited with code ${code}`));
      });
    });
  } catch (e: any) {
    rmSync(tmp, { recursive: true, force: true });
    throw new Error(`git clone failed: ${e?.message || "unknown error"}`);
  }
  // Swap the finished clone into the session cwd. The caller pre-created the
  // session-private root but not `targetDir` itself; remove any stray remnant
  // defensively before the rename.
  rmSync(targetDir, { recursive: true, force: true });
  renameSync(tmp, targetDir);
  return targetDir;
}

/**
 * Spawn a fresh controllable session. No initial prompt; the first user turn
 * arrives via writeUserTurn().
 */
export async function startNewConversation(opts: {
  // Optional git URL cloned into the workspace on start; the clone becomes the
  // session cwd. This is what the dashboard sends now (folder selection is gone).
  gitRepo?: string | null;
  // Explicit working directory. No longer settable from the dashboard, but kept
  // for internal callers/tests and honored when no gitRepo is given.
  cwd?: string;
  label?: string;
  name?: string | null;
  model?: string | null;
  runId?: string | null;
  via?: "new-conversation" | "skill";
  // Skill/command name + args when via === "skill" (see startSkillSession).
  skill?: string | null;
  skillArgs?: string | null;
  // Per-session idle-dormancy override (null/absent = install default, 0 =
  // never) and burn-after-use, set once at creation time. See
  // ActiveSessionMeta.idleTtlMs / .burnAfterUse for the full semantics.
  idleTtlMs?: number | null;
  burnAfterUse?: boolean;
}): Promise<{ sessionId: string; meta: ActiveSessionMeta }> {
  bootActiveSessions();
  const gitRepo = opts.gitRepo?.trim() || null;
  const label = opts.label || "new conversation";
  const via = opts.via || "new-conversation";
  const runId = opts.runId ?? null;
  const model = opts.model?.trim() || null;
  // Always seed a haiku-style label so sessions land in the sidebar with a
  // memorable name (and so the dashboard's transcript header has something
  // to render immediately, rather than waiting for the first prompt). User
  // can rename via PATCH /sessions/:id at any time.
  const displayName = opts.name?.trim() || randomSessionName();
  const base = {
    label, displayName, model, via, runId,
    skill: opts.skill ?? null,
    skillArgs: opts.skillArgs ?? null,
    // Threaded through both the explicit-cwd path and the per-session-dir path
    // below (including the provisioning phase — see NewSessionBase), so a
    // git-clone session that's still cloning already carries the choice the
    // host made when the clone finishes and the real slot spawns.
    idleTtlMs: opts.idleTtlMs ?? null,
    burnAfterUse: opts.burnAfterUse ?? false,
  };

  // An explicit cwd (internal callers / tests / HOOOP_RUN_CWD) bypasses the
  // per-session-dir machinery and runs where it's told.
  const explicitCwd = opts.cwd || process.env.HOOOP_RUN_CWD || null;
  if (explicitCwd) {
    return spawnControllable({ cwd: explicitCwd, ...base, resumeSessionId: null });
  }

  // Every dashboard session gets its OWN private workdir under SESSIONS_ROOT,
  // named by its (up-front minted) session id — never the shared workspace.
  const sessionId = randomUUID();

  if (gitRepo) {
    // Async provisioning: the clone can take minutes, so we DON'T block the
    // response on it. Register a "provisioning" placeholder (visible in the UI
    // as "cloning…", but not drivable), return immediately, and clone in the
    // background. The session flips to "alive" once the repo lands (or "error"
    // if the clone fails). The repo becomes the cwd, nested under the session's
    // private root so deleting the session removes the whole tree.
    const cwd = join(sessionWorkdir(sessionId), repoDirNameFromUrl(gitRepo));
    mkdirShared(sessionWorkdir(sessionId));
    const meta = registerProvisioningSlot({ sessionId, cwd, ...base });
    void provisionGitSession(sessionId, gitRepo, cwd, base);
    return { sessionId, meta };
  }

  // Non-git: the private dir is created instantly, so spawn synchronously under
  // the id we already minted (no provisioning phase needed).
  const cwd = sessionWorkdir(sessionId);
  mkdirShared(cwd);
  return spawnControllable({ cwd, ...base, resumeSessionId: null, freshSessionId: sessionId });
}

/** Options shared by startNewConversation, the provisioning slot, and the
 *  deferred spawn once a clone completes. */
interface NewSessionBase {
  label: string;
  displayName: string | null;
  model: string | null;
  via: ActiveSessionMeta["via"];
  runId: string | null;
  skill: string | null;
  skillArgs: string | null;
  // See ActiveSessionMeta.idleTtlMs / .burnAfterUse. Carried through the
  // provisioning phase too, so a git-clone session's choice survives the clone.
  idleTtlMs: number | null;
  burnAfterUse: boolean;
}

/**
 * Register a childless "provisioning" placeholder slot so a git-clone session is
 * visible (and shows a "cloning…" state) the instant it's created, before the
 * clone finishes. It is deliberately NOT checkpointed — there is nothing to
 * resume, and the clone child dies with the process — so a mid-clone restart
 * simply drops the row (the dashboard's dead-session guard clears it).
 */
function registerProvisioningSlot(opts: { sessionId: string; cwd: string } & NewSessionBase): ActiveSessionMeta {
  const now = Date.now();
  const meta: ActiveSessionMeta = {
    sessionId: opts.sessionId,
    runId: opts.runId,
    label: opts.label,
    displayName: opts.displayName,
    cwd: opts.cwd,
    via: opts.via,
    skill: opts.skill,
    skillArgs: opts.skillArgs,
    startedAt: now,
    lastSeenAt: now,
    status: "provisioning",
    model: opts.model,
    ...(opts.idleTtlMs != null ? { idleTtlMs: opts.idleTtlMs } : {}),
    ...(opts.burnAfterUse ? { burnAfterUse: true } : {}),
  };
  slots.set(opts.sessionId, {
    meta,
    writeQueue: Promise.resolve(),
    outBuf: "",
    outBufBytes: 0,
    pendingRequests: [],
    pendingAuthors: [],
    currentTurn: null,
    trustedShareIds: new Set(),
  });
  activeSessionsBus.emit("change", { sessionId: opts.sessionId, status: "provisioning" });
  return { ...meta };
}

/**
 * Background worker for a git-clone session: clone the repo, then spawn claude
 * under the SAME id into the clone dir (flipping the slot "alive"). On failure,
 * mark the slot "error" (with the git stderr on meta.errorMessage) and clean up
 * the pre-created session dir. Never throws — it owns its own error surface.
 */
async function provisionGitSession(
  sessionId: string,
  gitRepo: string,
  cwd: string,
  base: NewSessionBase,
): Promise<void> {
  try {
    await cloneRepoIntoWorkspace(sessionId, gitRepo, cwd);
    // The user may have deleted the session while it was cloning; only proceed
    // if the provisioning placeholder is still present and still provisioning.
    const slot = slots.get(sessionId);
    if (!slot || slot.meta.status !== "provisioning") {
      // Deleted mid-clone: drop the freshly-cloned tree we no longer own.
      try { rmSync(sessionWorkdir(sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
      return;
    }
    // Drop the placeholder and spawn the real child under the same id.
    slots.delete(sessionId);
    await spawnControllable({ cwd, ...base, resumeSessionId: null, freshSessionId: sessionId });
  } catch (e: any) {
    const message = e?.message ?? "git clone failed";
    // Remove the (empty / partially-populated) session dir; cloneRepoIntoWorkspace
    // already dropped its own temp clone.
    try { rmSync(sessionWorkdir(sessionId), { recursive: true, force: true }); } catch { /* ignore */ }
    const slot = slots.get(sessionId);
    if (slot) {
      slot.meta.status = "error";
      slot.meta.errorMessage = message;
      activeSessionsBus.emit("change", { sessionId, status: "error" });
      activeSessionsBus.emit("error", { sessionId, message });
    }
    log.warn("active-sessions", "git provisioning failed", { sessionId, gitRepo, err: String(message) });
  }
}

const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_:/-]{0,127}$/;

/** True for a syntactically valid skill/command token. */
export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

function skillIsKnown(name: string): boolean {
  const raw = name.startsWith("/") ? name.slice(1) : name;
  for (const s of listSkills()) if (s.name === raw) return true;
  for (const c of listSlashCommands()) if (c.name === raw) return true;
  return false;
}

/**
 * Launch a skill/command as a REGULAR controllable session.
 *
 * A skill run used to be a detached `claude -p` subprocess (lib/spawn.ts): that
 * produced a Claude session the dashboard could display but never control, so
 * `/stop` couldn't find it ("unknown session"), `/model` didn't apply, and the
 * transcript rendered a clumsy "Use the X skill:" prose turn. Skills are just
 * regular sessions — so we spawn a normal slot and deliver the invocation as its
 * first user turn, verbatim: `/<skill> <args>`. Everything else (interrupt,
 * model switch, subagent filtering, sharing) then works uniformly. Host-only at
 * the route layer; peers cannot trigger skill sessions.
 */
export async function startSkillSession(
  skill: string,
  args?: string,
  author: string = "host",
): Promise<{ sessionId: string }> {
  if (!isValidSkillName(skill)) throw new Error(`invalid skill name: ${skill}`);
  if (!skillIsKnown(skill)) throw new Error(`unknown skill or command: ${skill}`);

  // Strip control chars; keep it a single clean line of args.
  const sanitizedArgs = (args ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").trim();
  const base = skill.includes(":") ? skill.slice(skill.indexOf(":") + 1) : skill;

  const { sessionId } = await startNewConversation({
    via: "skill",
    name: base,      // seed the sidebar name; the skill badge comes from skill/skillArgs
    label: base,
    skill,
    skillArgs: sanitizedArgs || null,
  });

  // Deliver the invocation as the first turn. The leading slash makes claude run
  // it as the slash command (skills invoke as `/<plugin>:<skill>`); kind
  // "command" renders it as a clean command card instead of a chat bubble.
  const invocation = sanitizedArgs ? `/${skill} ${sanitizedArgs}` : `/${skill}`;
  await writeUserTurn(sessionId, invocation, author, null, { kind: "command" });
  return { sessionId };
}

export function renameSession(sessionId: string, name: string): ActiveSessionMeta | null {
  const slot = getSlot(sessionId);
  if (!slot) return null;
  slot.meta.displayName = name.trim() || null;
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: slot.meta.sessionId, status: slot.meta.status });
  return { ...slot.meta };
}

/**
 * Wake (or eagerly spawn) the subprocess for a known sessionId. Used by the
 * lazy-revive path when the user types into a dormant session.
 */
export async function wakeSession(sessionId: string): Promise<ActiveSessionMeta> {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  const canonicalId = slot.meta.sessionId;
  if (slot.meta.status === "alive" && slot.child && !slot.child.killed) {
    return { ...slot.meta };
  }
  if (slot.meta.status === "expired") {
    throw new Error(`session expired: ${canonicalId}`);
  }
  // Mid-teardown (see destroySession): resuming a session whose transcript is
  // being unlinked would spawn a child against a file that is disappearing, and
  // would resurrect a session the host asked to be destroyed.
  if (slot.destroying) throw new Error(`session is being deleted: ${canonicalId}`);

  // Re-apply cwd policy on revival. The policy may have been tightened since
  // the session was originally created, or the checkpoint file may have been
  // tampered with. Fail closed: prune the entry and refuse to spawn.
  const cwdCheck = isCwdAllowed(slot.meta.cwd);
  if (!cwdCheck.ok) {
    const reason = cwdCheck.reason;
    log.warn("active-sessions", "dormant session cwd no longer allowed; pruning", {
      sessionId: canonicalId,
      cwd: slot.meta.cwd,
      reason,
    });
    // Reap BEFORE dropping the slot and its aliases. Once the alias map loses
    // them, reapPreviewsForSessions can no longer resolve a preview minted under
    // a prior id — the slot would stay held by a session that no longer exists,
    // with nothing able to claim it back. Fire-and-forget: expiry must still
    // happen even if the runner is unreachable.
    void reapPreviewsForSessions(expandSessionIds(canonicalId)).catch((e) =>
      log.warn("active-sessions", "could not release the preview of an expired session", {
        sessionId: canonicalId,
        err: String(e?.message ?? e),
      }),
    );
    slots.delete(canonicalId);
    for (const [alias, target] of aliases.entries()) {
      if (target === canonicalId) aliases.delete(alias);
    }
    saveCheckpoint();
    activeSessionsBus.emit("change", { sessionId: canonicalId, status: "expired" });
    throw new Error(`session cwd no longer allowed (${reason}): ${canonicalId}`);
  }

  // Resume the id whose transcript actually exists on disk — NOT blindly the
  // canonical id. `claude --resume <id>` only continues the conversation if it
  // finds ~/.claude/projects/<cwd-slug>/<id>.jsonl; given a missing id it exits
  // 1 ("No conversation found"). Earlier builds resumed the canonical (latest
  // swapped) id, which often had no transcript, so every wake spawned an empty
  // session, minted yet another id (growing the alias chain unboundedly), lost
  // the real conversation context, and left usage/ctx near-zero. Pick the
  // transcript-bearing id (newest, if several), re-key the registry so it
  // becomes canonical, and resume THAT — claude keeps the id and continues.
  //
  // findResumableId returns null when NO transcript exists for the id or any
  // alias. That is NOT an error and must NOT prune the slot: a session can be
  // created (dashboard "new session") and go dormant across a sandbox restart
  // before it ever ran a turn, so it legitimately has no history yet. Instead of
  // failing the turn, we start a FRESH session under the SAME id below
  // (--session-id, not --resume): the dashboard is watching that id, so the
  // conversation simply begins now and the queued turn lands.
  const resumeId = findResumableId(canonicalId);
  if (resumeId !== null && resumeId !== canonicalId) {
    rekeyCanonical(canonicalId, resumeId);
  }

  // CRITICAL: forward the existing displayName. Without this the new slot
  // starts with displayName=null, the sidebar falls back to cwd basename,
  // and the auto-name-from-first-prompt logic then rewrites it — a visible
  // name ping-pong on every revive.
  const { meta } = await spawnControllable({
    cwd: slot.meta.cwd,
    label: slot.meta.label,
    displayName: slot.meta.displayName,
    // Re-apply the configured model on every resume. Without this a woken
    // session silently reverts to the user's default `--model`, so a `/stop`
    // (or any dormancy) would quietly undo a `/model` switch.
    model: slot.meta.model,
    // Same rationale for auto mode — carry it so a woken session doesn't silently
    // revert to prompting for every tool.
    autoMode: slot.meta.autoMode,
    // Same rationale again: a fresh spawn builds fresh meta, so without carrying
    // these a revive would silently fall back to the install-wide idle default
    // and/or drop the self-destruct choice.
    idleTtlMs: slot.meta.idleTtlMs,
    burnAfterUse: slot.meta.burnAfterUse,
    via: "resumed",
    runId: slot.meta.runId,
    skill: slot.meta.skill,
    skillArgs: slot.meta.skillArgs,
    resumeSessionId: resumeId,
    // No transcript to resume → start a fresh session under the SAME id (see
    // above) so the dashboard's session URL stays valid and the turn is
    // delivered. Ignored by spawnControllable when resumeSessionId is set.
    freshSessionId: resumeId === null ? canonicalId : null,
    // Forward cumulative totals so they accumulate across the
    // dormant→awake transition. The result-frame handler adds to
    // existing.totals; without this, the new spawn starts at zeros
    // and the dashboard's running totals visibly reset every wake.
    carryStats: slot.meta.lastStats ?? null,
    // Carry any plan review awaiting approval into the fresh slot — the old
    // slot (and its pendingRequests) is dropped when spawnControllable registers
    // the new one, so without this a revive would lose the pending plan.
    carryPending: pendingReviewsOf(slot),
  });
  return meta;
}

/**
 * Among a session's canonical id and all its historical aliases, return the id
 * whose transcript file exists on disk, preferring the most recently written
 * one. Returns `null` when NO transcript exists for the canonical id or any
 * alias. `claude --resume <id>` on a transcript-less id exits with "No
 * conversation found with session ID" and silently drops the turn, so callers
 * MUST treat null specially: start a fresh session under the same id
 * (--session-id) rather than blindly --resume it. A null return is NOT an error
 * — a session created but never prompted legitimately has no transcript yet.
 */
function findResumableId(canonicalId: string): string | null {
  const candidates = new Set<string>([canonicalId, ...aliasesFor(canonicalId)]);
  let best: { id: string; mtimeMs: number } | null = null;
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const proj of readdirSync(PROJECTS_DIR)) {
        for (const id of candidates) {
          try {
            const m = statSync(join(PROJECTS_DIR, proj, `${id}.jsonl`)).mtimeMs;
            if (!best || m > best.mtimeMs) best = { id, mtimeMs: m };
          } catch { /* this id has no transcript in this project dir */ }
        }
      }
    } catch { /* ignore */ }
  }
  return best?.id ?? null;
}

/**
 * Re-key a dormant slot from `fromId` to `toId` (one of its aliases that we're
 * about to resume). Drops the stale slot, repoints every alias of `fromId` to
 * `toId`, makes `fromId` itself an alias of `toId`, and stops `toId` from being
 * its own alias. After this, getSlot(anyHistoricalId) still resolves.
 */
function rekeyCanonical(fromId: string, toId: string): void {
  slots.delete(fromId);
  aliases.delete(toId);
  for (const [a, target] of aliases.entries()) {
    if (target === fromId) aliases.set(a, toId);
  }
  aliases.set(fromId, toId);
}

/**
 * Write one user turn to a session's stdin. Wakes a dormant session first.
 * Serialised per sessionId so concurrent writes don't interleave JSON frames.
 */
// Tools permitted DURING a plan turn — the read-only investigation set, mirror
// of permission-gate.sh's fast-allow list (minus Bash/ExitPlanMode, which route
// to the sandbox policy). Anything not here is hard-denied while planning.
const PLAN_READONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "ToolSearch", "WebFetch", "WebSearch", "NotebookRead", "TodoWrite",
]);

// Read-only tools that take a PATH, and so can be answered here without a
// dashboard card as long as the path stays inside the session's workdir. This
// is the subset of permission-gate.sh's old fast-allow list that touches the
// filesystem; the rest (ToolSearch, TodoWrite, WebFetch, WebSearch) have no
// path to check and stay fast-allowed in the hook itself.
const READ_FAST_LANE_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);

// Appended to the session's system prompt at spawn (`--append-system-prompt`,
// see the arg builder). This is a STANDING behavior rule, not a per-turn
// message: it never appears in the transcript, and it's phrased conditionally so
// it's inert on ordinary turns and only takes effect once the session is in plan
// mode. Its one job is to stop the model from ending a plan turn with the plan
// written as prose instead of submitted via the tool — the only action that
// actually surfaces a review. It names `submit_plan` unqualified (the model
// resolves it to the namespaced MCP tool) and deliberately omits enter_plan_mode:
// `/plan` engages plan mode via the set_permission_mode flip, so telling the
// model to re-enter it only invites confusion.
const PLAN_SYSTEM_PROMPT =
  "When this session is in plan mode (read-only: edits, shell commands, and " +
  "subagents are blocked), you MUST finish the turn by calling the `submit_plan` " +
  "tool with your full plan — a concise numbered list of steps, the files/areas " +
  "you'd touch, and how you'd verify it. Describing the plan as an ordinary " +
  "message does NOT submit it: a plan is captured for human review only when you " +
  "call `submit_plan`. Investigate first with Read/Grep/Glob, then submit.";

/**
 * Standing steer about where scratch goes.
 *
 * Measured on a real auto-mode session: 30 of 72 permission cards were the agent
 * writing screenshots and helper scripts to `/tmp/…` and then reading them back.
 * Every read escalated to a human, because `/tmp` is outside the session workdir —
 * which is true, and completely beside the point: it was the agent's own output.
 *
 * The session workdir has always been writable without a prompt. The model used
 * `/tmp` out of habit, so this is a habit fix rather than a policy one, and it costs
 * nothing in containment: both directories named here are inside the boundary
 * already (the workdir by definition, the scratch dir by sessionScratchDir).
 *
 * `{{SCRATCH}}` is substituted per session, because the blessed path is
 * per-session — a shared `/tmp` allowance would let one session read another's
 * scratch, and every session in an install shares one container.
 */
const SCRATCH_SYSTEM_PROMPT =
  "Keep temporary files inside this session's own directories: your working " +
  "directory for anything related to the task, or {{SCRATCH}} for throwaway " +
  "scratch (screenshots, one-off scripts, intermediate output). Both are writable " +
  "without asking. Writing or reading elsewhere — /tmp directly, another " +
  "session's folder, anything outside your working directory — interrupts the " +
  "human for approval every time, so prefer these two even for files you intend " +
  "to delete straight after.";

// The interactive tools headless mode lacks come from the bundled hooop MCP
// server (see plugins/hooop/.mcp.json + mcp/tools-server.mjs). Claude namespaces
// plugin MCP tools as `mcp__plugin_hooop_tools__<tool>`; we match tolerantly
// (endsWith + "hooop") so the exact namespacing (plugin/server id) can't silently
// break capture. The bare native names ("ExitPlanMode", "AskUserQuestion") are
// accepted too — absent in headless mode today, but kept so the wiring still
// fires if a future claude re-exposes them.
function isPlanSubmitTool(name: string): boolean {
  return name === "ExitPlanMode" || (name.includes("hooop") && name.endsWith("__submit_plan"));
}
function isEnterPlanTool(name: string): boolean {
  return name.includes("hooop") && name.endsWith("__enter_plan_mode");
}

/**
 * Which live-preview tool this is, if any. Matched the same suffix-wise way as
 * the plan tools so the exact MCP namespacing can't silently break the wiring.
 *
 * There is no native equivalent for any of these — they drive hooop's own
 * preview-runner containers — so unlike the plan/ask tools there is no bare
 * name to also accept.
 */
export type PreviewToolAction = "start" | "share" | "restart" | "rebuild" | "stop" | "list";
const PREVIEW_TOOL_SUFFIXES: ReadonlyArray<[string, PreviewToolAction]> = [
  ["__start_preview", "start"],
  ["__share_preview", "share"],
  ["__restart_preview", "restart"],
  ["__rebuild_preview", "rebuild"],
  ["__stop_preview", "stop"],
  ["__list_previews", "list"],
];
function previewToolAction(name: string): PreviewToolAction | null {
  if (!name.includes("hooop")) return null;
  for (const [suffix, action] of PREVIEW_TOOL_SUFFIXES) {
    if (name.endsWith(suffix)) return action;
  }
  return null;
}

/**
 * Which page-driving tool this is, if any.
 *
 * Matched the same way, and mapped to the action name the injected driver
 * understands — the MCP tool is `page_click`, the thing the page runs is
 * `click`, and keeping the translation here means the browser-side vocabulary
 * is not pinned to hooop's MCP namespacing.
 */
const PAGE_TOOL_SUFFIXES: ReadonlyArray<[string, string]> = [
  ["__page_snapshot", "snapshot"],
  ["__page_click", "click"],
  ["__page_type", "type"],
  ["__list_page_tools", "list_tools"],
  ["__call_page_tool", "call_tool"],
];
function pageToolAction(name: string): string | null {
  if (!name.includes("hooop")) return null;
  for (const [suffix, action] of PAGE_TOOL_SUFFIXES) {
    if (name.endsWith(suffix)) return action;
  }
  return null;
}
// The MCP ask tool is normalized to the native "AskUserQuestion" toolName in
// createPermissionRequest, so ALL the existing AskUserQuestion wiring (dashboard
// routing, capability gating, the deny+follow-up-turn answer relay) works
// unchanged — only the trigger (a callable tool) is new.
function isAskUserQuestionTool(name: string): boolean {
  return name === "AskUserQuestion" || (name.includes("hooop") && name.endsWith("__ask_user_question"));
}

/** A base64 image attached to a user turn — becomes an image content block. */
export interface TurnImage {
  media_type: string;
  data: string;
}

export async function writeUserTurn(
  sessionId: string,
  text: string,
  author: string = "host",
  shareId: string | null = null,
  opts?: { mode?: "plan" | "bypassPermissions" | "default"; images?: TurnImage[]; thumbnails?: TurnImage[]; kind?: string | null; autoAllowRun?: boolean },
): Promise<{ sessionId: string }> {
  bootActiveSessions();
  let slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  if (slot.meta.status === "expired") throw new Error(`session expired: ${slot.meta.sessionId}`);
  // A burn-after-use teardown is in flight (see destroySession). The slot is
  // still reachable — deleteSession -> endSession takes seconds — but its stdin
  // is already ended and its transcript, workspace and events are being
  // deleted. Refuse loudly instead of writing into it: the alternative is a
  // turn that either dies on a closed pipe or, worse, revives the session via
  // --resume against a transcript that is being unlinked underneath it.
  if (slot.destroying) throw new Error(`session is being deleted: ${slot.meta.sessionId}`);

  // Lazy revive
  const needsRevive = slot.meta.status !== "alive" || !slot.child || slot.child.killed;
  if (needsRevive) {
    await wakeSession(slot.meta.sessionId);
    slot = getSlot(sessionId)!;
  }
  const beforeId = slot.meta.sessionId;
  // Mark the turn in flight and broadcast it, so the "model is thinking"
  // indicator lights up for every connected peer (and late joiners, who read
  // it off the session row) — not just whoever's client saw the UserPromptSubmit
  // event. Cleared on the result frame or on child exit. The "change" emit
  // triggers a sessions refresh that carries turnActive to all viewers.
  // Was a turn ALREADY running when this one arrived? That makes this a
  // steering message typed while the model works, and claude handles those
  // differently — see the queued-command branch below. Read before the flag is
  // set, or every turn looks mid-turn.
  const wasMidTurn = slot.meta.turnActive === true;
  slot.meta.turnActive = true;
  activeSessionsBus.emit("change", { sessionId: beforeId, status: slot.meta.status });
  // Record the author for attribution, in stdin order. Bounded so a missed
  // UserPromptSubmit (crash mid-turn) can't grow the queue unboundedly.
  // `/plan [task]` runs this ONE turn in plan mode: we flip the persistent
  // session to plan via a stdin control_request before the turn, so the agent
  // proposes a plan instead of acting. Because the session was spawned
  // bypassPermissions, plan mode reverts to bypassPermissions once the plan is
  // approved — preserving the hook-as-sole-gate invariant. Claude's built-in
  // /plan is TUI-only, so we intercept the keyword here. `opts.mode` lets an
  // internal caller (plan approve/reject) set the mode explicitly.
  const planMatch = /^\/plan\b[ \t]*([\s\S]*)$/.exec(text.trimStart());
  const mode = opts?.mode ?? (planMatch ? "plan" : undefined);
  // Forward the user's task VERBATIM (just the `/plan` prefix stripped). We do
  // NOT prepend a planning brief to the turn: that would land in the model's
  // real conversation and read like a system prompt bolted onto the user's
  // message. The steering that makes the model finish via submit_plan instead
  // of describing the plan in prose lives in the session's appended system
  // prompt (PLAN_SYSTEM_PROMPT, passed at spawn) — invisible to the transcript
  // and inert outside plan mode. Enforcement is separate and mechanical: the
  // set_permission_mode flip (below) makes the session read-only and the gate
  // captures the plan on submit_plan/ExitPlanMode. A bare `/plan` with no task
  // can't forward an empty turn, so it gets a minimal neutral nudge.
  const planTask = planMatch ? planMatch[1].trim() : "";
  const turnText = planMatch
    ? planTask || "Propose a plan for the task we've been discussing."
    : text;

  // Slash-command turns get tagged `kind: "command"` so the transcript can
  // render them distinctly (a command card, not an ordinary chat bubble). We
  // also carry the ORIGINAL typed text as `promptOverride`: for `/plan` the
  // sandbox forwards only the stripped task to the model, so claude's
  // UserPromptSubmit hook records the task WITHOUT the `/plan` prefix. Without
  // the override the transcript's optimistic row (which holds "/plan …") never
  // reconciles with the real event (which holds "…"), and the message shows up
  // twice. Restoring the typed text here fixes the dupe at the source and keeps
  // the history/peers correct too. Command detection is authoritative: the
  // leading token must match a known slash command (or the `/plan` intercept),
  // so a normal message that merely starts with "/" (e.g. a path) isn't tagged.
  const commandName = /^\/([a-zA-Z][\w:-]*)/.exec(text.trimStart())?.[1] ?? null;
  const isCommandTurn =
    !opts?.kind &&
    commandName != null &&
    (commandName === "plan" || listSlashCommands(slot.meta.cwd).some((c) => c.name === commandName));
  const turnKind = opts?.kind ?? (isCommandTurn ? "command" : null);
  let promptOverride = isCommandTurn ? text.trim() : undefined;
  // Native claude commands (/compact, /cost) only run when the leading `/` sits
  // at byte 0 of the input frame — claude's non-interactive dispatcher keys on
  // that. So they must be forwarded BARE, bypassing the `[Session context: …]`
  // attribution prefix below (which would shove the slash off byte 0 and make
  // claude treat the command as ordinary chat — burning a model turn on a
  // "the user typed /compact" reply and never actually compacting). Verified
  // empirically against claude-code v2.1.218.
  // Never bare-dispatch a command that arrived with an image: the image rides
  // as the first content block, pushing the slash off byte 0 so claude wouldn't
  // run the command anyway. The composer already blocks attaching an image to a
  // command; this guards peer/API callers too. Such a turn falls through to the
  // ordinary prefixed path (image + text reach the model as a normal turn).
  const hasTurnImages = (opts?.images?.length ?? 0) > 0;
  const isNativePassthrough =
    isCommandTurn && commandName != null && NATIVE_PASSTHROUGH_COMMANDS.has(commandName) && !hasTurnImages;

  // Turn attribution: every turn carries an authoritative author, resolved at
  // the API boundary by checkParticipant — either "host" (the session operator)
  // or a peer's display name. We ALWAYS prepend a short sender line to the text
  // the MODEL receives so it knows WHO is asking on every turn: without it, after
  // a run of peer turns the model keeps attributing later host turns to that peer
  // (and vice-versa). This is a factual tag, not a directive — the model need not
  // address anyone by name, just track who's speaking. The steering is prepended
  // ONLY to modelText; the transcript keeps exactly what was typed via
  // promptOverride, so it never surfaces in anyone's UI.
  const isPeerTurn = author !== "host";
  const sender = isPeerTurn
    ? `"${author}", a peer collaborating in this shared session (not the host)`
    : "the host (this session's operator)";
  // File references are the second thing modelText and the transcript disagree
  // about. hooop's sigil is "#", but "@" is claude's own — the CLI expands an
  // "@path" into an attachment before the model sees the turn, even on this
  // stream-json stdin path, and ignores "#path" entirely. So the mention is
  // rewritten HERE and only here: the transcript (promptOverride) keeps the "#"
  // the user typed, and nobody's UI ever shows the "@". A native passthrough
  // command is dispatched verbatim and never carries mentions.
  const modelText = isNativePassthrough
    ? turnText.trim()
    : `[Session context: the following message is from ${sender}.]\n\n` + toClaudeFileRefs(turnText);
  if (promptOverride == null) promptOverride = text.trim();

  // Per-turn plan tracking. In plan mode the gate holds the session read-only
  // until the model calls submit_plan/ExitPlanMode — that call is what surfaces
  // a review (captured deterministically at the gate). We do NOT synthesize a
  // review from the turn's final prose.
  slot.planTurnActive = mode === "plan";
  // Per-turn plan-capture state. Clearing lastAssistantText matters: without it
  // a turn that produces no real output could reuse the PREVIOUS turn's prose as
  // the plan for a submit_plan call with an empty arg.
  slot.lastAssistantText = undefined;
  // Approved-plan execution turn → auto-allow its tool calls (reset at the
  // result frame). Only the plan-approval "proceed" turn sets this; every
  // ordinary turn clears it, so the window is exactly this one turn.
  slot.autoAllowPlanRun = opts?.autoAllowRun === true;
  // Fresh turn — drop any flag a previous native command left behind (it should
  // already be consumed; this makes a leak impossible rather than unlikely).
  slot.nativeCommandPending = null;

  if (isNativePassthrough) {
    // Claude RUNS /compact and /cost but emits no UserPromptSubmit for them
    // (verified). So a queued author would never be popped — it would go stale
    // and mis-attribute the NEXT real turn — and the request itself would never
    // reach the transcript. Skip the queue and synthesize the command echo
    // ourselves (kind:"command"), exactly as /stop and /model do. The client's
    // optimistic row reconciles against it on matching prompt text; the
    // command's OUTPUT renders from claude's synthetic frames (see synthCtx in
    // the stdout parser: /cost → assistant "<synthetic>", /compact → the
    // isSynthetic summary user frame + compact_boundary).
    try {
      ingestEventLine(JSON.stringify({
        ts: new Date().toISOString(),
        hook: "UserPromptSubmit",
        ctx: { session_id: beforeId, prompt: text.trim(), author, kind: "command" },
      }));
    } catch { /* best-effort echo — the command still runs */ }
    // No Stop hook will arrive for this command, so record that its synthetic
    // output frame is what ends the turn (see nativeCommandPending).
    slot.nativeCommandPending = commandName;
  } else if (wasMidTurn) {
    // A message written while a turn is ALREADY running is spliced by claude
    // into the running turn as a `queued_command` attachment — and, exactly
    // like /compact and /cost above, it emits NO UserPromptSubmit for it
    // (verified against a live CLI, and against a real session's transcript:
    // the attachment is in claude's own .jsonl, the hook never fired, and the
    // model quoted the message back while our events db had no row for it).
    //
    // So the same two things go wrong, for the same reason. The turn never
    // reaches the transcript — the steering message the host typed simply
    // vanishes from the chat frame, while the model plainly acts on it — and a
    // queued author would never be popped, going stale and mis-attributing the
    // NEXT real turn. Synthesize the echo here instead of queueing.
    try {
      const ctx: Record<string, unknown> = {
        session_id: beforeId,
        prompt: promptOverride ?? text.trim(),
        author,
      };
      if (turnKind != null) ctx.kind = turnKind;
      if (opts?.thumbnails?.length) ctx.images = opts.thumbnails;
      ingestEventLine(JSON.stringify({ ts: new Date().toISOString(), hook: "UserPromptSubmit", ctx }));
    } catch { /* best-effort echo — the steering message still reaches the model */ }
  } else {
    slot.pendingAuthors.push({ author, shareId, at: Date.now(), thumbnails: opts?.thumbnails, kind: turnKind, promptOverride });
    if (slot.pendingAuthors.length > MAX_PENDING_AUTHORS) slot.pendingAuthors.shift();
  }
  // Deliver the turn. The mode flip is ordered on the same stdin pipe so it
  // lands before the turn. Kept as a closure because we may have to replay the
  // exact same turn into a fresh child after a failed resume (below).
  const sendTurn = (targetId: string) => async () => {
    if (mode) await doWriteControl(targetId, { subtype: "set_permission_mode", mode });
    await doWrite(targetId, modelText, opts?.images);
  };
  // Serialise writes per session
  await enqueueWrite(slot, sendTurn(beforeId));

  // A resume can fail at runtime even though a transcript exists: a corrupt or
  // version-incompatible .jsonl makes `claude --resume` exit BEFORE it reads
  // stdin, so the turn we just wrote is swallowed and the session would hang
  // "thinking" forever with no answer. Only a resume revive can hit this — a
  // fresh --session-id spawn always starts. Watch for a frame-less early exit;
  // on failure, start a fresh session (new id; the old id is kept as an alias
  // since its transcript is unusable AND its id can't be reused — `--session-id`
  // rejects an id that already has a transcript) and replay the turn into it.
  if (needsRevive && slot.resumeSpawn) {
    const outcome = await waitForResumeOutcome(slot, 5_000);
    if (outcome === "resume-failed") {
      slot = await recoverWithFreshSession(beforeId);
      const freshId = slot.meta.sessionId;
      slot.meta.turnActive = true;
      // Mirror the per-turn plan state onto the fresh slot so a /plan (or a
      // plan-approval) turn that had to be replayed still runs in the right mode.
      slot.planTurnActive = mode === "plan";
      slot.autoAllowPlanRun = opts?.autoAllowRun === true;
      slot.lastAssistantText = undefined;
      // See the main-path branch: a native passthrough command produces no
      // UserPromptSubmit, so it must not enqueue an author here either — and
      // the replayed command still needs its turn ended by the synthetic frame.
      slot.nativeCommandPending = isNativePassthrough ? commandName : null;
      if (!isNativePassthrough) {
        slot.pendingAuthors.push({ author, shareId, at: Date.now(), thumbnails: opts?.thumbnails, kind: turnKind, promptOverride });
        if (slot.pendingAuthors.length > MAX_PENDING_AUTHORS) slot.pendingAuthors.shift();
      }
      activeSessionsBus.emit("change", { sessionId: freshId, status: slot.meta.status });
      await enqueueWrite(slot, sendTurn(freshId));
      return { sessionId: freshId };
    }
  }

  // A freshly-revived (dormant→alive via --resume) subprocess could report a
  // different session_id than the one we resumed under; wait briefly for that
  // swap so the client follows the right id for the next write. A brand-new
  // session owns its id from spawn (--session-id) and never revives here, so it
  // skips this. (waitForSwap resolves early only if the id already changed; when
  // resume preserves the id it waits out the timeout — a known small wake cost.)
  if (needsRevive) await waitForSwap(slot, beforeId, 5_000);
  return { sessionId: slot.meta.sessionId };
}

/**
 * Interrupt the model's in-flight turn (`/stop`). The sandbox's Claude Code
 * (2.1.169) doesn't honor the stream-json interrupt frame — the turn runs to
 * completion — so we abort by KILLING the child. The `close` handler marks the
 * slot dormant (a signal exit → resumable), and the next writeUserTurn revives
 * it via `--resume`; the in-flight turn's partial output is discarded, which is
 * what "stop" means. claude emits no Stop for a killed turn, so we synthesize
 * one to clear the "thinking" indicator on every client and record the stop.
 */
export async function interruptSession(
  sessionId: string,
  byAuthor: string | null = null,
  /**
   * Why, when it was not a person typing `/stop`.
   *
   * Without it the transcript showed a `/stop` command attributed to the host —
   * for something the host may not have done — and the model got a bare "turn
   * stopped" with no cause. An unexplained stop is a state a model narrates or
   * retries, which is exactly the confusion this whole feature exists to avoid.
   */
  reason: string | null = null,
): Promise<void> {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  // Mid-teardown (see destroySession): the child is already being killed for
  // good. Stopping it "successfully" here would report a session the caller can
  // keep using, seconds before it is deleted — and suppressDormantOnce would
  // send the close handler down its stay-alive branch on the way out.
  if (slot.destroying) throw new Error(`session is being deleted: ${slot.meta.sessionId}`);
  const child = slot.child;
  if (!child || child.killed) return; // nothing running to stop
  const canonicalSid = slot.meta.sessionId;
  // Echo the `/stop` command once in the transcript (kind:"command") so the
  // host action is visible and reads like any other command — the request. The
  // synthesized Stop below is its result. This is what the composer's client-
  // side interception routes here (the command never reaches the model).
  if (reason) {
    // Nobody typed anything, so do not put a command in the transcript with
    // somebody's name on it. Say what actually happened instead — this reaches
    // the model on its next turn as well as the humans reading along.
    ingestLifecycleNotice(canonicalSid, "preview-taken-over", byAuthor ?? "host", reason);
  } else {
    try {
      ingestEventLine(JSON.stringify({
        ts: new Date().toISOString(),
        hook: "UserPromptSubmit",
        ctx: { session_id: canonicalSid, prompt: "/stop", author: byAuthor ?? "host", kind: "command" },
      }));
    } catch { /* best-effort */ }
  }
  // Intentional kill — don't let the close handler flip the session to dormant.
  slot.suppressDormantOnce = true;
  killChildAsAgent(child, "SIGTERM");
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: {
        session_id: canonicalSid,
        last_assistant_message: reason ? `⏹ Turn stopped — ${reason}` : "⏹ Turn stopped.",
        author: byAuthor ?? "host",
      },
    }));
  } catch { /* best-effort — the kill already stopped the turn */ }
  // Clear turnActive NOW rather than waiting for the async child `close`. The
  // client shows the "thinking" indicator on `isWaiting || turnActive`; the
  // synthesized Stop above only clears the event-derived local isWaiting, so a
  // still-true server turnActive would keep the spinner up until the process
  // actually exits (and SIGTERM on a mid-tool turn isn't instant). Emit a `turn`
  // so every viewer's indicator clears immediately; the close handler later
  // re-clears it idempotently.
  if (slot.meta.turnActive === true) {
    slot.meta.turnActive = false;
    activeSessionsBus.emit("turn", { sessionId: canonicalSid });
  }
}

/**
 * Switch the session's model (`/model <alias>`), effective immediately. The CLI
 * has no live model-change control frame (its built-in `/model` is TUI-only and
 * rejected in stream-json print mode), so we mirror `/stop`: persist the new
 * `--model` on the slot and KILL the child. The close handler marks the slot
 * dormant, and the next writeUserTurn revives it via `--resume` with the new
 * model (wakeSession forwards meta.model). Any in-flight turn is aborted —
 * that's what "effective immediately" means. A `null`/empty model clears the
 * override so the session falls back to the user's default on the next resume.
 */
export function setSessionModel(
  sessionId: string,
  model: string | null,
  byAuthor: string | null = null,
): { sessionId: string; model: string | null } {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  if (slot.meta.status === "expired") throw new Error(`session expired: ${slot.meta.sessionId}`);
  const canonicalSid = slot.meta.sessionId;
  const next = model?.trim() || null;
  slot.meta.model = next;
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: canonicalSid, status: slot.meta.status });
  // Kill the running child so the switch takes effect now; the next turn
  // resumes on the new model. No-op when nothing is running — the persisted
  // model will still be applied on the next wake.
  const child = slot.child;
  if (child && !child.killed) {
    // Intentional kill — don't let the close handler flip the session to dormant.
    slot.suppressDormantOnce = true;
    killChildAsAgent(child, "SIGTERM");
  }
  // Echo the `/model` command once in the transcript (kind:"command") so the
  // switch reads as the host action it is — the request; the synthesized Stop
  // below is its result. This is what the composer's client-side interception
  // routes here (the command never reaches the model).
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "UserPromptSubmit",
      ctx: {
        session_id: canonicalSid,
        prompt: next ? `/model ${next}` : "/model",
        author: byAuthor ?? "host",
        kind: "command",
      },
    }));
  } catch { /* best-effort */ }
  // Synthesize a Stop so the "thinking" indicator clears (as with /stop) and
  // the transcript records the switch. Skipped when there's no child to stop
  // and thus no indicator to clear would still be harmless, so we always emit.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: {
        session_id: canonicalSid,
        last_assistant_message: next ? `⚙ Model set to ${next}.` : "⚙ Model reset to default.",
        author: byAuthor ?? "host",
      },
    }));
  } catch { /* best-effort */ }
  // Clear turnActive eagerly (see interruptSession): the kill aborts any
  // in-flight turn, but the server-authoritative flag would otherwise linger
  // until the async close and keep the "thinking" indicator spinning.
  if (slot.meta.turnActive === true) {
    slot.meta.turnActive = false;
    activeSessionsBus.emit("turn", { sessionId: canonicalSid });
  }
  return { sessionId: canonicalSid, model: next };
}

/**
 * Toggle a session's unattended auto-approval (auto mode). Unlike setSessionModel
 * this does NOT restart the child — auto mode is consumed live by
 * createPermissionRequest, so the flip takes effect on the very next tool ask.
 * Persisted (like `model`) so it survives dormant→awake, and broadcast via the
 * session row so every viewer's header reflects it. Host/full-peer only — the
 * caller (server route) enforces the capability check.
 */
export function setSessionAutoMode(
  sessionId: string,
  on: boolean,
  byAuthor: string | null = null,
): { sessionId: string; autoMode: boolean } {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  if (slot.meta.status === "expired") throw new Error(`session expired: ${slot.meta.sessionId}`);
  const canonicalSid = slot.meta.sessionId;
  // No-op when the state is already what's asked. The header pill's ✕ can only
  // turn auto mode OFF (it renders only while ON), so the UI never double-set a
  // value — but the typable `/auto-mode on|off` command can, and each call
  // otherwise injects a redundant command echo + Stop pair into every client's
  // transcript. Return the current state without touching the transcript.
  if (slot.meta.autoMode === on) return { sessionId: canonicalSid, autoMode: on };
  slot.meta.autoMode = on;
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: canonicalSid, status: slot.meta.status });
  // Echo the toggle once in the transcript (kind:"command") so the switch reads
  // as the host action it is — the request; the synthesized Stop below is its
  // result. Mirrors the `/model` echo in setSessionModel.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "UserPromptSubmit",
      ctx: {
        session_id: canonicalSid,
        prompt: on ? "/auto-mode on" : "/auto-mode off",
        author: byAuthor ?? "host",
        kind: "command",
      },
    }));
  } catch { /* transcript echo is best-effort */ }
  // Synthesize a Stop so the client's "thinking" indicator clears. The command
  // echo above is a UserPromptSubmit, which every client reads as "a turn
  // started" (isWaiting=true); without a paired Stop the spinner would spin
  // forever, since no real model turn follows this toggle. Unlike setSessionModel
  // we do NOT kill the child or touch turnActive — a genuine in-flight turn keeps
  // its server-authoritative turnActive, so this only clears our own echo.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: {
        session_id: canonicalSid,
        last_assistant_message: on ? "⚡ Auto mode enabled." : "⚡ Auto mode disabled.",
        author: byAuthor ?? "host",
      },
    }));
  } catch { /* best-effort */ }
  return { sessionId: canonicalSid, autoMode: on };
}

/**
 * Toggle a session's "burn after use". Mirrors setSessionAutoMode line for
 * line: the flip itself is instant (no child restart — the sweep and the close
 * handler are what actually consume the flag, see sweepIdleSessions and the
 * close handler in spawnControllable), persisted so it survives dormant→awake,
 * and broadcast via the session row.
 *
 * Unlike `model`/`autoMode`, this setting is one-way in effect even though the
 * FLAG is two-way: once the session actually goes idle with burnAfterUse still
 * true, it's destroyed — there is no "undo" after that point. This function
 * only ever flips the flag before that happens.
 *
 * Both directions are accepted HERE, but arming is not reachable from the
 * network: `POST /sessions/:id/burn-after-use` rejects `burn: true` outright,
 * because that route admits a full-access peer and arming self-destruction on
 * someone else's session is not a co-driver's call. Burn is armed only at
 * creation (host-only) — so in practice every caller of this function passes
 * `false`. The `true` direction exists for tests and for an internal caller that
 * already holds host authority.
 */
export function setSessionBurnAfterUse(
  sessionId: string,
  burn: boolean,
  byAuthor: string | null = null,
): { sessionId: string; burnAfterUse: boolean } {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (!slot) throw new Error(`unknown session: ${sessionId}`);
  if (slot.meta.status === "expired") throw new Error(`session expired: ${slot.meta.sessionId}`);
  // Too late to cancel: the teardown is already running (see destroySession).
  // Without this the cancel path was a lie in the worst possible place — the
  // host clicks ✕ during the seconds a burn takes, gets a 200, a cheerful
  // "🔥 Burn after use disabled." in the transcript, and no error anywhere,
  // while the transcript, workspace, events and shares are deleted regardless.
  // Fail loudly instead: the one thing worse than losing the data is being told
  // you saved it. Same guard the other mutators carry (writeUserTurn,
  // wakeSession, interruptSession).
  if (slot.destroying) throw new Error(`session is being deleted: ${slot.meta.sessionId}`);
  const canonicalSid = slot.meta.sessionId;
  // No-op when the state is already what's asked — see setSessionAutoMode for
  // why: a redundant set would otherwise inject a duplicate command echo + Stop
  // into every client's transcript for a toggle that changed nothing.
  if (!!slot.meta.burnAfterUse === burn) return { sessionId: canonicalSid, burnAfterUse: burn };
  slot.meta.burnAfterUse = burn;
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: canonicalSid, status: slot.meta.status });
  // Echo the toggle once in the transcript (kind:"command"), mirroring the
  // `/auto-mode` echo in setSessionAutoMode.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "UserPromptSubmit",
      ctx: {
        session_id: canonicalSid,
        prompt: burn ? "/burn-after-use on" : "/burn-after-use off",
        author: byAuthor ?? "host",
        kind: "command",
      },
    }));
  } catch { /* transcript echo is best-effort */ }
  // Synthesize a Stop so the client's "thinking" indicator clears — the command
  // echo above is a UserPromptSubmit with no real turn behind it.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: {
        session_id: canonicalSid,
        last_assistant_message: burn ? "🔥 Burn after use enabled." : "🔥 Burn after use disabled.",
        author: byAuthor ?? "host",
      },
    }));
  } catch { /* best-effort */ }
  return { sessionId: canonicalSid, burnAfterUse: burn };
}

/**
 * Mark a session's turn as finished (`Stop` hook). The Stop hook is claude's
 * authoritative "the turn is over" signal — the same one the dashboard's
 * client-side indicator trusts — and unlike the stream-json `result` frame it
 * fires exactly once per real turn (result frames also arrive early/synthetic
 * with all-zero usage mid-turn). Clearing here keeps the "model is thinking"
 * indicator honest for every viewer, including late joiners reading the flag
 * off the session row. No-op when nothing is in flight.
 */
export function markTurnFinished(sessionId: string): void {
  const slot = getSlot(sessionId);
  if (!slot || slot.meta.turnActive !== true) return;
  slot.meta.turnActive = false;
  // Nudge a sessions refresh so every viewer's indicator clears promptly.
  activeSessionsBus.emit("turn", { sessionId: slot.meta.sessionId });
}

/**
 * Pop the author of the next-to-be-ingested UserPromptSubmit for this session,
 * for transcript attribution in shared sessions. Returns null when the queue is
 * empty (a replayed/compaction frame, or a turn not sent via writeUserTurn) —
 * never steals a queued author for a synthetic prompt. Drops stale entries
 * (older than the TTL) first so a crash mid-turn can't mis-attribute later.
 */
const PENDING_AUTHOR_TTL_MS = 5 * 60_000;
/**
 * Pop the queued metadata for the next-to-be-ingested UserPromptSubmit: the
 * author (attribution), any image thumbnails (persisted into the event so the
 * transcript — host and peers — can show what was sent), and an optional `kind`
 * marker (e.g. "plan-approval", "command") that lets the transcript re-style
 * lifecycle/command turns instead of rendering them as ordinary chat, and a
 * `promptOverride` (the original typed text for a command turn, e.g. "/plan …"
 * whose stripped task is what the model actually received). Returns nulls when
 * the queue is empty (replay/compaction/synthetic).
 */
export function popPendingAuthor(sessionId: string): { author: string | null; thumbnails: TurnImage[] | null; kind: string | null; promptOverride: string | null } {
  const slot = getSlot(sessionId);
  if (!slot) return { author: null, thumbnails: null, kind: null, promptOverride: null };
  const now = Date.now();
  while (slot.pendingAuthors.length > 0 && now - slot.pendingAuthors[0].at > PENDING_AUTHOR_TTL_MS) {
    slot.pendingAuthors.shift();
  }
  const next = slot.pendingAuthors.shift();
  // Remember who's driving the turn that's now starting, so a PreToolUse
  // permission ask later in this same turn can be attributed to them. A turn
  // not sent via writeUserTurn (replay/synthetic) leaves the previous value;
  // that's fine — it's only consulted to attribute peer-driven asks, and a
  // synthetic prompt won't trigger one.
  if (next) slot.currentTurn = { author: next.author, shareId: next.shareId };
  return {
    author: next ? next.author : null,
    thumbnails: next?.thumbnails ?? null,
    kind: next?.kind ?? null,
    promptOverride: next?.promptOverride ?? null,
  };
}

/** Grant session-scoped "allow all" to a peer share. Subsequent PreToolUse
 * asks from turns this peer drives auto-approve (except git). In-memory:
 * cleared on sandbox restart / session end. */
export function trustPeerForSession(sessionId: string, shareId: string): { ok: boolean } {
  const slot = getSlot(sessionId);
  if (!slot || !shareId) return { ok: false };
  slot.trustedShareIds.add(shareId);
  return { ok: true };
}

function waitForSwap(slot: LiveSlot, initialId: string, timeoutMs: number): Promise<void> {
  if (slot.meta.sessionId !== initialId) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      activeSessionsBus.off("change", listener);
      resolve(); // best-effort: resolve even if swap didn't happen
    }, timeoutMs);
    const listener = () => {
      if (slot.meta.sessionId !== initialId) {
        clearTimeout(timer);
        activeSessionsBus.off("change", listener);
        resolve();
      }
    };
    activeSessionsBus.on("change", listener);
  });
}

/**
 * After writing a turn to a just-resumed subprocess, determine whether the
 * resume actually took. Resolves:
 *   - "ok"            as soon as the child emits its first frame (it's alive and
 *                     processing our turn), OR if it already had.
 *   - "resume-failed" if the child CLOSES having never emitted a frame — the
 *                     turn was written into a dying stdin and silently dropped
 *                     (a corrupt/unreadable transcript makes `--resume` exit
 *                     before it reads stdin). The caller recovers.
 *   - "timeout"       if neither happens within timeoutMs. Treated as healthy:
 *                     a slow-but-alive resume must NOT be torn down, so we only
 *                     ever recover on a definitive frame-less CLOSE, never on a
 *                     timeout.
 */
function waitForResumeOutcome(
  slot: LiveSlot,
  timeoutMs: number,
): Promise<"ok" | "resume-failed" | "timeout"> {
  if (slot.sawFirstFrame) return Promise.resolve("ok");
  const child = slot.child;
  // A bad `--resume` exits within milliseconds, so its `close` may have already
  // fired before we got here. `exitCode`/`signalCode` are non-null once the
  // process has exited (both null while alive; `!= null` also tolerates the
  // test mock, where they're undefined). Either way, no frame + gone ⇒ failed.
  const alreadyExited =
    child != null && (child.exitCode != null || (child as { signalCode?: unknown }).signalCode != null);
  if (!child || child.killed || alreadyExited) {
    return Promise.resolve("resume-failed");
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: "ok" | "resume-failed" | "timeout") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.off("close", onClose); } catch { /* ignore */ }
      if (slot.notifyFirstFrame === onFrame) slot.notifyFirstFrame = undefined;
      resolve(r);
    };
    const onFrame = () => done("ok");
    const onClose = () => done(slot.sawFirstFrame ? "ok" : "resume-failed");
    const timer = setTimeout(() => done(slot.sawFirstFrame ? "ok" : "timeout"), timeoutMs);
    slot.notifyFirstFrame = onFrame;
    child.once("close", onClose);
  });
}

/**
 * Recover from a resume that failed at runtime (see waitForResumeOutcome). The
 * dormant slot's transcript is unreadable, so we can't `--resume` it — and we
 * can't reuse its id either: `claude --session-id <id>` refuses with "Session
 * ID already in use" whenever a transcript file exists for that id (verified
 * against the CLI). So we start a genuinely FRESH session under a NEW id and
 * make every id the old session was known by an ALIAS of it. The dashboard's
 * `?session=<oldId>` URL keeps resolving, the caller can replay the turn into a
 * healthy child, and the unreadable transcript is left untouched on disk (this
 * is deliberately NON-destructive — a resume failure can be transient, e.g. a
 * claude version mid-upgrade, so we never delete the old history).
 */
async function recoverWithFreshSession(oldCanonicalId: string): Promise<LiveSlot> {
  const dead = slots.get(oldCanonicalId);
  if (!dead) throw new Error(`recover: unknown session ${oldCanonicalId}`);
  const carryStats = dead.meta.lastStats ?? null;
  const carryPending = pendingReviewsOf(dead);
  const meta = dead.meta;
  // Drop the dead slot before spawning so the new (random) id is the sole live
  // entry; its aliases are re-pointed below.
  slots.delete(oldCanonicalId);
  const { sessionId: newId } = await spawnControllable({
    cwd: meta.cwd,
    label: meta.label,
    displayName: meta.displayName,
    model: meta.model,
    autoMode: meta.autoMode,
    // Same carry-over as wakeSession — this IS a revive (just under a new id,
    // since the old one's transcript is unreadable), so the same settings must
    // survive it.
    idleTtlMs: meta.idleTtlMs,
    burnAfterUse: meta.burnAfterUse,
    via: "resumed",
    runId: meta.runId,
    skill: meta.skill,
    skillArgs: meta.skillArgs,
    // Brand-new id (randomUUID): NOT a resume, NOT the old id (which is claimed
    // by the unreadable transcript on disk).
    resumeSessionId: null,
    freshSessionId: null,
    carryStats,
    carryPending,
  });
  // Point the old canonical id — and everything that already aliased to it —
  // at the fresh session, so the dashboard URL and any in-flight references
  // resolve to the new child.
  aliases.set(oldCanonicalId, newId);
  for (const [k, v] of aliases.entries()) {
    if (v === oldCanonicalId) aliases.set(k, newId);
  }
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: newId, status: "alive", aliasFrom: oldCanonicalId });
  // Tell the user, in-transcript, why context is gone — never fail silently.
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "Stop",
      ctx: {
        session_id: newId,
        hook_event_name: "Stop",
        last_assistant_message:
          "⚠ Couldn't resume this conversation's saved history — the transcript was unreadable. Continuing in a fresh session, so earlier messages aren't available to me.",
        synthetic: true,
        kind: "error",
      },
    }));
  } catch { /* best-effort notice */ }
  log.warn("active-sessions", "resume failed at runtime; recovered with a fresh session", {
    oldSessionId: oldCanonicalId,
    newSessionId: newId,
    cwd: meta.cwd,
  });
  return slots.get(newId)!;
}

/**
 * Permanently delete a session: terminates the subprocess (if alive), removes
 * the registry entry + checkpoint, and deletes the on-disk transcript file
 * under ~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl. Cannot be undone.
 *
 * For sessions the dashboard didn't own (e.g. user's interactive TUI), this
 * is a no-op on the subprocess (we don't kill foreign processes) but still
 * removes the transcript file if found.
 */
export async function deleteSession(sessionId: string): Promise<{ deleted: boolean; workspaceRemoved: boolean }> {
  bootActiveSessions();
  const canonicalId = canonical(sessionId);
  // Capture the session cwd BEFORE endSession() drops the slot, so we can remove
  // its private workspace afterward.
  const cwd = getActiveSession(canonicalId)?.cwd;
  // Terminate the subprocess if we own it.
  if (slots.has(canonicalId)) {
    await endSession(canonicalId);
  }
  // Best-effort: remove transcript file. Walk projects/ and unlink any match.
  let removed = false;
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const proj of readdirSync(PROJECTS_DIR)) {
        const candidate = join(PROJECTS_DIR, proj, `${canonicalId}.jsonl`);
        if (existsSync(candidate)) {
          try { unlinkSync(candidate); removed = true; } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
  }
  // Also remove the ~/.claude/sessions/<pid>.json file claude leaves behind.
  // For orphaned sessions (subprocess died ungracefully) this file lingers and
  // keeps the sidebar entry alive even after we drop the transcript.
  removed = removeClaudeSessionFile(canonicalId) || removed;
  // Purge the session's events from the search DB (events + FTS + vec, hot +
  // archive) so deleted sessions stop showing up in search / observability.
  // expandSessionIds pulls in any alias ids picked up across resume cycles.
  try {
    deleteEventsForSessions(expandSessionIds(canonicalId));
  } catch (err) {
    log.warn("delete", "failed to purge events for deleted session", { sessionId: canonicalId, err });
  }
  // Remove the session's private workspace. Guarded to only ever touch a direct
  // child of SESSIONS_ROOT (never the shared workspace, a `hooop mount` folder,
  // or a symlink target) — see removeSessionWorkspace.
  const workspaceRemoved = cwd ? removeSessionWorkspace(cwd) : false;
  return { deleted: removed || slots.has(canonicalId) === false, workspaceRemoved };
}

/**
 * Permanently destroy a session — the single real teardown, combining
 * everything the `DELETE /sessions/:id` route does by hand (deleteSession +
 * revokeSharesForSession + dropJoinsForShare + reapPreviewsForSessions) into
 * one function, so the idle sweeper and the burn-after-use paths can drive the
 * exact same teardown the route does instead of a partial copy of it.
 *
 * Order matters, and mirrors the route exactly: `expandSessionIds` is captured
 * BEFORE `deleteSession` clears the registry mapping, because a share or
 * preview minted under a session's PRIOR id (`claude --resume` re-keys a
 * session mid-life) still belongs to this conversation, and `expandSessionIds`
 * can no longer resolve those prior ids once the alias map is gone.
 *
 * RE-ENTRANCY: destroySession → deleteSession → endSession kills the child,
 * and — once burn-after-use is wired into the close handler — that handler
 * would otherwise see `meta.burnAfterUse` still set on a session it just
 * watched exit cleanly and call destroySession right back on itself, forever.
 * `slot.destroying` (set here, BEFORE anything else) is what breaks that: a
 * re-entrant call (from the close handler this call's own kill triggers, or
 * from a caller racing the sweep) sees the flag already set and returns a
 * no-op result immediately instead of tearing down twice.
 */
export async function destroySession(sessionId: string): Promise<{
  deleted: boolean;
  workspaceRemoved: boolean;
  sharesRevoked: number;
  previewsStopped: number;
}> {
  bootActiveSessions();
  const slot = getSlot(sessionId);
  if (slot?.destroying) {
    return { deleted: false, workspaceRemoved: false, sharesRevoked: 0, previewsStopped: 0 };
  }
  if (slot) slot.destroying = true;

  const sessionIds = expandSessionIds(sessionId);
  const result = await deleteSession(sessionId);
  const { revoked } = revokeSharesForSession(sessionIds);
  for (const id of revoked) dropJoinsForShare(id);
  const previewsReaped = await reapPreviewsForSessions(sessionIds);
  return { ...result, sharesRevoked: revoked.length, previewsStopped: previewsReaped.length };
}

/**
 * Destroy every slot restored from the checkpoint with `meta.burnAfterUse`
 * set, regardless of the status it came back as. Meant to be called from
 * server startup right AFTER `bootActiveSessions()` — a sandbox restart
 * already killed whatever conversation a burn session was having, so there is
 * no "leave it dormant, it might resume later" for one: reviving it as dormant
 * would silently undo the burn.
 *
 * MUST NOT be called from inside bootActiveSessions() itself: boot runs on
 * every unit test in this file (and anything else that imports this module),
 * so destroying real sessions there would mean importing the module could
 * delete a real workspace directory under test. Keeping this a separate,
 * explicitly-invoked step is what makes bootActiveSessions safe to call from a
 * test.
 *
 * Skips a "provisioning" slot — its clone is still running in the background,
 * there is nothing on disk yet to destroy, and provisioning slots aren't even
 * checkpointed (see registerProvisioningSlot), so in practice this only ever
 * matters for a slot that survived to a real checkpoint entry.
 */
export async function burnRestoredSessions(): Promise<string[]> {
  const ids: string[] = [];
  for (const slot of slots.values()) {
    if (!slot.meta.burnAfterUse) continue;
    if (slot.meta.status === "provisioning") continue;
    ids.push(slot.meta.sessionId);
  }
  for (const id of ids) {
    try {
      await destroySession(id);
    } catch (e) {
      log.warn("active-sessions", "burnRestoredSessions: destroy failed", {
        sessionId: id, err: String((e as any)?.message ?? e),
      });
    }
  }
  return ids;
}

/**
 * Given a session cwd, return the session's private root — the direct child of
 * SESSIONS_ROOT it lives under (cwd is either `SESSIONS_ROOT/<id>` for a plain
 * session or `SESSIONS_ROOT/<id>/<repo>` for a git clone). Returns null when cwd
 * is not under SESSIONS_ROOT at all (an explicit-cwd / legacy shared-workspace
 * session, or a `hooop mount`).
 */
export function sessionRootFromCwd(cwd: string): string | null {
  const rel = relative(SESSIONS_ROOT, cwd);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const first = rel.split(sep)[0];
  if (!first || first === "." || first === "..") return null;
  return join(SESSIONS_ROOT, first);
}

/**
 * Permanently remove a session's private workspace. Refuses to delete anything
 * that isn't a DIRECT child of SESSIONS_ROOT — the shared WORKSPACE_DIR, a
 * `hooop mount` folder (mounted at WORKSPACE_DIR/<name>, never under sessions/),
 * and any symlink escape are all rejected. Real-path resolution defends against
 * a symlinked session dir pointing outside the sessions root. Returns whether a
 * directory was actually removed.
 */
function removeSessionWorkspace(cwd: string): boolean {
  const sessionRoot = sessionRootFromCwd(cwd);
  if (!sessionRoot || !existsSync(sessionRoot)) return false;
  try {
    const realRoot = realpathSync.native(SESSIONS_ROOT);
    const realTarget = realpathSync.native(sessionRoot);
    const rel = relative(realRoot, realTarget);
    // Must be exactly one level below the (resolved) sessions root.
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).length !== 1) {
      log.warn("delete", "refusing to remove workspace outside sessions root", { cwd, sessionRoot });
      return false;
    }
    rmSync(realTarget, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn("delete", "failed to remove session workspace", { cwd, sessionRoot, err: String(err) });
    return false;
  }
}

function removeClaudeSessionFile(sessionId: string): boolean {
  if (!existsSync(CLAUDE_SESSIONS_DIR)) return false;
  try {
    for (const name of readdirSync(CLAUDE_SESSIONS_DIR)) {
      if (!name.endsWith(".json")) continue;
      const file = join(CLAUDE_SESSIONS_DIR, name);
      try {
        const body = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
        if (body?.sessionId === sessionId) {
          try { unlinkSync(file); return true; } catch { /* ignore */ }
        }
      } catch { /* skip corrupt files */ }
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * The set of session ids that still "exist" from any authoritative source:
 * the in-memory registry (slots + aliases, keys and values), transcript files
 * under ~/.claude/projects, and the ~/.claude/sessions/*.json files Claude
 * leaves behind. A session present in NONE of these is unreachable from the
 * dashboard — genuinely gone — and its events are safe to purge.
 *
 * These are all filesystem/registry signals, never "no transcript" alone: a
 * session created without a Claude turn still lives in the registry, so it is
 * always kept.
 */
function knownSessionIds(): Set<string> {
  const known = new Set<string>();
  for (const slot of slots.values()) known.add(slot.meta.sessionId);
  for (const [alias, target] of aliases.entries()) { known.add(alias); known.add(target); }
  if (existsSync(PROJECTS_DIR)) {
    try {
      for (const proj of readdirSync(PROJECTS_DIR)) {
        try {
          for (const f of readdirSync(join(PROJECTS_DIR, proj))) {
            if (f.endsWith(".jsonl")) known.add(f.slice(0, -".jsonl".length));
          }
        } catch { /* not a dir / unreadable */ }
      }
    } catch { /* ignore */ }
  }
  if (existsSync(CLAUDE_SESSIONS_DIR)) {
    try {
      for (const name of readdirSync(CLAUDE_SESSIONS_DIR)) {
        if (!name.endsWith(".json")) continue;
        try {
          const body = JSON.parse(readFileSync(join(CLAUDE_SESSIONS_DIR, name), "utf-8")) as Record<string, unknown>;
          if (typeof body?.sessionId === "string") known.add(body.sessionId);
        } catch { /* skip corrupt */ }
      }
    } catch { /* ignore */ }
  }
  return known;
}

/**
 * Boot-time reconciliation: purge events for sessions that no longer exist by
 * any authoritative signal (see knownSessionIds). This self-heals the DB after
 * a session was deleted before delete-time purging existed, and cleans up
 * short-lived "pending-*" ids whose events never mapped to a real session.
 *
 * Called once from server startup AFTER the ingestor has drained events.jsonl
 * (so replayed rows aren't purged and immediately re-added). Best-effort:
 * failures are logged, never fatal.
 */
export function reconcileOrphanEvents(): { deleted: number; sessions: number } {
  bootActiveSessions();
  try {
    const known = knownSessionIds();
    const orphans = listEventSessionIds().filter((s) => !known.has(s));
    if (orphans.length === 0) return { deleted: 0, sessions: 0 };
    const { deleted } = deleteEventsForSessions(orphans);
    log.info("active-sessions", "boot sweep purged events for orphaned sessions", {
      sessions: orphans.length, deleted,
    });
    return { deleted, sessions: orphans.length };
  } catch (err) {
    log.warn("active-sessions", "orphan-events reconciliation skipped", { err: String((err as any)?.message ?? err) });
    return { deleted: 0, sessions: 0 };
  }
}

/**
 * Drain all live sessions on process shutdown. Each subprocess gets the same
 * grace path as endSession (close stdin, wait, then SIGTERM), but we run them
 * in parallel with a tight overall budget so the container exits within its
 * stop_grace_period. Called from server.ts on SIGTERM/SIGINT.
 *
 * Critically, this does NOT remove slots from the registry. endSession()
 * deletes a slot on purpose (the user asked to end it); a shutdown drain
 * must preserve the slot so the child.close handler sets status="ended"
 * and saveCheckpoint() writes a non-empty active-sessions.json. The next
 * sandbox boot then re-loads those slots as dormant and the dashboard
 * surfaces them in /api/sessions for resume.
 */
export async function shutdownActiveSessions(): Promise<void> {
  // Before any child is touched: every kill below produces a close that a
  // burn-after-use session would otherwise self-destruct on, mid-drain, racing
  // process.exit. See _draining.
  _draining = true;
  const ids = Array.from(slots.keys());
  await Promise.all(ids.map(async (id) => {
    const slot = slots.get(id);
    if (!slot) return;
    try {
      if (slot.stdin && !slot.stdin.destroyed) slot.stdin.end();
    } catch { /* ignore */ }
    if (slot.child && !slot.child.killed) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          killChildAsAgent(slot.child, "SIGTERM");
          resolve();
        }, 5000);
        slot.child!.once("close", () => { clearTimeout(t); resolve(); });
      });
    }
  }));
  // Authoritative final write. The per-child close handler also calls
  // saveCheckpoint, but the order across parallel drains is racey; this
  // guarantees the on-disk file matches the post-drain slot map.
  saveCheckpoint();
}

export async function endSession(sessionId: string): Promise<void> {
  const slot = getSlot(sessionId);
  if (!slot) return;
  const canonicalId = slot.meta.sessionId;
  try {
    if (slot.stdin && !slot.stdin.destroyed) slot.stdin.end();
  } catch { /* ignore */ }
  if (slot.child && !slot.child.killed) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        killChildAsAgent(slot.child, "SIGTERM");
        resolve();
      }, 5000);
      slot.child!.once("close", () => { clearTimeout(t); resolve(); });
    });
  }
  slots.delete(canonicalId);
  // Clean up aliases pointing at this canonical id
  for (const [alias, target] of aliases.entries()) {
    if (target === canonicalId) aliases.delete(alias);
  }
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId: canonicalId, status: "ended" });
}

// ---------- Internal ----------

interface SpawnOpts {
  cwd: string;
  label: string;
  displayName?: string | null;
  /**
   * Optional model override. Passed to `claude --model <value>`. Accepts
   * CLI aliases (opus/sonnet/haiku) or full model IDs. When null/undefined
   * the user's default model selection wins.
   */
  model?: string | null;
  /**
   * Carry the session's unattended auto-approval (auto mode) across a
   * wake→respawn cycle. The revived slot builds fresh meta, so without this a
   * woken session would silently revert to prompting for every tool — the same
   * class of bug the `model` carry-over guards against.
   */
  autoMode?: boolean;
  /**
   * Carry the session's per-session idle-dormancy override across a
   * wake→respawn cycle — same reasoning as `autoMode`: a woken slot builds
   * fresh meta, so without this a session that shortened/lengthened/disabled
   * its own idle window would silently fall back to the install-wide default
   * (IDLE_TTL_MS) on every dormant→awake cycle.
   */
  idleTtlMs?: number | null;
  /**
   * Carry the session's burn-after-use choice across a wake→respawn cycle.
   * Without this, a session that opted into self-destruction on going idle
   * would silently turn back into an ordinary persistent one on revive — e.g.
   * a resume-failure recovery (recoverWithFreshSession) that rebuilds the slot
   * under a new id.
   */
  burnAfterUse?: boolean;
  via: "new-conversation" | "skill" | "resumed";
  runId: string | null;
  // For a skill-launched session: the skill/command name + args, carried onto
  // the slot's meta for sidebar labeling.
  skill?: string | null;
  skillArgs?: string | null;
  resumeSessionId: string | null;
  /**
   * When resumeSessionId is null, start a brand-new session under THIS exact id
   * (via `--session-id`) instead of minting a random UUID. Used to revive a
   * dormant slot that has no transcript yet: the session keeps its id (the
   * dashboard is watching it) but begins a fresh conversation. Ignored when
   * resumeSessionId is set.
   */
  freshSessionId?: string | null;
  /**
   * Carry-over cumulative stats from the previous incarnation of this
   * session (used when waking a dormant slot). The new spawn's meta
   * seeds its lastStats with this value so token + turn totals
   * accumulate across dormant→awake cycles instead of resetting.
   */
  carryStats?: LastStats | null;
  /**
   * Synthetic plan reviews from the dormant slot being revived. Seeded into the
   * fresh slot's pendingRequests so a plan awaiting approval survives the
   * wake→respawn cycle (the old slot is discarded when the new one registers).
   */
  carryPending?: PendingPermissionRequest[] | null;
}

const MAX_CONTROLLABLE_SESSIONS = parseInt(process.env.HOOOP_MAX_CONTROLLABLE_SESSIONS ?? "", 10) || 50;

/** Thrown when the controllable-session cap is exceeded. Translate to 429 in server.ts. */
export class TooManyControllableSessionsError extends Error {
  constructor() {
    super("max controllable sessions");
    this.name = "TooManyControllableSessionsError";
  }
}

function liveSlotCount(): number {
  let n = 0;
  for (const s of slots.values()) {
    if (s.meta.status !== "ended" && s.meta.status !== "expired") n += 1;
  }
  return n;
}

async function spawnControllable(opts: SpawnOpts): Promise<{ sessionId: string; meta: ActiveSessionMeta }> {
  if (liveSlotCount() >= MAX_CONTROLLABLE_SESSIONS) {
    throw new TooManyControllableSessionsError();
  }

  // Resolved up front, before ANY state is mutated: under
  // HOOOP_BASH_CONFINE=require this throws when the shell can't be confined,
  // and doing it here means that failure can't leave behind a resume-in-flight
  // marker or a half-registered slot. See bashConfinementEnv — the whole point
  // is to refuse the session rather than quietly run an unconfined shell.
  const confinement = bashConfinementEnv(opts.cwd);

  const args: string[] = [];

  // Load every installed plugin so hooks fire (see lib/spawn.ts comment).
  for (const dir of discoverInstalledPluginDirs()) {
    args.push("--plugin-dir", dir);
  }
  args.push("-p");
  args.push("--input-format=stream-json", "--output-format=stream-json", "--verbose");
  // bypassPermissions skips Claude's built-in permission policy (including
  // the hardcoded "sensitive file" check on `.claude/` paths that an
  // explicit hook `allow` can't override). Our PreToolUse permission-gate
  // hook then becomes the SOLE gate — it short-circuits known-safe tools
  // and long-polls the dashboard for everything else. If the hook is
  // unreachable or times out, the gate defaults to DENY (not pass-through),
  // so the agent can never bypass the dashboard without explicit approval.
  args.push("--permission-mode", "bypassPermissions");
  // Standing plan-mode steering (invisible to the transcript, inert outside plan
  // mode). Headless drops the native ExitPlanMode the built-in plan prompt tells
  // the model to use, so without this the model often ends a plan turn by writing
  // the plan as prose and never calls the MCP submit_plan — nothing is captured
  // and no plan panel appears. See PLAN_SYSTEM_PROMPT.
  args.push("--append-system-prompt", PLAN_SYSTEM_PROMPT);
  // Effective model: the explicit --model when set, else claude's own
  // configured default resolved from its config (so the auto-compact window is
  // sized to the real model at spawn instead of guessing). We pass it to claude
  // explicitly so it runs exactly the model we sized. `opts.model` (the user's
  // intent, possibly null) is what we persist on meta.model — re-resolved fresh
  // on each spawn so a session with no pinned model keeps following the default.
  const effectiveModel = opts.model ?? resolveConfiguredModel(opts.cwd);
  if (effectiveModel) args.push("--model", effectiveModel);
  // A dashboard session's id is OURS, chosen here and stable for its whole life.
  // For a fresh session we mint a UUID and force claude to adopt it via
  // `--session-id`, so `ctx.session_id` on every hook/frame matches it from the
  // first frame — no `pending-` placeholder, no id swap, no alias dance. (This
  // is why the old provisional-id machinery existed: before --session-id we
  // couldn't know claude's id until its first post-input frame.) On resume we
  // reuse the existing id via `--resume`, which preserves it. `let` because the
  // defensive swap block below can still reassign it if claude ever reports a
  // different id (resume edge cases).
  let sessionId = opts.resumeSessionId ?? opts.freshSessionId ?? randomUUID();
  if (opts.resumeSessionId) {
    args.push("--resume", opts.resumeSessionId);
    // Defensive: `claude --resume` has historically been able to mint a NEW
    // session_id in print mode, producing a ~200ms window where the cache sees
    // an undecorated orphan row. listSessions() suppresses that orphan while
    // this marker is live. Cleared on id swap (below) or on expiry.
    markResumeInFlight(opts.cwd);
  } else {
    args.push("--session-id", sessionId);
  }

  // Where scratch belongs — appended here rather than with the plan prompt above,
  // because the path it names is per-session and `sessionId` is only settled now.
  // Skipped entirely if the id doesn't validate: steering the agent at a directory
  // that is NOT inside its boundary would be worse than saying nothing.
  const scratchDir = sessionScratchDir(sessionId);
  if (scratchDir) {
    args.push("--append-system-prompt", SCRATCH_SYSTEM_PROMPT.replace("{{SCRATCH}}", scratchDir));
  }

  // Auto-compaction is always on. `ctxWindow` is the model-bound window sized
  // from the effective model (explicit or resolved default); it's null only
  // when no model is configured anywhere. The meter uses only that (never a
  // guess) and the init frame rebinds it once claude confirms the resolved
  // model. The auto-compact ENV must always carry a window, so it falls back to
  // the safe floor for that last-resort no-model-configured case.
  const ctxWindow = windowForModel(effectiveModel); // number | null — for the meter
  const envWindow = ctxWindow ?? AUTO_COMPACT_WINDOW_FLOOR; // always a number
  const compactPct = autoCompactPct();
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(envWindow);
  childEnv.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(compactPct);

  // claude-mem's UserPromptSubmit hook is fail-closed by design: once its
  // worker has been unreachable for CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD
  // consecutive hooks (default 3, see docker-compose.yml's tini comment for
  // one way the worker ends up a zombie), it exits 2 and Claude Code drops
  // the prompt entirely — the model never sees it, with no retry and no
  // visible error (see the "hook-blocked" detection below, which is our
  // side's substitute for that visibility). A memory plugin being down must
  // never take a whole session down with it, so this is set high enough that
  // the threshold practically never trips.
  childEnv.CLAUDE_MEM_HOOK_FAIL_LOUD_THRESHOLD = "1000000";

  // The claude process itself is intentionally NOT Landlock-wrapped: it needs
  // read-WRITE ~/.claude (OAuth refresh, transcripts under ~/.claude/projects)
  // plus a wide read surface, and any allow-list broad enough to keep it
  // working would have to make ~/.claude writable — which its Bash child would
  // then inherit, protecting nothing.
  //
  // Its BASH TOOL is confined instead, which is the surface that actually
  // matters. CLAUDE_CODE_SHELL points claude at hooop-bash, a shim that execs
  // the real bash through the Landlock wrapper under the "dev" profile: cwd +
  // the dev toolchain, but NOT ~/.claude (credentials, hook token), ~/.ssh,
  // /var/run/hooop, or any sibling session's workdir. Confining the shell
  // rather than rewriting each command is what keeps `cd` persistence and
  // claude's shell snapshot working — see landlock/hooop-bash.
  //
  // Scope, so the next reader doesn't over-trust this: Read/Write/Edit run
  // IN-PROCESS inside claude and cannot be Landlocked, so they're gated
  // separately by path-containment in createPermissionRequest. And the child
  // still inherits this process's env, so env-borne secrets are not protected
  // by Landlock at all.
  Object.assign(childEnv, confinement ?? {}); // resolved at the top of this function

  // Point the hook scripts (children of this claude) at the HOOK socket rather
  // than the control one. They read HOOOP_SANDBOX_SOCKET and are otherwise
  // unchanged by the listener split — and this is also the point at which the
  // model's process tree stops being told where the control plane lives.
  // Likewise drop the sandbox token path: nothing in this subtree may read it.
  childEnv.HOOOP_SANDBOX_SOCKET = HOOK_SOCKET;
  delete childEnv.HOOOP_SANDBOX_TOKEN_FILE;

  // Also drop the helper's own path. Nothing in the model's subtree has any use
  // for it — it is setuid to `agent`, so exec'ing it from here is a no-op — but
  // leaving the variable set would advertise the mechanism, and the env is the
  // one channel this subtree definitely inherits.
  delete childEnv.HOOOP_AS_AGENT;

  // Spawned as the MODEL's uid, not the server's. This is the process that owns
  // ~/.claude (OAuth refresh, transcripts) and writes the session workdir, so it
  // has to be `agent` — and the reason the server can be `hooopd` at all is that
  // this one call re-enters the model's uid rather than sharing it. The helper
  // exec()s claude in place, so `child.pid` below is claude's own pid.
  const child = spawnAsAgent("claude", args, {
    cwd: opts.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });

  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("spawn: missing stdio pipes");
  }

  const startedAt = Date.now();

  const meta: ActiveSessionMeta = {
    sessionId,
    runId: opts.runId,
    label: opts.label,
    displayName: opts.displayName ?? null,
    cwd: opts.cwd,
    via: opts.via,
    skill: opts.skill ?? null,
    skillArgs: opts.skillArgs ?? null,
    startedAt,
    lastSeenAt: startedAt,
    status: "alive",
    model: opts.model ?? null,
    ...(opts.autoMode ? { autoMode: true } : {}),
    // `!= null` (not truthy) — 0 is a real, meaningful value ("never go
    // dormant") that a truthy check would silently drop.
    ...(opts.idleTtlMs != null ? { idleTtlMs: opts.idleTtlMs } : {}),
    ...(opts.burnAfterUse ? { burnAfterUse: true } : {}),
    pid: child.pid,
    // Carry over cumulative stats from a previous incarnation (set by
    // wakeSession). Without this, every dormant→awake cycle would
    // reset the running totals; the dashboard's StatsStrip would
    // ratchet down to "turns: 0" on every reactivation.
    ...(opts.carryStats ? { lastStats: opts.carryStats } : {}),
  };

  // Record the context window + auto-compact threshold so the dashboard meter
  // uses the exact denominator/trigger we handed claude (rather than
  // re-deriving it). Only set contextWindow when we could size it for the
  // model — otherwise leave it unset and let the init frame bind it from the
  // resolved model (never seed a guessed default). Merge into any carried-over
  // lastStats so a dormant→awake revive with a swapped model updates the
  // window instead of keeping the previous incarnation's.
  //
  // autoCompactWindow is the window claude ACTUALLY enforces this incarnation:
  // the exact value handed to CLAUDE_CODE_AUTO_COMPACT_WINDOW. It's frozen for
  // the process's life — env can't change after spawn — so it, not the
  // init-frame-rebound `contextWindow`, is the honest meter denominator: when
  // the model is unknown at spawn the env floors to 200k, and if the init frame
  // later reveals a 1M model, claude STILL compacts against 200k. Measuring the
  // meter against contextWindow (1M) there would strand the 85% marker and hide
  // the imminent compaction. A `/model` swap or a dormant→wake re-spawns with
  // the now-known model, refreshing this to the true window. The dashboard
  // prefers this over contextWindow (see useSessionStats).
  //
  // `model` is seeded here from effectiveModel — the model we just handed claude
  // on --model — so a session that has not produced a turn yet still has one to
  // display. meta.model deliberately holds the user's INTENT and is null for an
  // unpinned session, and the init frame that would otherwise fill this in has
  // not arrived, so without this seed the header had nothing at all to show. The
  // init frame overwrites it below with the id claude reports, which stays
  // authoritative: this is a floor, not a competing source. Same merge position
  // as contextWindow, so a wake or `/model` swap replaces a carried-over model
  // rather than inheriting the previous incarnation's.
  meta.lastStats = {
    ...(meta.lastStats ?? { v: 1 as const }),
    v: 1,
    ...(effectiveModel ? { model: effectiveModel } : {}),
    ...(ctxWindow != null ? { contextWindow: ctxWindow } : {}),
    autoCompactWindow: envWindow,
    autoCompactPct: compactPct,
  };

  const slot: LiveSlot = {
    meta,
    child,
    stdin: child.stdin as Writable,
    writeQueue: Promise.resolve(),
    outBuf: "",
    outBufBytes: 0,
    // Seed with any plan review carried over from the dormant slot we're
    // reviving (wakeSession → carryPending). Fresh spawns pass nothing.
    pendingRequests: opts.carryPending ? opts.carryPending.map((r) => ({ ...r })) : [],
    pendingAuthors: [],
    currentTurn: null,
    trustedShareIds: new Set(),
    // A resume spawn can fail at runtime (corrupt/unreadable transcript); mark
    // it so writeUserTurn can detect a frame-less early exit and recover.
    resumeSpawn: !!opts.resumeSessionId,
  };

  // Hook the stdout parser. We're after sessionId discovery + result frames.
  child.stdout.setEncoding("utf-8");
  let lineBuf = "";
  child.stdout.on("data", (chunk: string) => {
    appendOut(slot, chunk);
    lineBuf += chunk;
    let nl;
    while ((nl = lineBuf.indexOf("\n")) >= 0) {
      const line = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const frame = JSON.parse(line);
        // First valid frame → the subprocess is alive and emitting. This is the
        // signal that a `--resume` actually took (vs dying before it read stdin).
        // Notify any waiter so it can stop watching for an early death.
        if (!slot.sawFirstFrame) {
          slot.sawFirstFrame = true;
          try { slot.notifyFirstFrame?.(); } catch { /* ignore */ }
          slot.notifyFirstFrame = undefined;
        }
        // `control_request` frames are claude's stream-json mechanism for
        // asking the wrapper a question — primarily tool-permission asks
        // (`subtype: can_use_tool`). The model pauses until we write a
        // matching `control_response` to stdin. We capture them as
        // `PermissionRequest` events so the dashboard can render an
        // interactive card and call back to /sessions/:id/permission.
        if (frame.type === "control_request" && typeof frame.request_id === "string") {
          const req = frame.request ?? {};
          if (req.subtype === "can_use_tool" && typeof req.tool_name === "string") {
            const pending: PendingPermissionRequest = {
              requestId: frame.request_id,
              toolUseId: typeof frame.tool_use_id === "string" ? frame.tool_use_id : null,
              toolName: req.tool_name,
              input: req.input ?? null,
              decisionReason: typeof req.decision_reason === "string" ? req.decision_reason : null,
              receivedAt: Date.now(),
              author: slot.currentTurn?.author ?? "host",
              shareId: slot.currentTurn?.shareId ?? null,
            };
            // The OTHER birthplace of an ask. Everything the hook gate decides is
            // irrelevant here — this frame arrives straight from the subprocess and
            // becomes a card as-is — so criticality has to be stamped here too, or
            // the permission route sees an unflagged ask and lets a full peer
            // answer their own turn's destructive command.
            markCritical(pending, slot.meta.cwd, slot.meta.sessionId);
            slot.pendingRequests.push(pending);
            const eventLine = JSON.stringify({
              ts: new Date().toISOString(),
              hook: "PermissionRequest",
              ctx: {
                session_id: slot.meta.sessionId,
                tool_name: pending.toolName,
                tool_input: typeof pending.input === "string"
                  ? pending.input
                  : safeJson(pending.input),
                request_id: pending.requestId,
                tool_use_id: pending.toolUseId,
                decision_reason: pending.decisionReason,
                author: pending.author,
              },
            });
            try { ingestEventLine(eventLine); } catch (e) {
              log.warn("active-sessions", "permission request ingest failed", { err: String((e as any)?.message ?? e) });
            }
          }
          continue;
        }

        // Track the plan text as a fallback for a submit_plan/ExitPlanMode call
        // that carries an empty `plan` arg. Prefer an ExitPlanMode tool_use's
        // `plan` arg (the authoritative plan); otherwise fall back to the
        // assistant's prose. `<synthetic>` frames are NOT the model talking —
        // they're client-side notices (usage limits, "(no content)") — so they
        // must never be mistaken for a plan; leave lastAssistantText untouched.
        if (frame.type === "assistant" && frame.message && Array.isArray(frame.message.content)) {
          if (frame.message.model !== "<synthetic>") {
            // Snapshot this real API call's usage as the running context size.
            // The LAST such snapshot before the turn's result frame is the final
            // prompt size (see lastAssistantUsage). Guard on a usage object with
            // any token field so a malformed frame can't zero it out.
            const mu = (frame.message as { usage?: Record<string, unknown> }).usage;
            if (mu && typeof mu === "object") {
              const pick = (k: string): number | undefined => {
                const v = mu[k];
                return typeof v === "number" && Number.isFinite(v) ? v : undefined;
              };
              const snap = {
                input_tokens: pick("input_tokens"),
                cache_creation_input_tokens: pick("cache_creation_input_tokens"),
                cache_read_input_tokens: pick("cache_read_input_tokens"),
                output_tokens: pick("output_tokens"),
              };
              // A real API call always reads at least the (cached) system prompt,
              // so its input side is > 0. Requiring that guards against a
              // zero/partial usage block (a mislabeled synthetic frame, or a
              // frame that slipped past the <synthetic> check) wiping a real
              // context figure to ~0.
              const inputSide =
                (snap.input_tokens ?? 0) +
                (snap.cache_creation_input_tokens ?? 0) +
                (snap.cache_read_input_tokens ?? 0);
              if (inputSide > 0) slot.lastAssistantUsage = snap;
            }
            const content = frame.message.content as any[];
            const exitPlan = content.find(
              (c) => c && c.type === "tool_use" && c.name === "ExitPlanMode" &&
                     c.input && typeof c.input.plan === "string" && c.input.plan.trim(),
            );
            if (exitPlan) {
              slot.lastAssistantText = exitPlan.input.plan as string;
            } else {
              const txt = content
                .filter((c) => c && c.type === "text" && typeof c.text === "string")
                .map((c) => c.text as string)
                .join("")
                .trim();
              if (txt) slot.lastAssistantText = txt;
            }
          }
        }

        // Defensive id-swap. A new session owns its id via --session-id and a
        // resume reuses its id, so a frame's session_id normally equals ours.
        // The one case that can still differ: `claude --resume <id>` minting a
        // *new* session_id under the hood (observed in some print-mode versions)
        // — without handling it, future writes would hit the old (dead) slot. We
        // adopt the new id and keep the old one as an alias so in-flight requests
        // and the client's `selected` URL/state still resolve.
        if (typeof frame.session_id === "string" && frame.session_id !== sessionId) {
          const oldId = sessionId;
          sessionId = frame.session_id;
          slots.delete(oldId);
          slot.meta.sessionId = sessionId;
          slots.set(sessionId, slot);
          aliases.set(oldId, sessionId);
          // Re-point any existing aliases that pointed to oldId so the map
          // stays flat. Without this, a session that swaps twice (id-A → id-B →
          // id-C) would leave id-A resolving to the deleted "id-B" slot.
          for (const [k, v] of aliases.entries()) {
            if (v === oldId) aliases.set(k, sessionId);
          }
          saveCheckpoint();
          // The id has settled — getActiveSession(newId) now resolves and the
          // cache row gets decorated, so the resume-in-flight suppression
          // window for this cwd can close.
          clearResumeInFlight(slot.meta.cwd);
          activeSessionsBus.emit("change", { sessionId, status: "alive", aliasFrom: oldId });
        }

        // Built-in slash commands (/cost, /clear, /compact, ...) bypass the
        // normal Stop-hook ingest. Surface their output ourselves.
        //   - /cost, /help-like → synthetic ASSISTANT frame with model
        //     "<synthetic>" and a content array. Ingest the text as a Stop.
        //   - /clear            → synthetic ASSISTANT frame with literal
        //     "(no content)". Tag as kind=cleared so the renderer shows
        //     "Conversation cleared" rather than a blank line.
        //   - /compact          → synthetic USER frame (isSynthetic: true,
        //     isReplay: false) whose `content` IS the new compacted summary.
        //     Tag as kind=compaction; the renderer shows a collapsed notice.
        //     Gated on the compact_boundary that precedes it — isSynthetic marks
        //     every harness-injected message, so it alone does not mean this.
        const synthCtx = (() => {
          if (
            frame.type === "assistant"
            && frame.message
            && frame.message.model === "<synthetic>"
            // Same replay guard the synthetic USER branch below has always had,
            // and for the same reason. After a compaction claude REPLAYS the
            // surviving history onto stdout, which re-emits every historical
            // synthetic assistant frame. Without this, each one is ingested as a
            // brand-new row: two earlier /cost runs reappeared as two fresh
            // /cost outputs in a 33ms burst right after the compaction notice
            // (observed live). Worse for kind=error — a rate-limit notice from
            // an old turn came back as a fresh "turn failed" card on every
            // compaction. A live notice carries no isReplay, so it still lands.
            && frame.isReplay !== true
            && Array.isArray(frame.message.content)
          ) {
            const text = frame.message.content
              .filter((c: any) => c?.type === "text" && typeof c.text === "string")
              .map((c: any) => c.text)
              .join("\n");
            if (!text) return null;
            const isCleared = text.trim() === "(no content)";
            // An API failure (usage/rate limit, overload) arrives as a synthetic
            // assistant frame carrying the error CLASS at the frame's top level
            // (`error: "rate_limit"`). Verified against the live stream — note
            // the session .jsonl uses isApiErrorMessage/apiErrorStatus instead,
            // and those are absent here, so don't reach for them.
            // Tagged kind=error (not the kind=info catch-all, which also covers
            // benign notices like /cost output) so the transcript can show it as
            // a failure rather than as something the model said.
            const errKind = typeof frame.error === "string" && frame.error.trim() ? frame.error.trim() : null;
            return {
              kind: errKind ? ("error" as const) : isCleared ? ("cleared" as const) : ("info" as const),
              text: isCleared ? "Conversation cleared." : text,
              error: errKind,
            };
          }
          if (
            frame.type === "user"
            && frame.isSynthetic === true
            && frame.isReplay !== true
            && frame.message
          ) {
            // isSynthetic marks EVERY harness-injected message, not just a
            // compaction summary, so the boundary flag is what tells them apart.
            // Without it the image-downscale notice claude injects after reading
            // an oversized image reads as a compaction — see compactSummaryPending.
            if (!slot.compactSummaryPending) {
              // Some other piece of context plumbing addressed to the model. It
              // is not something anyone said, so it earns no transcript row —
              // but it IS a synthetic frame, and saying so still ends a native
              // passthrough command's turn below.
              return { kind: null, text: "", error: null };
            }
            slot.compactSummaryPending = false;
            // The summary lives in message.content as a string (compact) or
            // as an array of content blocks (defensive parse).
            const c = frame.message.content;
            let text = "";
            if (typeof c === "string") text = c;
            else if (Array.isArray(c)) {
              text = c
                .map((b: any) => (typeof b === "string" ? b : (b?.text ?? "")))
                .filter((s: string) => !!s)
                .join("\n");
            }
            if (!text) return null;
            return { kind: "compaction" as const, text, error: null };
          }
          return null;
        })();
        if (synthCtx) {
          // A row is optional; being a synthetic frame is not. Plumbing claude
          // injected for its own benefit (the image-downscale notice) has no
          // kind and produces no row, yet must still reach the turn-end check —
          // otherwise a /compact whose boundary went missing would leave every
          // viewer's "thinking" indicator spinning forever, which is a worse
          // failure than the stray marker this gate removes.
          if (synthCtx.kind) {
            try {
              ingestEventLine(JSON.stringify({
                ts: new Date().toISOString(),
                hook: "Stop",
                ctx: {
                  session_id: frame.session_id ?? sessionId,
                  hook_event_name: "Stop",
                  last_assistant_message: synthCtx.text,
                  synthetic: true,
                  kind: synthCtx.kind,
                  ...(synthCtx.error ? { error: synthCtx.error } : {}),
                },
              }));
            } catch (err) {
              log.warn("active-sessions", "synthetic ingest failed", { err });
            }
          }
          // This frame IS the end of a native passthrough command's turn: claude
          // emits no Stop hook for /compact or /cost, so server.ts's /ingest —
          // the only caller of markTurnFinished — never runs and turnActive
          // would stay true indefinitely, leaving the "thinking" indicator
          // spinning on every viewer long after the command finished.
          //
          // Guarded on the flag, not on synthCtx.kind: AUTO-compaction produces
          // an identical kind=compaction frame mid-turn and must NOT end the
          // turn (see compactedThisTurn). Consume the flag either way so a
          // later frame in the same turn can't re-trigger this.
          if (slot.nativeCommandPending) {
            slot.nativeCommandPending = null;
            // Reuse the hook path's own helper: it no-ops when nothing is in
            // flight and emits the bus nudge that carries the cleared flag out.
            markTurnFinished(slot.meta.sessionId);
          }
        }

        // Compaction boundary. Claude emits a `system`/`compact_boundary` frame
        // AFTER it summarizes history to free context (Agent SDK type
        // SDKCompactBoundaryMessage). We zero lastStats.usage so the "ctx %"
        // meter drops as soon as compaction happens instead of holding the
        // pre-compaction figure until the next result frame refills it.
        //
        // We deliberately do NOT synthesize a transcript row here: claude also
        // emits the compacted summary as a synthetic USER frame (verified for
        // manual /compact; documented for auto in claude-code issue #48740),
        // which the synthetic-frame block above already renders as
        // kind=compaction. Emitting our own row too would double-render every
        // (auto) compaction.
        if (frame.type === "system" && frame.subtype === "compact_boundary") {
          const existing = slot.meta.lastStats ?? { v: 1 as const };
          // Prefer the real post-compaction size claude reports in
          // compact_metadata.post_tokens (present in claude-code 2.1.218); it's
          // the size of the summary that becomes the new prompt, so the meter
          // drops to the TRUTH instead of a bare 0. Fall back to 0 when absent.
          const meta = (frame as { compact_metadata?: Record<string, unknown> }).compact_metadata;
          const postTokens =
            meta && typeof meta.post_tokens === "number" && Number.isFinite(meta.post_tokens) && meta.post_tokens > 0
              ? (meta.post_tokens as number)
              : 0;
          slot.meta.lastStats = {
            ...existing,
            v: 1,
            usage: {
              // Represent the whole post-compaction prompt as input so
              // totalInputTokens() (input + cache_create + cache_read) sums to
              // post_tokens. On the next turn it re-splits into cache reads.
              input_tokens: postTokens,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 0,
            },
          };
          // Mark the turn compacted and discard any pre-compaction assistant
          // snapshot: for a MANUAL /compact (no assistant frame follows), the
          // trailing result frame must NOT resurrect the huge pre-compaction
          // figure via the fallback. For AUTO-compaction the turn continues, so
          // post-boundary assistant frames refresh lastAssistantUsage to the
          // true (growing) size and correctly win over this baseline.
          slot.compactedThisTurn = true;
          // Arm the synthetic-frame branch: the very next one is the summary.
          slot.compactSummaryPending = true;
          slot.lastAssistantUsage = undefined;
          slot.meta.lastSeenAt = Date.now();
        }

        // System/init frame is the FIRST frame of every turn — it carries
        // model + permissionMode (claude's name for "mode": default/plan/etc).
        // We treat it as authoritative for those two fields and let the
        // result frame fill in usage + duration at end-of-turn. Keep
        // existing lastStats fields when a key is missing so the header
        // stays populated across model swaps mid-conversation.
        //
        // Crucially, this is where the context window gets BOUND to the model:
        // spawn may only have had an alias ("opus") or the user's unqualified
        // default, but the init frame reports the resolved id ("claude-opus-4-8")
        // — so we (re)derive the window here. This is the "set the length when
        // the model is known" direction; we never keep a spawn-time guess.
        if (frame.type === "system" && (frame.subtype === "init" || !frame.subtype)) {
          const existing = slot.meta.lastStats ?? { v: 1 as const };
          const model = typeof frame.model === "string" ? frame.model : existing.model;
          const win = windowForModel(model);
          slot.meta.lastStats = {
            ...existing,
            v: 1,
            model,
            mode: typeof frame.permissionMode === "string" ? frame.permissionMode
                  : typeof frame.output_style === "string" ? frame.output_style
                  : existing.mode,
            // Only overwrite when we can size the resolved model; a null here
            // (unrecognized model) must not wipe a window we already knew.
            ...(win != null ? { contextWindow: win } : {}),
          };
        }

        // A hook (any plugin's, not just claude-mem's) vetoed this prompt.
        // Claude Code emits a `system`/`informational` frame with
        // `preventContinuation: true` and drops the prompt silently — the
        // model never sees it and nothing else in this stream says so. Left
        // unsurfaced, the host just watches their message sit there forever
        // with no reply and no error (see #1218 in session
        // fd3986f1-99f1-4feb-9a0b-86634f75a066's transcript for the case that
        // prompted this). Surface it the same way an auth failure is
        // surfaced below: a bus "error" the dashboard turns into a banner.
        if (frame.type === "system" && frame.subtype === "informational" && frame.preventContinuation === true) {
          const content = typeof frame.content === "string" ? frame.content : "a plugin hook";
          const reason = (content.split(/\]:\s*/).pop() ?? content).split("\n\nOriginal prompt:")[0].trim();
          activeSessionsBus.emit("error", {
            sessionId,
            kind: "hook-blocked",
            message: reason || "A plugin hook blocked your message before Claude saw it.",
          });
          log.warn("active-sessions", "prompt blocked by hook", { sessionId, reason });
        }

        if (frame.type === "result") {
          slot.meta.lastSeenAt = Date.now();
          // Capture usage + turn duration. Claude's result frame shape:
          //   { type: "result", duration_ms: 3214, usage: { input_tokens,
          //     cache_creation_input_tokens, cache_read_input_tokens,
          //     output_tokens, ... }, ... }
          // We defensively coerce to the shape the dashboard expects and
          // drop everything else.
          const u = (frame.usage ?? {}) as Record<string, unknown>;
          const pickInt = (k: string): number | undefined => {
            const v = u[k];
            return typeof v === "number" && Number.isFinite(v) ? v : undefined;
          };
          const existing = slot.meta.lastStats ?? { v: 1 as const };
          const turnUsage = {
            input_tokens: pickInt("input_tokens"),
            cache_creation_input_tokens: pickInt("cache_creation_input_tokens"),
            cache_read_input_tokens: pickInt("cache_read_input_tokens"),
            output_tokens: pickInt("output_tokens"),
          };
          const prevTotals = existing.totals ?? {
            input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 0,
            turns: 0,
          };
          // Synthetic / no-op turns (claude-mem observer frames, `<synthetic>`
          // model frames, the empty trailing frame claude sometimes emits)
          // report an all-zero usage block. Those must NOT overwrite the real
          // per-turn `usage` — it drives the context-fill % — nor inflate the
          // turn counter. Only a turn that actually consumed tokens updates
          // usage/totals; everything else just bumps lastSeenAt.
          const turnTotal =
            (turnUsage.input_tokens ?? 0) +
            (turnUsage.cache_creation_input_tokens ?? 0) +
            (turnUsage.cache_read_input_tokens ?? 0) +
            (turnUsage.output_tokens ?? 0);
          if (turnTotal > 0) {
            // CONTEXT vs BILLING split. `usage` drives the ctx meter, so it must
            // be the last API call's prompt size — i.e. the last real assistant
            // message's usage (slot.lastAssistantUsage), NOT the result frame's
            // usage. The result frame aggregates usage across every round-trip in
            // the turn, so its cache_read is N× the real prompt on an agentic turn
            // and would pin the meter near 100% on a nearly-empty window (observed
            // live: cache_read 990k on a ~54k real context). `totals` keeps the
            // result frame's figures — those ARE the cumulative billing numbers.
            //
            // Precedence:
            //   1. lastAssistantUsage — a real assistant message this turn (incl.
            //      post-compaction messages on an auto-compact turn).
            //   2. the compaction baseline — if the turn compacted and no
            //      assistant message followed (manual /compact), keep the
            //      post_tokens size the boundary set, NOT the result's cumulative
            //      usage (which includes the summarization read → false ~100%).
            //   3. turnUsage — ordinary turn with no assistant snapshot (rare).
            const contextUsage =
              slot.lastAssistantUsage ??
              (slot.compactedThisTurn ? (existing.usage ?? turnUsage) : turnUsage);
            slot.meta.lastStats = {
              ...existing,
              v: 1,
              usage: contextUsage,
              turnDurationMs: typeof frame.duration_ms === "number" ? frame.duration_ms : undefined,
              turnEndedAt: Date.now(),
              totals: {
                input_tokens: prevTotals.input_tokens + (turnUsage.input_tokens ?? 0),
                cache_creation_input_tokens:
                  prevTotals.cache_creation_input_tokens + (turnUsage.cache_creation_input_tokens ?? 0),
                cache_read_input_tokens:
                  prevTotals.cache_read_input_tokens + (turnUsage.cache_read_input_tokens ?? 0),
                output_tokens: prevTotals.output_tokens + (turnUsage.output_tokens ?? 0),
                turns: prevTotals.turns + 1,
              },
            };
          }
          // Consume the per-turn context snapshot + compaction flag so the NEXT
          // turn recomputes from its own assistant messages (and a subsequent
          // no-op/synthetic result can't resurrect this turn's figure via the
          // fallback).
          slot.lastAssistantUsage = undefined;
          slot.compactedThisTurn = false;
          // A result frame ends the turn outright, so any unconsumed native
          // command flag is spent — never let it survive into the next turn.
          slot.nativeCommandPending = null;
          // The result frame is the subprocess's authoritative end-of-turn, so
          // the "model is thinking" indicator clears HERE — not only on the Stop
          // HOOK (server.ts /ingest → markTurnFinished). A turn that dies before
          // the model ever runs (usage limit, auth failure) emits no Stop hook at
          // all, so relying on the hook alone left every viewer's indicator
          // spinning forever. Observed live on a rate_limit turn. The emit below
          // carries the cleared flag out to all viewers.
          slot.meta.turnActive = false;
          saveCheckpoint();
          activeSessionsBus.emit("turn", { sessionId, result: frame.result });

          // Plan-mode turn ended — reset per-turn plan state. A plan review is
          // surfaced ONLY when the model explicitly calls submit_plan/ExitPlanMode
          // (captured deterministically at the gate). We deliberately do NOT
          // synthesize a review from the turn's final prose: it misfired on
          // conversational replies — a decline, a clarifying question, or an
          // acknowledgment after a rejection all became spurious Plan cards.
          slot.planTurnActive = false;
          // Close the approved-plan auto-allow window at turn end.
          slot.autoAllowPlanRun = false;
        }
      } catch {
        /* ignore non-JSON */
      }
    }
  });

  child.stderr.setEncoding("utf-8");
  // Match patterns claude emits on Anthropic-rejected OAuth. We sniff each
  // stderr chunk; first match wins to avoid spamming the bus on retries.
  // Patterns are intentionally generous — claude's exact error text changes
  // between versions, but all current variants name "auth" or "401" plainly.
  // Negative match guards: explicitly skip the harmless "refresh succeeded"
  // log that claude emits when it silently rotates a near-expiry token.
  const AUTH_FAIL_RE = /\b(401|unauthorized|invalid[_ -]?authentication|invalid[_ -]?credentials|auth(?:entication)?[_ ]?(?:error|failed)|please[_ ]?run[_ ]?claude[_ ]?login)\b/i;
  const REFRESH_OK_RE = /\b(refresh[_ ]?(?:succeeded|completed)|token[_ ]?refreshed)\b/i;
  let authFailReported = false;
  child.stderr.on("data", (data: string) => {
    appendOut(slot, `[stderr] ${data}`);
    if (
      !authFailReported &&
      AUTH_FAIL_RE.test(data) &&
      !REFRESH_OK_RE.test(data)
    ) {
      authFailReported = true;
      activeSessionsBus.emit("error", {
        sessionId,
        kind: "auth",
        message: "sandbox authentication failed — run `hooop login`",
      });
      log.warn("active-sessions", "auth failure detected from claude stderr", {
        sessionId,
        snippet: data.slice(0, 200),
      });
    }
  });

  child.on("error", (err) => {
    slot.meta.status = "error";
    slot.meta.errorMessage = err.message;
    activeSessionsBus.emit("error", { sessionId, message: err.message });
    saveCheckpoint();
  });

  child.on("close", (code) => {
    slot.meta.exitCode = code;
    // The child is gone → no turn can be in flight. Clear the flag regardless
    // of why it exited (turn end, /stop, /model, crash, shutdown).
    const wasTurnActive = slot.meta.turnActive === true;
    slot.meta.turnActive = false;
    // If the slot is still in the registry (i.e. the user didn't explicitly
    // endSession(), which deletes it), the subprocess exited on its own.
    // In print mode that's the NORMAL between-turns state: claude finishes a
    // turn and exits; the next writeUserTurn revives it via --resume. Surface
    // a clean exit (code 0) or a signal kill (null, e.g. shutdown drain) as
    // "dormant" — idle and resumable — so a freshly-answered session doesn't
    // read as dead in the sidebar/header. Reserve "ended" for a genuinely
    // abnormal (non-zero) exit.
    if (slots.has(sessionId)) {
      if (slot.suppressDormantOnce) {
        // Intentional, self-recovering kill (`/stop`, `/model`): the child is
        // gone but the next writeUserTurn revives it via --resume. Keep the
        // visible lifecycle "alive" so the sidebar/composer don't flip to
        // dormant/ended for a user-initiated restart. NB we ignore the exit
        // code here — a SIGTERM kill of claude exits non-zero, which would
        // otherwise read as "ended"; the flag (set only right before our own
        // kill) is the authoritative signal that this exit was deliberate.
        // One-shot — clear it so a later genuine exit still transitions. We
        // don't emit "change" (that would signal a lifecycle transition), but
        // we DO nudge a sessions refresh so the cleared turnActive reaches
        // viewers and the thinking indicator turns off promptly.
        slot.suppressDormantOnce = false;
        saveCheckpoint();
        if (wasTurnActive) activeSessionsBus.emit("turn", { sessionId });
      } else {
        // Clean exit (code 0) or signal kill (null, e.g. shutdown drain) is the
        // normal idle-between-turns state → "dormant"; reserve "ended" for a
        // genuinely abnormal non-zero exit. An idle-TTL reap forces "dormant"
        // regardless of code (claude exits non-zero on our SIGTERM).
        const reaped = slot.reapToDormant === true;
        slot.reapToDormant = false;
        const wouldGoDormant = reaped || code === 0 || code === null;
        if (wouldGoDormant && slot.meta.burnAfterUse && !slot.destroying && !_draining) {
          // Burn-after-use has no dormant state — a clean/idle exit IS this
          // session's end of life, not a reason to sit resumable. destroySession
          // sets slot.destroying before it does anything, so the re-entrant
          // close this triggers (deleteSession -> endSession kills the same
          // child again — a no-op, it's already exited) sees the flag and
          // doesn't loop back here.
          //
          // Deliberately NOT extended to the abnormal (non-zero, non-reaped)
          // branch below: a crash is exactly the moment a burn session's
          // workspace/transcript are most worth keeping around to inspect, so
          // it lands on "ended" like any other session and is left alone.
          // Nor to a shutdown drain (_draining), where the teardown would race
          // process.exit and strand a half-deleted session.
          //
          // Write the lifecycle FIRST, even though this branch returns early and
          // the slot is about to disappear. The teardown is asynchronous, and
          // endSession waits on a `close` that already fired (its guard is
          // `!child.killed`, false for a natural exit), so the slot stays
          // reachable for seconds. Leaving the stale "alive" behind is what let
          // writeUserTurn take its `status !== "alive"` revive gate as "still
          // running" and push a turn into stdin that endSession had already
          // ended: the user's message vanished and every viewer kept a spinner
          // for a session that was being deleted. "ended" is also the honest
          // thing to checkpoint if the process dies mid-teardown.
          slot.meta.status = "ended";
          saveCheckpoint();
          activeSessionsBus.emit("change", { sessionId, status: "ended", exitCode: code });
          void destroySession(sessionId).catch((e) =>
            log.warn("active-sessions", "burn-after-use destroy failed on close", {
              sessionId, err: String((e as any)?.message ?? e),
            }),
          );
          return;
        }
        const nextStatus: LifecycleStatus = wouldGoDormant ? "dormant" : "ended";
        slot.meta.status = nextStatus;
        saveCheckpoint();
        activeSessionsBus.emit("change", { sessionId, status: nextStatus, exitCode: code });
      }
    }
  });

  // Register the slot under the id we own (passed to claude via --session-id, or
  // the resume id). It's the session's real, stable id from this moment — no
  // provisional/pending phase — so it's immediately writable, listable, and
  // shareable, before claude emits any frame.
  slots.set(sessionId, slot);
  saveCheckpoint();
  activeSessionsBus.emit("change", { sessionId, status: "alive" });

  return { sessionId, meta: { ...slot.meta } };
}

/**
 * Run `task` after every write already queued for `slot`, without letting a
 * failed write permanently break the queue for every turn that comes after it.
 *
 * `slot.writeQueue = slot.writeQueue.then(task)` looks like serialisation but
 * is a poison pill: once the chained promise REJECTS (a stdin write can fail —
 * EPIPE from a dying child, a destroyed stream, backpressure gone wrong), every
 * later `.then(fn)` on that same rejected promise skips `fn` entirely and just
 * re-rejects with the ORIGINAL error. The queue never recovers on its own — one
 * transient write failure (which "the model is mid-turn" is exactly the kind of
 * moment that can produce) silently stops every later turn from ever reaching
 * stdin again, each one failing instantly with a stale error nobody typed. This
 * is the write-side half of a session going deaf to new messages while a turn
 * is running; keeping `slot.writeQueue` itself always-resolved (this call's own
 * outcome is tracked separately, in `task`, and awaited by the caller) is what
 * lets the NEXT turn still get a real attempt.
 */
function enqueueWrite(slot: LiveSlot, fn: () => Promise<void>): Promise<void> {
  const task = slot.writeQueue.then(fn, fn);
  slot.writeQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

async function doWrite(sessionId: string, text: string, images?: TurnImage[]): Promise<void> {
  const slot = slots.get(sessionId);
  if (!slot || !slot.stdin || slot.stdin.destroyed) {
    throw new Error(`session not writable: ${sessionId}`);
  }
  // Build the Messages-API content array: image blocks first (recommended
  // ordering for vision), then the text. `claude -p --input-format=stream-json`
  // accepts base64 image blocks and the model interprets them (verified).
  const content: Array<Record<string, unknown>> = [];
  for (const img of images ?? []) {
    content.push({ type: "image", source: { type: "base64", media_type: img.media_type, data: img.data } });
  }
  if (text || content.length === 0) content.push({ type: "text", text });
  const frame = JSON.stringify({
    type: "user",
    message: { role: "user", content },
  }) + "\n";
  await new Promise<void>((resolve, reject) => {
    slot.stdin!.write(frame, "utf-8", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  slot.meta.lastSeenAt = Date.now();
  saveCheckpoint();
}

/**
 * Write a stream-json `control_request` to the subprocess stdin — used to flip
 * permission mode (`set_permission_mode`) for a `/plan` turn. Ordered on the
 * same pipe as user turns, so a mode change enqueued before a turn is applied
 * first. claude answers with a matching `control_response` on stdout, which our
 * stdout parser ignores (it only acts on inbound `can_use_tool` asks) — harmless.
 */
async function doWriteControl(sessionId: string, request: Record<string, unknown>): Promise<void> {
  const slot = slots.get(sessionId);
  if (!slot || !slot.stdin || slot.stdin.destroyed) {
    throw new Error(`session not writable: ${sessionId}`);
  }
  const frame = JSON.stringify({ type: "control_request", request_id: randomUUID(), request }) + "\n";
  await new Promise<void>((resolve, reject) => {
    slot.stdin!.write(frame, "utf-8", (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function appendOut(slot: LiveSlot, data: string) {
  slot.outBuf += data;
  slot.outBufBytes += Buffer.byteLength(data, "utf-8");
  if (slot.outBuf.length > MAX_OUT_BYTES) {
    const overflow = slot.outBuf.length - MAX_OUT_BYTES;
    slot.outBuf = "…[truncated]…\n" + slot.outBuf.slice(overflow);
  }
}

// ---------- Checkpoint ----------

interface CheckpointFile {
  version: number;
  savedAt: string;
  sessions: Array<{
    sessionId: string;
    runId: string | null;
    label: string;
    displayName?: string | null;
    cwd: string;
    via: ActiveSessionMeta["via"];
    startedAt: number;
    lastSeenAt: number;
    // Skill/command name + args for a skill-launched session, so its sidebar
    // badge survives a restart. Optional; absent on non-skill sessions.
    skill?: string | null;
    skillArgs?: string | null;
    // Configured `--model` override, re-applied on every resume. Optional for
    // backwards compat with files written before the field existed.
    model?: string | null;
    // Unattended auto-approval (auto mode). A durable host choice, so it survives
    // dormant→awake. Optional; absent on files written before the field existed.
    autoMode?: boolean;
    // Per-session idle-dormancy override (null/absent → install default; 0 →
    // never). A durable host choice, so it survives dormant→awake. Optional;
    // absent on files written before the field existed.
    idleTtlMs?: number | null;
    // Burn-after-use. A durable host choice, so it survives dormant→awake (up
    // until it actually fires). Optional; absent on files written before the
    // field existed.
    burnAfterUse?: boolean;
    // Historical ids that have been remapped to this canonical session.
    // Persisting them lets the dashboard's "transcript spans alias swaps"
    // behaviour survive a sandbox restart — without this, the in-memory
    // aliases map dies on shutdown and a reload-after-restart loses the
    // link between the URL's old session_id and the post-resume canonical
    // id. Optional for backwards compat with v1 files that pre-date it.
    aliases?: string[];
    // Per-turn telemetry from the most recent result frame (model, mode,
    // usage, duration). Persisted so dashboard reloads can render the
    // stats header without waiting for a fresh turn.
    lastStats?: LastStats;
    // Outstanding SYNTHETIC plan reviews (see PendingPermissionRequest.synthetic).
    // Unlike live permission asks — which are bound to a running child that a
    // restart kills, so they're intentionally dropped — a synthetic review has
    // no hook waiting on it and is answered by dispatching a follow-up turn. It
    // must survive restart/revive so a plan the user was about to approve isn't
    // silently lost. Optional; absent on v1 files and sessions with no review.
    pendingReviews?: PendingPermissionRequest[];
    // The spec of the preview idle-dormancy released, so the offer to restart it
    // survives a sandbox restart as well as the dormancy itself. Optional.
    lastPreviewSpec?: PreviewSpec | null;
    lastPreviewStoppedReason?: "idle" | null;
  }>;
}

function saveCheckpoint() {
  try {
    mkdirSync(dirname(CHECKPOINT_FILE), { recursive: true });
    // Persist only sessions worth reviving: alive + ended (could be resumed);
    // skip expired (already broken) and provisioning (ephemeral — nothing to
    // resume; the clone child dies with the process, so a mid-clone restart just
    // drops the row).
    const sessions = Array.from(slots.values())
      .filter((s) => s.meta.status !== "expired" && s.meta.status !== "provisioning")
      .map((s) => {
        const al = aliasesFor(s.meta.sessionId);
        const reviews = pendingReviewsOf(s);
        return {
          sessionId: s.meta.sessionId,
          runId: s.meta.runId,
          label: s.meta.label,
          displayName: s.meta.displayName,
          cwd: s.meta.cwd,
          via: s.meta.via,
          startedAt: s.meta.startedAt,
          lastSeenAt: s.meta.lastSeenAt,
          ...(s.meta.skill ? { skill: s.meta.skill } : {}),
          ...(s.meta.skillArgs ? { skillArgs: s.meta.skillArgs } : {}),
          ...(s.meta.model ? { model: s.meta.model } : {}),
          ...(s.meta.autoMode ? { autoMode: true } : {}),
          ...(s.meta.idleTtlMs != null ? { idleTtlMs: s.meta.idleTtlMs } : {}),
          ...(s.meta.burnAfterUse ? { burnAfterUse: true } : {}),
          ...(al.length > 0 ? { aliases: al } : {}),
          ...(s.meta.lastStats ? { lastStats: s.meta.lastStats } : {}),
          ...(reviews.length > 0 ? { pendingReviews: reviews } : {}),
          ...(s.meta.lastPreviewSpec ? { lastPreviewSpec: s.meta.lastPreviewSpec } : {}),
          ...(s.meta.lastPreviewStoppedReason
            ? { lastPreviewStoppedReason: s.meta.lastPreviewStoppedReason }
            : {}),
        };
      });
    const body: CheckpointFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      sessions,
    };
    writeFileSync(CHECKPOINT_TMP, JSON.stringify(body, null, 2), "utf-8");
    renameSync(CHECKPOINT_TMP, CHECKPOINT_FILE);
  } catch (err) {
    log.error("active-sessions", "checkpoint save failed", { err });
  }
}

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_FILE)) return;
  let body: CheckpointFile;
  try {
    body = JSON.parse(readFileSync(CHECKPOINT_FILE, "utf-8"));
  } catch (err) {
    log.warn("active-sessions", "could not parse checkpoint, ignoring", { err });
    return;
  }
  const now = Date.now();
  let pruned = 0;
  let migrated = 0;
  for (const entry of body.sessions ?? []) {
    // Prune old entries
    if (now - entry.lastSeenAt > PRUNE_AGE_MS) {
      pruned++;
      continue;
    }

    // One-shot cwd migration: the old container layout used `/workspace`
    // for the session workdir, which is now reserved for plugin source
    // (moved to /opt/hooop) and isn't writable by the agent user.
    // Rewrite stale checkpoints so previously-created sessions stay alive.
    if (entry.cwd === "/workspace") {
      entry.cwd = "/home/agent/workspace";
      migrated++;
    }

    // Re-apply cwd policy at boot time. If HOOOP_CWD_ROOTS was tightened
    // or the checkpoint was tampered with, the entry must not be revived.
    const cwdCheck = isCwdAllowed(entry.cwd);
    if (!cwdCheck.ok) {
      log.warn("active-sessions", "dormant session cwd no longer allowed; pruning", {
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        reason: cwdCheck.reason,
      });
      pruned++;
      continue;
    }

    // Don't prune based on transcript existence at boot. A session spawned
    // but not yet written-to has no transcript file yet, and dropping it
    // here means the user can never resume that fresh session after a
    // restart. wakeSession will surface "no transcript / --resume failed"
    // lazily if the conversation is truly unrecoverable.
    const restoredPreviewSpec = restoreLastPreviewSpec(entry.lastPreviewSpec);
    const meta: ActiveSessionMeta = {
      sessionId: entry.sessionId,
      runId: entry.runId,
      label: entry.label,
      displayName: entry.displayName ?? null,
      cwd: entry.cwd,
      via: entry.via,
      skill: entry.skill ?? null,
      skillArgs: entry.skillArgs ?? null,
      startedAt: entry.startedAt,
      lastSeenAt: entry.lastSeenAt,
      status: "dormant",
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.autoMode ? { autoMode: true } : {}),
      ...(entry.idleTtlMs != null ? { idleTtlMs: entry.idleTtlMs } : {}),
      ...(entry.burnAfterUse ? { burnAfterUse: true } : {}),
      ...(entry.lastStats ? { lastStats: entry.lastStats } : {}),
      // A preview released for idleness is offered back as a one-click restart,
      // so the offer has to outlive the sandbox process too — validated on the
      // way back in, since a checkpoint is a file on disk and this spec is fed
      // to a form and then to startPreview.
      ...(restoredPreviewSpec
        ? {
            lastPreviewSpec: restoredPreviewSpec,
            lastPreviewStoppedReason: entry.lastPreviewStoppedReason ?? "idle",
          }
        : {}),
    };
    slots.set(entry.sessionId, {
      meta,
      writeQueue: Promise.resolve(),
      outBuf: "",
      outBufBytes: 0,
      // Restore only synthetic plan reviews (see CheckpointFile.pendingReviews).
      // Filter defensively: a hand-edited checkpoint must not smuggle in a
      // non-synthetic "pending ask" with no hook behind it.
      pendingRequests: (entry.pendingReviews ?? []).filter((r) => r && r.synthetic),
      pendingAuthors: [],
      currentTurn: null,
      trustedShareIds: new Set(),
    });
    // Restore historical aliases. Each entry.aliases id is an "old id"
    // that previously resolved to entry.sessionId — we re-key the in-memory
    // alias map so future getSlot() lookups on old ids hit the right slot,
    // and so aliasesFor() returns the same list it would have before the
    // shutdown. Without this the dashboard's transcript loses continuity
    // for any session that swapped ids before restart.
    for (const oldId of entry.aliases ?? []) {
      aliases.set(oldId, entry.sessionId);
    }
  }
  if (pruned > 0 || migrated > 0) saveCheckpoint();
  // The checkpoint cwd rewrite (above) is only half the migration: claude
  // files each transcript under ~/.claude/projects/<cwd-slug>/, so a session
  // whose cwd moved from /workspace to /home/agent/workspace also needs its
  // .jsonl relocated or `claude --resume` can't find the history and starts
  // a blank conversation. Run it unconditionally (idempotent) so it heals
  // even if the cwd rewrite already happened on a prior boot.
  const migratedTranscripts = migrateWorkspaceTranscripts();
  log.info("active-sessions", "booted", {
    dormant: slots.size,
    pruned,
    migrated,
    migratedTranscripts,
    aliases: aliases.size,
  });
}

/**
 * Claude's project-dir slug for a cwd: every `/` and `.` becomes `-`.
 * `/workspace` → `-workspace`; `/home/agent/workspace` → `-home-agent-workspace`.
 */
function projectDirForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * Move transcripts filed under the legacy `/workspace` project dir into the
 * new `/home/agent/workspace` project dir. Idempotent: only moves a file when
 * the target doesn't already exist, so it's safe to run on every boot and
 * under duplicate module instances. Returns the count moved.
 */
function migrateWorkspaceTranscripts(): number {
  const oldDir = join(PROJECTS_DIR, projectDirForCwd("/workspace"));
  const newDir = join(PROJECTS_DIR, projectDirForCwd("/home/agent/workspace"));
  if (!existsSync(oldDir)) return 0;
  let moved = 0;
  try {
    mkdirSync(newDir, { recursive: true });
    for (const name of readdirSync(oldDir)) {
      if (!name.endsWith(".jsonl")) continue;
      const src = join(oldDir, name);
      const dst = join(newDir, name);
      if (existsSync(dst)) continue; // already migrated
      try {
        renameSync(src, dst);
      } catch (err: any) {
        // Cross-device (EXDEV) or similar: fall back to copy + unlink.
        if (err?.code === "EXDEV") {
          copyFileSync(src, dst);
          try { unlinkSync(src); } catch { /* leave original; target exists */ }
        } else {
          log.warn("active-sessions", "transcript migrate failed for one file", {
            file: name,
            err: String(err?.message ?? err),
          });
          continue;
        }
      }
      moved++;
    }
  } catch (err: any) {
    log.warn("active-sessions", "transcript migration error", { err: String(err?.message ?? err) });
  }
  return moved;
}

function safeJson(v: unknown): string {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Permission waiters — used by the hook-driven permission gate. When a
 * PreToolUse hook posts to /permission-ask, the sandbox creates a request
 * (calling `createPermissionRequest`) and the hook then long-polls
 * /permission-wait, which calls `awaitPermissionDecision`. When the
 * dashboard posts the user's allow/deny via /sessions/:id/permission
 * (the existing endpoint, which calls `respondToPermission`), the
 * matching waiter is resolved.
 *
 * Stored as a flat module-level map (NOT per-slot): a hook's requestId
 * is unique cluster-wide and the resolver doesn't need slot context.
 */
type PermissionResolver = (result: { decision: "allow" | "deny"; reason: string | null }) => void;
const permissionWaiters = new Map<string, PermissionResolver>();
// Decisions that landed before the hook started long-polling. Tiny race in
// practice (sub-millisecond between POST return and GET start), but the
// failure mode is a 30s hang for the user — so we stash early decisions
// and let the next awaitPermissionDecision consume them.
const earlyPermissionDecisions = new Map<string, { decision: "allow" | "deny"; reason: string | null }>();

// Pending asks for sessions with NO live slot. Standalone skill runs (spawn.ts
// spawns `claude -p` without registering a controllable slot) still fire the
// PreToolUse gate, which creates a request and blocks on it. Without a home for
// that request, getPendingRequests returns nothing: the dashboard shows a
// PermissionRequest event with no actionable card, the gate times out, and the
// run is silently denied. Track those here, keyed by session id.
const slotlessPending = new Map<string, PendingPermissionRequest[]>();

function dropSlotlessPending(sessionId: string, requestId: string): void {
  const list = slotlessPending.get(sessionId);
  if (!list) return;
  const next = list.filter((r) => r.requestId !== requestId);
  if (next.length) slotlessPending.set(sessionId, next);
  else slotlessPending.delete(sessionId);
}

/**
 * Register a permission request that originated from a hook (PreToolUse).
 * Adds it to the matching session's pendingRequests so the dashboard's
 * hydration endpoint sees it, ingests a `PermissionRequest` event so the
 * dashboard SSE picks it up, and returns the requestId the hook should
 * long-poll on.
 *
 * The hook tells us its own `requestId` (we use `tool_use_id` from the
 * PreToolUse payload). If the hook doesn't supply one, we mint a UUID.
 */
// ---------- Shared plan-review comments ----------
// Inline review comments on a plan, keyed by the plan review's requestId. Held
// in memory and shared across every participant in the session (host + peers)
// so a collaborative review is visible before anyone submits. Cleared when the
// plan is decided (respondToPermission) or the sandbox restarts — ephemeral by
// design. `offset`/`length` index into the RENDERED plan text so each client
// can pin the bubble on its own layout.
export interface PlanReviewReply {
  id: string;
  author: string | null;
  body: string;
  at: number;
}
export interface PlanReviewComment {
  id: string;
  author: string | null;
  quote: string;
  offset: number;
  length: number;
  body: string;
  replies: PlanReviewReply[];
  at: number;
}
const planReviewComments = new Map<string, PlanReviewComment[]>();

export function listPlanReviewComments(requestId: string): PlanReviewComment[] {
  return (planReviewComments.get(requestId) ?? []).map((c) => ({ ...c, replies: c.replies.map((r) => ({ ...r })) }));
}
export function addPlanReviewComment(opts: {
  requestId: string; author: string | null; quote: string; offset: number; length: number; body: string;
}): PlanReviewComment {
  const c: PlanReviewComment = {
    id: randomUUID(),
    author: opts.author,
    quote: opts.quote.slice(0, 400),
    offset: Math.max(0, Math.floor(opts.offset) || 0),
    length: Math.max(0, Math.floor(opts.length) || 0),
    body: opts.body.slice(0, 4000),
    replies: [],
    at: Date.now(),
  };
  const list = planReviewComments.get(opts.requestId) ?? [];
  list.push(c);
  planReviewComments.set(opts.requestId, list);
  return c;
}
export function addPlanReviewReply(opts: { requestId: string; commentId: string; author: string | null; body: string }): boolean {
  const c = planReviewComments.get(opts.requestId)?.find((x) => x.id === opts.commentId);
  if (!c) return false;
  c.replies.push({ id: randomUUID(), author: opts.author, body: opts.body.slice(0, 4000), at: Date.now() });
  return true;
}
// Edit/remove are author-scoped: only the participant who wrote a comment may
// change or delete it. Returns a status the HTTP layer maps to 200/403/404.
export type CommentMutation = "ok" | "notfound" | "forbidden";
export function editPlanReviewComment(requestId: string, commentId: string, requester: string | null, body: string): CommentMutation {
  const c = planReviewComments.get(requestId)?.find((x) => x.id === commentId);
  if (!c) return "notfound";
  if (c.author !== requester) return "forbidden";
  c.body = body.slice(0, 4000);
  return "ok";
}
export function removePlanReviewComment(requestId: string, commentId: string, requester: string | null): CommentMutation {
  const list = planReviewComments.get(requestId);
  const c = list?.find((x) => x.id === commentId);
  if (!list || !c) return "notfound";
  if (c.author !== requester) return "forbidden";
  const next = list.filter((x) => x.id !== commentId);
  if (next.length) planReviewComments.set(requestId, next);
  else planReviewComments.delete(requestId);
  return "ok";
}
function clearPlanReviewComments(requestId: string): void {
  planReviewComments.delete(requestId);
}

/**
 * Push a SYNTHETIC plan review (see PendingPermissionRequest.synthetic). Used
 * when a plan-mode turn ends without a blocking ExitPlanMode ask: the agent's
 * final message becomes the plan, surfaced to the dashboard as an ExitPlanMode
 * pending so the existing PlanPanel renders it unchanged. No hook waits on it.
 */
function pushPlanReview(slot: LiveSlot, planText: string): void {
  // A fresh plan submission supersedes any previous pending review for this
  // session — e.g. one carried across a sandbox restart via wakeSession's
  // carryPending that was never decided. Without this it lingers alongside the
  // new one and the dashboard shows two "Needs review" cards for one session.
  const superseded = slot.pendingRequests.filter((r) => r.synthetic);
  if (superseded.length) {
    slot.pendingRequests = slot.pendingRequests.filter((r) => !r.synthetic);
    for (const s of superseded) clearPlanReviewComments(s.requestId);
  }

  const pending: PendingPermissionRequest = {
    requestId: randomUUID(),
    toolUseId: null,
    toolName: "ExitPlanMode",
    input: { plan: planText },
    decisionReason: null,
    receivedAt: Date.now(),
    author: slot.currentTurn?.author ?? "host",
    shareId: slot.currentTurn?.shareId ?? null,
    synthetic: true,
  };
  slot.pendingRequests.push(pending);
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PermissionRequest",
      ctx: {
        session_id: slot.meta.sessionId,
        tool_name: "ExitPlanMode",
        tool_input: safeJson(pending.input),
        request_id: pending.requestId,
        tool_use_id: null,
        decision_reason: null,
        author: pending.author,
      },
    }));
  } catch (e) {
    log.warn("active-sessions", "plan review ingest failed", { err: String((e as any)?.message ?? e) });
  }
}

// AGENT_DIRECTIVE_KIND / TASK_NOTIFICATION_KIND (imported above from
// @shared/turn-kinds — shared with the dashboard, which needs the exact same
// tags to hide/exclude these turns) are re-exported here since server.ts and
// other existing callers import them from active-sessions, not the shared
// module directly.
export { AGENT_DIRECTIVE_KIND, TASK_NOTIFICATION_KIND };

// Record a lifecycle notice (plan approved/rejected, question answered) as its
// own transcript event, decoupled from the model-facing steering turn. The
// notice used to ride on that turn's UserPromptSubmit `kind` — but that hook can
// be buffered or coalesced by claude when another turn is already in flight
// (e.g. a question answered mid-`/plan`, then the plan approved), dropping or
// mis-attributing the marker. Ingesting the notice directly at decision time
// makes it deterministic; the steering turn is tagged AGENT_DIRECTIVE_KIND and
// hidden so nothing double-renders.
function ingestLifecycleNotice(
  sessionId: string,
  kind: "plan-approval" | "plan-rejection" | "question-answer"
    | "preview-idle-release" | "share-idle-revoke" | "preview-taken-over",
  author: string,
  prompt: string,
): void {
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "UserPromptSubmit",
      ctx: { session_id: sessionId, prompt, author, kind },
    }));
  } catch (e) {
    log.warn("active-sessions", "lifecycle notice ingest failed", { kind, err: String((e as any)?.message ?? e) });
  }
}

/**
 * How long a preview tool may hold the model's tool call open.
 *
 * This number is dictated by `hooks/scripts/permission-gate.sh`, which performs
 * ONE long-poll (HOOOP_PERMISSION_GATE_TIMEOUT_SECONDS, default 120s) and treats
 * a timeout as a DENY. A preview whose `npm ci` takes three minutes would
 * therefore be reported to the model as "denied by the operator" — a
 * still-running step surfacing as a definite negative, which is precisely the
 * class of bug the plan/ask tools are so carefully written to avoid.
 *
 * So we settle well before that and say what is actually true: the preview is
 * still starting, it is still running in the background, call list_previews.
 */
export const PREVIEW_GATE_BUDGET_MS = 90_000;

/**
 * How long the model waits, after asking, for somebody to open the preview.
 *
 * Long enough for a person to notice a notification and click through; short
 * enough that the whole exchange — first try, nudge, wait, run — stays inside
 * PREVIEW_GATE_BUDGET_MS, because overrunning that reports to the model as the
 * operator having refused.
 */
const PREVIEW_VIEWER_NUDGE_MS = 45_000;

/**
 * Every deadline a page-tool call can spend, in one place so they can be summed.
 *
 * They have to add up to less than PREVIEW_GATE_BUDGET_MS, and they once added
 * up to EXACTLY it — so any overhead tipped a call that was still working past
 * the gate's single long-poll, and the model was told the operator had refused
 * it. Scattered across two call sites the arithmetic was nobody's job; here a
 * test can do it.
 */
export const PAGE_TOOL_BUDGET = {
  pickupMs: 5_000,
  runMs: 15_000,
  nudgePickupMs: 5_000,
  nudgeRunMs: PREVIEW_VIEWER_NUDGE_MS + 10_000,
  /** The longest the model can be held before the gate would call it a refusal. */
  worstMs: 5_000 + 15_000 + 5_000 + (PREVIEW_VIEWER_NUDGE_MS + 10_000),
};

/**
 * Settle a gate request the same way respondToPermission does.
 *
 * Used by the preview tools, whose "decision" is produced by the system rather
 * than by a human: the work is async, so there is no early decision to stash at
 * ask time and the hook is already parked on /permission-wait.
 *
 * Always DENY. The reason text IS the tool result the model reads (see the plan
 * and ask tools), and denying keeps the declaration-only MCP handler from also
 * running and appending its own "NOT DONE" message.
 */
function settlePreviewCall(requestId: string, reason: string): void {
  const waiter = permissionWaiters.get(requestId);
  if (waiter) {
    waiter({ decision: "deny", reason });
    return;
  }
  // The hook is between POST /permission-ask and GET /permission-wait; stash
  // it for whichever call gets there first.
  earlyPermissionDecisions.set(requestId, { decision: "deny", reason });
  setTimeout(() => earlyPermissionDecisions.delete(requestId), 60_000);
}

/**
 * Run a non-sharing preview tool and settle the model's parked call with the
 * result. Fire-and-forget: `createPermissionRequest` is synchronous.
 */
async function runPreviewTool(
  action: Exclude<PreviewToolAction, "share">,
  requestId: string,
  sessionId: string,
  cwd: string | null,
  input: unknown,
): Promise<void> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    switch (action) {
      case "list": {
        await refreshAll();
        const ids = new Set(expandSessionIds(sessionId));
        const mine = listPreviews().filter((p) => ids.has(p.sessionId));
        const otherCount = listPreviews().length - mine.length;
        // Scoped to this session on purpose. The model has no business reading
        // another conversation's preview names or workspace paths; the total is
        // enough to explain why a start might be refused.
        const suffix = otherCount > 0
          ? `\n\n${otherCount} other preview${otherCount === 1 ? "" : "s"} (in other sessions) also hold slots; ${PREVIEW_LIMITS.slots - listPreviews().length} free.`
          : "";
        settlePreviewCall(requestId, summarizePreviews(mine) + suffix);
        return;
      }

      case "start": {
        if (!cwd) {
          settlePreviewCall(requestId, "Cannot start a preview: this session has no working directory.");
          return;
        }
        const parsed = validatePreviewSpec(args);
        if (!parsed.ok) {
          settlePreviewCall(requestId, `Preview spec rejected: ${parsed.reason}`);
          return;
        }
        const rec = await startPreview({
          sessionId,
          sessionIds: expandSessionIds(sessionId),
          cwd,
          spec: parsed.spec,
        });
        // Remember it for a later one-click restart, and clear any "we stopped
        // this for idleness" note — something is running again.
        rememberPreviewSpec(sessionId, parsed.spec, null);
        const settled = await awaitSettled(rec.previewId, PREVIEW_GATE_BUDGET_MS);
        const final = settled ?? rec;
        if (final.state === "failed") emitPreviewEvent("PreviewFailed", final, "agent");
        else if (final.state !== "starting") emitPreviewEvent("PreviewStarted", final, "agent");
        settlePreviewCall(requestId, await describePreview(final));
        return;
      }

      default: {
        // restart / rebuild / stop all need a preview that belongs to THIS
        // session. Resolving by id alone would let one session's agent stop
        // another's app just by guessing — cross-session interference the slot
        // isolation exists to prevent.
        const id = typeof args.id === "string" ? args.id : "";
        const ids = new Set(expandSessionIds(sessionId));
        const rec = id ? getPreview(id) : previewForSession([...ids]);
        if (!rec || !ids.has(rec.sessionId)) {
          settlePreviewCall(requestId, id
            ? `No preview with id ${id} belongs to this session. Call list_previews to see this session's preview.`
            : "This session has no preview. Call start_preview first.");
          return;
        }
        if (action === "stop") {
          await stopPreview(rec.previewId);
          // Keep the spec (it still prefills a restart) but drop the idle note:
          // this stop was deliberate.
          rememberPreviewSpec(sessionId, rec.spec, null);
          emitPreviewEvent("PreviewStopped", rec, "agent");
          settlePreviewCall(requestId, `Preview "${rec.spec.name}" stopped and its slot released.`);
          return;
        }
        await (action === "restart" ? restartPreview(rec.previewId) : rebuildPreview(rec.previewId));
        const settled = await awaitSettled(rec.previewId, PREVIEW_GATE_BUDGET_MS);
        const final = settled ?? rec;
        if (action === "rebuild" && final.state !== "starting") emitPreviewEvent("PreviewRebuilt", final, "agent");
        if (final.state === "failed") emitPreviewEvent("PreviewFailed", final, "agent");
        settlePreviewCall(requestId, await describePreview(final));
        return;
      }
    }
  } catch (e) {
    const err = e as { message?: string };
    const message = e instanceof PreviewError
      ? err.message ?? "preview operation failed"
      : `preview operation failed: ${String(err?.message ?? e)}`;
    log.warn("active-sessions", "preview tool failed", { action, err: message });
    settlePreviewCall(requestId, message);
  }
}

/**
 * Run one page-driving tool: hand the action to the dashboard and settle the
 * model's parked call with what the watching pages did.
 *
 * The preview is resolved from the SESSION, never from an id the model supplies,
 * for the same reason stop/restart are: a page belongs to whoever is looking at
 * it, and guessing another session's preview id must not put your clicks on
 * their screen.
 */
async function runPageTool(
  action: string,
  requestId: string,
  sessionId: string,
  input: unknown,
): Promise<void> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    await refreshAll();
    const ids = new Set(expandSessionIds(sessionId));
    const rec = previewForSession([...ids]);
    if (!rec) {
      settlePreviewCall(requestId, "This session has no preview running, so there is no page to drive. Call start_preview first.");
      return;
    }
    if (rec.state !== "running" && rec.state !== "shared") {
      settlePreviewCall(requestId, `The preview "${rec.spec.name}" is ${rec.state}, so there is no page to drive yet. Call list_previews to see where it got to.`);
      return;
    }
    // Somebody is using this session's app right now — the idle sweeper should
    // not be measuring from whenever the last turn happened.
    markSessionActive(sessionId);
    const base = { previewId: rec.previewId, slot: rec.slot, action, params: args };
    // Comfortably inside PREVIEW_GATE_BUDGET_MS: a page action is a click, not
    // an npm install, and the gate reads a timeout as a human's refusal.
    // Budgeted so first-try + nudge + retry fits inside PREVIEW_GATE_BUDGET_MS
    // with room to spare. It used to add up to exactly 90s — the budget to the
    // millisecond — so any overhead at all tipped the call past the gate's
    // long-poll, and the model was told the OPERATOR had refused it. A margin is
    // not tidiness here: without one the failure mode is a lie about a human.
    let r = await driveQueue.request(base,
      { pickupMs: PAGE_TOOL_BUDGET.pickupMs, runMs: PAGE_TOOL_BUDGET.runMs });

    if (r.reason === "no-viewer") {
      // Nobody is watching, and there is deliberately nothing to fall back to —
      // a headless browser would give the model a second session diverging from
      // the screen, invisibly. So ask, out loud, and wait: the nudge reaches
      // every participant as a notification and a transcript line, and if
      // somebody opens the panel within the window the action still runs. The
      // model then reports what happened rather than a bare refusal.
      emitPreviewEvent("PreviewNeedsViewer", rec, "agent");
      r = await driveQueue.request(
        { ...base, waitForViewerMs: PREVIEW_VIEWER_NUDGE_MS },
        { pickupMs: PAGE_TOOL_BUDGET.nudgePickupMs, runMs: PAGE_TOOL_BUDGET.nudgeRunMs },
      );
      if (r.reason === "no-viewer") {
        settlePreviewCall(requestId, `Nobody opened the preview, so ${action} did not run. Everyone in the session has been asked to open the Browser panel — say what you were trying to do and wait for them, rather than looking for another way in.`);
        return;
      }
    }
    settlePreviewCall(requestId, describeDriveResult(action, r));
  } catch (e) {
    const err = e as { message?: string };
    log.warn("active-sessions", "page tool failed", { action, err: String(err?.message ?? e) });
    settlePreviewCall(requestId, `Could not drive the page: ${String(err?.message ?? e)}`);
  }
}

/**
 * Stamp `pending.critical` — the single answer to "is this ask the host's alone?".
 *
 * A function rather than an expression because there are TWO places a pending
 * request is born: the hook gate (createPermissionRequest, below) and the
 * subprocess's own `control_request`/`can_use_tool` frame (see the stdout reader).
 * The second one bypasses the first entirely, so stamping only where the gate
 * happens to compute it left every ask arriving by the control protocol unflagged —
 * and an unflagged ask reads as routine, which hands `rm -rf` back to the
 * full-capability peer the flag exists to keep away from it. A fail-open with no
 * symptom: the card still appears, it just accepts the wrong person's answer.
 */
function markCritical(pending: PendingPermissionRequest, cwd: string | null, sessionId?: string | null): boolean {
  pending.critical =
    isCriticalTool(pending.toolName, pending.input, cwd, sessionId ? sessionScratchDir(sessionId) : null) ||
    // Publishing agent-written code to a public URL is a human decision every
    // time, in every mode — and the host's, not a guest's.
    previewToolAction(pending.toolName) === "share";
  return pending.critical;
}

export function createPermissionRequest(opts: {
  sessionId: string;
  toolName: string;
  input: unknown;
  toolUseId?: string | null;
  requestId?: string | null;
  decisionReason?: string | null;
  /**
   * Who to attribute the ask to, when the caller knows better than the current
   * turn does. Normally an ask arrives mid-turn and the driver IS the attribution,
   * but the `!bash` shortcut has no turn at all — it bypasses the model — so
   * without these a guest's `rm -rf` would surface on the host's own card as if the
   * host had asked for it, and the trust key would be wrong too.
   */
  author?: string | null;
  shareId?: string | null;
}): { requestId: string; sessionId: string } {
  const slot = getSlot(opts.sessionId);
  const canonicalSid = slot?.meta.sessionId ?? opts.sessionId;
  const requestId = opts.requestId || opts.toolUseId || randomUUID();
  // Normalize the bundled MCP ask tool (mcp__plugin_hooop_tools__ask_user_question)
  // to the native "AskUserQuestion" name, so the pending request — and everything
  // downstream keyed on toolName (dashboard AskQuestion UI, capability gating, the
  // deny+follow-up-turn answer relay) — treats it exactly like the native tool.
  const toolName = isAskUserQuestionTool(opts.toolName) ? "AskUserQuestion" : opts.toolName;
  // Attribute the ask to whoever drove the current turn (host or a peer).
  const turn = slot?.currentTurn ?? null;
  const pending: PendingPermissionRequest = {
    requestId,
    toolUseId: opts.toolUseId ?? null,
    toolName,
    input: opts.input,
    decisionReason: opts.decisionReason ?? null,
    receivedAt: Date.now(),
    author: opts.author ?? turn?.author ?? "host",
    shareId: opts.shareId ?? turn?.shareId ?? null,
    planMode: slot?.planTurnActive === true,
  };

  // Invalidate any decision still stashed under this requestId. A new ask
  // supersedes an older one with the same id, so a leftover entry can only be
  // stale — and leaving it there is exploitable, not merely untidy:
  //
  //   requestId is claude's tool_use_id. An ask that needs a human (a critical
  //   Bash, say) deliberately does NOT write a decision — it pushes a card and
  //   lets the hook long-poll. So a decision pre-seeded under that same id by
  //   an EARLIER, benign ask would still be sitting here, and
  //   awaitPermissionDecision would hand it to the long-poll as an `allow`
  //   before the operator ever saw the card.
  //
  // Clearing here means the only decision a wait can consume is one produced
  // by the ask it is actually waiting on.
  earlyPermissionDecisions.delete(requestId);

  // Answer the hook immediately (its /permission-wait consumes this) without a
  // dashboard card. Used by the plan-mode gate and the non-plan Bash fast-lane.
  const decideNow = (decision: "allow" | "deny", reason: string): { requestId: string; sessionId: string } => {
    earlyPermissionDecisions.set(requestId, { decision, reason });
    setTimeout(() => earlyPermissionDecisions.delete(requestId), 60_000);
    return { requestId, sessionId: canonicalSid };
  };

  // ── Plan lifecycle tools ─────────────────────────────────────────────────
  // The model submits/enters plans via the bundled hooop MCP tools
  // (mcp__plugin_hooop_tools__{submit_plan,enter_plan_mode}); the native
  // ExitPlanMode name is matched too (it's absent in headless mode, but harmless
  // to keep). Handled up front, independent of plan-mode state, so a submitted
  // plan is ALWAYS captured. The PreToolUse deny blocks dispatch, so the MCP
  // handler never runs — all real behavior lives here.
  if (isPlanSubmitTool(opts.toolName)) {
    // Deterministic plan capture (replaces the heuristic result-frame path as the
    // primary): pull the plan from the tool input (or the turn's assistant prose),
    // surface it for review via pushPlanReview — the SAME review the dashboard
    // renders and inline comments/annotations attach to (keyed by its requestId)
    // — then DENY so the turn stops and holds for approval.
    const cur = pending.input;
    const planStr = cur && typeof cur === "object" ? (cur as { plan?: unknown }).plan : undefined;
    const planText = typeof planStr === "string" && planStr.trim()
      ? (planStr as string)
      : (slot?.lastAssistantText ?? "");
    // Only claim submission when a review actually opened. If both the `plan`
    // argument and the assistant-prose fallback are empty — or there's no live
    // slot to hang the review on — nothing was captured and no card will ever
    // surface, so the old unconditional "submitted for review" left the model
    // stopped and waiting for an approval that could not arrive. Same failure as
    // an auto-approved ask: a human-in-the-loop step reported as done when it
    // never happened. Say what actually occurred; the empty-plan case is
    // recoverable in a single retry, so name the retry.
    if (slot && planText.trim()) {
      pushPlanReview(slot, planText);
      return decideNow("deny", "Your plan has been submitted for review. Stop here — do not act until it is approved.");
    }
    if (slot) {
      return decideNow(
        "deny",
        "No plan was captured — your submit_plan call carried no plan text. Nothing was sent for review. Call submit_plan again with the plan itself in the `plan` argument.",
      );
    }
    return decideNow(
      "deny",
      "No plan was captured: this session has no live slot to open a review on. Do not wait for an approval — report your plan in your reply instead.",
    );
  }
  if (isEnterPlanTool(opts.toolName)) {
    // Model-initiated plan mode: flip the session read-only for the rest of the
    // turn. Deny-with-guidance (the reason IS the model-facing instruction) keeps
    // the MCP server declaration-only.
    if (slot) slot.planTurnActive = true;
    return decideNow("deny", "Plan mode engaged — this session is now read-only. Investigate with Read/Grep/Glob, then call the submit_plan tool with your plan.");
  }

  // ── Plan-mode enforcement (hard read-only) ───────────────────────────────
  // While a `/plan` turn is active (slot.planTurnActive), the gate routes every
  // non-read tool here and we answer immediately, so the agent CANNOT mutate
  // until the plan is approved — enforcement is mechanical, not a prompt.
  // AskUserQuestion is carved out: clarifying questions don't mutate anything
  // (the answer is relayed back as a follow-up user turn), and they're most
  // useful DURING planning — to resolve a design decision before submitting the
  // plan. Let it fall through to the normal ask handling below, which surfaces
  // the dashboard question card. The answer relay (respondToPermission) reads
  // `pending.planMode` to keep the session in plan mode afterwards.
  if (slot?.planTurnActive && !isAskUserQuestionTool(opts.toolName)) {
    if (!PLAN_READONLY_TOOLS.has(opts.toolName)) {
      return decideNow(
        "deny",
        "Plan mode: this session is read-only until the plan is approved. Investigate with Read/Grep/Glob, then submit your plan with the submit_plan tool.",
      );
    }
    // Read-only, but "read-only" is not the same as "harmless": reading a
    // credential is the first half of an exfiltration chain, and plan mode is
    // otherwise a wide-open read surface. Contained reads pass; anything
    // reaching outside the workdir still needs a human.
    if (isCriticalTool(opts.toolName, pending.input, slot.meta.cwd, sessionScratchDir(slot.meta.sessionId))) {
      return decideNow(
        "deny",
        "Plan mode: that path is outside this session's working directory. Investigate within the workdir, then submit your plan with the submit_plan tool.",
      );
    }
    return decideNow("allow", "read-only (plan mode)");
  }

  // ── Live-preview tools ────────────────────────────────────────────────────
  // Placed AFTER the plan-mode block on purpose: these start processes, so a
  // `/plan` turn must refuse them like any other mutation. (They are also
  // deliberately absent from PLAN_READONLY_TOOLS.)
  //
  // Everything except share_preview runs WITHOUT a card. That isn't a lax
  // default: the model can already run arbitrary commands through Bash in this
  // container, so running them in a strictly less privileged one — no
  // credentials, no control socket, no route to the sandbox — is not an
  // escalation, and a merely-running preview is reachable only from the
  // operator's own loopback. share_preview is the step that publishes
  // agent-authored code to a public URL, and that is what gets a human.
  const previewAction = previewToolAction(opts.toolName);
  if (previewAction && previewAction !== "share") {
    // No early decision: the work is async and can legitimately take a while.
    // The hook is already long-polling /permission-wait, so we settle it when
    // the work finishes. See runPreviewTool for why the budget is bounded.
    void runPreviewTool(previewAction, requestId, canonicalSid, slot?.meta.cwd ?? null, pending.input);
    return { requestId, sessionId: canonicalSid };
  }

  // Driving the page needs no card for the same reason: it acts inside a preview
  // container the model could already reach through Bash. What is new is that a
  // human SEES it — every action is drawn on their screen as it happens, and a
  // single real click takes the page away from the model. That is a better check
  // than a dialog, because it is the person who is already watching.
  const pageAction = pageToolAction(opts.toolName);
  if (pageAction) {
    void runPageTool(pageAction, requestId, canonicalSid, pending.input);
    return { requestId, sessionId: canonicalSid };
  }
  if (previewAction === "share") {
    // Resolve the target BEFORE surfacing a card, for two reasons. A preview
    // belonging to another session must not be shareable by guessing its id —
    // that would defeat the per-session isolation the slots provide. And a card
    // that cannot possibly succeed (nothing running yet) wastes a human's
    // attention on a decision with no effect.
    const shareArgs = (pending.input && typeof pending.input === "object" ? pending.input : {}) as Record<string, unknown>;
    const wantedId = typeof shareArgs.id === "string" ? shareArgs.id : "";
    const sessionIdSet = new Set(expandSessionIds(canonicalSid));
    const target = wantedId ? getPreview(wantedId) : previewForSession([...sessionIdSet]);
    if (!target || !sessionIdSet.has(target.sessionId)) {
      return decideNow("deny", wantedId
        ? `No preview with id ${wantedId} belongs to this session. Call list_previews first.`
        : "This session has no preview to share. Call start_preview first.");
    }
    if (target.state === "shared") {
      return decideNow("deny", `Preview "${target.spec.name}" is already shared at ${target.publicUrl}.`);
    }
    if (target.state !== "running") {
      return decideNow("deny", `Preview "${target.spec.name}" is ${target.state}, so there is nothing to share yet. It must be running first.`);
    }
    // Re-point the card at the resolved preview so the human sees WHAT they are
    // publishing — the name, the command that will be reachable, and the setup
    // that produced it — rather than an opaque id.
    pending.input = {
      previewId: target.previewId,
      name: target.spec.name,
      run: target.spec.run,
      setup: target.spec.setup ?? [],
      workdir: target.spec.workdir ?? null,
      localUrl: `http://127.0.0.1:${target.slotPort}`,
    };
  }

  // ── Read fast-lane (moved out of permission-gate.sh) ──────────────────────
  // These used to be fast-allowed by the hook itself, with NO path check and
  // without the sandbox ever seeing them — which left `Read` as an ungated way
  // to pull ~/.claude/.credentials.json or the sandbox token out of a session,
  // completely invisibly. They now route here so the sandbox stays the single
  // policy authority. Still no card and no round trip to the dashboard for the
  // overwhelmingly common case (a read inside the workdir); only an escape
  // escalates.
  if (READ_FAST_LANE_TOOLS.has(opts.toolName)) {
    if (!isCriticalTool(opts.toolName, pending.input, slot?.meta.cwd ?? null, slot ? sessionScratchDir(slot.meta.sessionId) : null)) {
      return decideNow("allow", "auto-allowed (read, within workdir)");
    }
    // Outside the workdir / a secret path → fall through to a dashboard prompt.
  }

  // ── Non-plan Bash fast-lane (moved out of permission-gate.sh) ─────────────
  // The gate no longer auto-allows Bash; keep it frictionless here — no card, no
  // transcript record — EXCEPT the critical set (git + destructive/secret
  // commands, see isCriticalBash), which always escalates to a host prompt.
  //
  // Note this is a COMMAND-string denylist, which is inherently evadable. It is
  // not the boundary for Bash — Landlock is (see bashConfinementEnv); this just
  // decides what deserves a human's attention.
  if (opts.toolName === "Bash") {
    const bashCmd = (pending.input as { command?: unknown } | null)?.command;
    if (!(typeof bashCmd === "string" && isCriticalBash(bashCmd))) {
      return decideNow("allow", "auto-allowed (bash)");
    }
    // critical bash → fall through to a dashboard prompt (host-only decision).
  }

  // Immediate auto-approve: hand the hook an allow when it long-polls
  // /permission-wait and record it in the transcript as an auto-approval. Does
  // NOT push to pendingRequests — no card surfaces for an auto-approved ask.
  const autoApprove = (reason: string) => {
    earlyPermissionDecisions.set(requestId, { decision: "allow", reason });
    setTimeout(() => earlyPermissionDecisions.delete(requestId), 60_000);
    try {
      ingestEventLine(JSON.stringify({
        ts: new Date().toISOString(),
        hook: "PermissionResponse",
        ctx: {
          session_id: canonicalSid,
          tool_name: pending.toolName,
          tool_input: typeof pending.input === "string" ? pending.input : safeJson(pending.input),
          request_id: requestId,
          tool_use_id: pending.toolUseId,
          decision: "allow",
          author: pending.author,
          auto: true,
        },
      }));
    } catch (e) {
      log.warn("active-sessions", "auto-approve ingest failed", { err: String((e as any)?.message ?? e) });
    }
    return { requestId, sessionId: canonicalSid };
  };

  // The critical set gates EVERY unattended-approval branch below. Evaluated
  // once, against this session's workdir, so all three agree on what "critical"
  // means: git, destructive/secret bash, a secret path, an MCP write, or
  // any path argument outside the session's own directory.
  //
  // Previously only auto mode consulted this — the approved-plan and
  // trusted-peer branches skipped it entirely, which made them strictly more
  // permissive than the mode the host has to opt into explicitly. A `Write` to
  // ~/.ssh/authorized_keys was auto-approved under an approved plan while auto
  // mode would have prompted for it. That asymmetry was not intentional.
  //
  // share_preview is folded in here rather than guarded at each branch below,
  // so that any FUTURE unattended-approval path inherits the protection by
  // construction — the asymmetry described above (approved-plan and
  // trusted-peer once skipped the critical set entirely) is exactly the bug
  // that gets reintroduced when a tool has to be remembered in three places.
  // Sharing publishes agent-authored code to a public tunnel URL; that is a
  // decision for a human every time, in every mode.
  // Stamped on the request, not just computed: everything below decides whether to
  // escalate, and this is what makes the escalation land on the right person once
  // it does — the permission route reads it to keep a critical ask host-only, and
  // the dashboard reads it to show a peer a waiting state instead of buttons they
  // must not have.
  const critical = markCritical(pending, slot?.meta.cwd ?? null, slot?.meta.sessionId ?? null);

  // The ask tool gates those same branches, for a sharper reason than the
  // critical set: an unattended approval of an ask does not merely skip a
  // confirmation, it DISCARDS THE QUESTION. Nothing here can answer one — the ask
  // is deny-and-relay by design (the operator's pick comes back as a follow-up
  // turn, see respondToPermission), so "allow" lets dispatch reach the
  // declaration-only MCP handler, which acks. The operator is never asked and the
  // model reads an answer-shaped success, which is worse than a denial: it can't
  // tell the question was dropped, so it proceeds on an assumption it believes
  // was confirmed.
  //
  // Matched via isAskUserQuestionTool, NOT a bare === against the native name.
  // The bundled alias (mcp__plugin_hooop_tools__ask_user_question) is the tool the
  // model actually calls, because headless claude has no native AskUserQuestion —
  // which is the whole reason the alias exists. A raw-name comparison here isn't
  // a partial guard, it's an inert one: it only ever matches a name that never
  // arrives in a dashboard session.
  const isAsk = isAskUserQuestionTool(opts.toolName);

  // Approved-plan execution: the host reviewed and approved this plan, so its
  // routine tool calls run WITHOUT re-prompting. Scoped to the single execution
  // turn (see slot.autoAllowPlanRun). Approving a plan is not the same as
  // approving whatever the plan's execution later decides to touch, so the
  // critical set still escalates.
  if (slot?.autoAllowPlanRun && !critical && !isAsk) {
    return autoApprove("auto: approved plan");
  }

  // Session-scoped "allow all from $peer": if this ask comes from a turn driven
  // by a trusted peer, auto-approve without prompting the host — except the
  // critical set, which always escalates to the host.
  if (slot && pending.shareId && slot.trustedShareIds.has(pending.shareId) && !critical && !isAsk) {
    return autoApprove("auto: trusted peer");
  }

  // Session auto-mode: the host opted into unattended approval. Auto-approve
  // everything that reached here EXCEPT the critical set and interactive
  // AskUserQuestion (which needs a real operator answer). Placed AFTER the
  // plan-lifecycle and plan-mode-read-only blocks above, so a `/plan` turn
  // stays hard read-only regardless of auto mode.
  if (slot?.meta.autoMode && !isAsk && !critical) {
    return autoApprove("auto: auto mode");
  }

  if (slot) {
    slot.pendingRequests.push(pending);
  } else {
    // No live slot. Skill runs used to land here (the old detached spawn.ts +
    // /runs path), but since 27054af they are first-class sessions that own a
    // slot like any other — a skill run differs only by the `via: "skill"` hint
    // on its meta. What reaches this branch now is an ask whose slot vanished
    // mid-flight: the session ended, was purged, or had its id remapped between
    // the tool call and the gate's ask. Keep it actionable rather than dropping
    // it (see slotlessPending), or the dashboard shows an event with no card and
    // the call times out to a deny.
    const list = slotlessPending.get(canonicalSid) ?? [];
    list.push(pending);
    slotlessPending.set(canonicalSid, list);
    // Safety net: never-answered asks (gate timeout) shouldn't accumulate.
    setTimeout(() => dropSlotlessPending(canonicalSid, requestId), 130_000);
  }
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PermissionRequest",
      ctx: {
        session_id: canonicalSid,
        tool_name: pending.toolName,
        tool_input: typeof pending.input === "string" ? pending.input : safeJson(pending.input),
        request_id: pending.requestId,
        tool_use_id: pending.toolUseId,
        decision_reason: pending.decisionReason,
        author: pending.author,
      },
    }));
  } catch (e) {
    log.warn("active-sessions", "permission request ingest failed", { err: String((e as any)?.message ?? e) });
  }
  return { requestId, sessionId: canonicalSid };
}

/**
 * Wait for the dashboard to decide on a permission request. Returns the
 * decision on success or `{ decision: "timeout" }` on timeout. Idempotent
 * cleanup: if a decision arrives after timeout, the resolver is a no-op.
 */
/**
 * Read an already-stashed decision WITHOUT consuming it, so /permission-ask can
 * answer the hook inline and skip the /permission-wait long-poll.
 *
 * Deliberately non-consuming: the hook may still fall through to the long-poll
 * (an older gate script, a lost response, a retry), and consuming here would
 * turn the decision into a timeout — which the gate reads as DENY. The entry
 * expires on its own via the existing 60s sweep in decideNow/autoApprove.
 */
export function peekPermissionDecision(
  requestId: string,
): { decision: "allow" | "deny"; reason: string | null } | null {
  return earlyPermissionDecisions.get(requestId) ?? null;
}

/**
 * Take a pending ask back off the board because nobody is waiting on it any more.
 *
 * awaitPermissionDecision's timeout deletes the WAITER and leaves the request
 * pending, which is right for the hook gate — claude is still blocked, the hook
 * long-polls again, and the card must stay. It is wrong for an ask the sandbox
 * itself raised and then gave up on, like a guest's `!bash` that timed out: the
 * guest has already been told nobody answered, while the card sits on the host's
 * screen indefinitely. Clicking Allow on it then does nothing at all — there is no
 * waiter left to resolve — so the host believes they authorised a destructive
 * command and no part of the system agrees.
 *
 * A stale control that silently does nothing is worse than no control, because it
 * teaches the operator that Allow is unreliable on exactly the cards where they are
 * being careful.
 *
 * Emits a PermissionResponse so the dashboard drops the card the same way it does
 * for a real decision, and so the transcript records why it went away.
 */
export function withdrawPermissionRequest(
  sessionId: string,
  requestId: string,
  reason: string,
): { ok: boolean } {
  const slot = getSlot(sessionId);
  let removed: PendingPermissionRequest | null = null;
  if (slot) {
    const idx = slot.pendingRequests.findIndex((r) => r.requestId === requestId);
    if (idx >= 0) removed = slot.pendingRequests.splice(idx, 1)[0];
  }
  if (!removed) {
    const list = slotlessPending.get(sessionId);
    const idx = list?.findIndex((r) => r.requestId === requestId) ?? -1;
    if (list && idx >= 0) removed = list.splice(idx, 1)[0];
  }
  if (!removed) return { ok: false };

  // Any decision stashed for a waiter that no longer exists would otherwise sit in
  // the map until its own timer, and could be handed to a LATER ask that reuses the
  // id (claude's tool_use_id is not ours to assume unique across time).
  earlyPermissionDecisions.delete(requestId);

  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PermissionResponse",
      ctx: {
        session_id: slot?.meta.sessionId ?? sessionId,
        tool_name: removed.toolName,
        request_id: requestId,
        decision: "withdrawn",
        reason,
        message: reason,
      },
    }));
  } catch { /* non-fatal */ }
  return { ok: true };
}

export function awaitPermissionDecision(
  requestId: string,
  timeoutMs: number,
): Promise<{ decision: "allow" | "deny" | "timeout"; reason: string | null }> {
  // Consume an early decision if one is stashed (race: dashboard responded
  // before the hook started long-polling).
  const early = earlyPermissionDecisions.get(requestId);
  if (early) {
    earlyPermissionDecisions.delete(requestId);
    return Promise.resolve(early);
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: { decision: "allow" | "deny" | "timeout"; reason: string | null }) => {
      if (settled) return;
      settled = true;
      permissionWaiters.delete(requestId);
      resolve(r);
    };
    permissionWaiters.set(requestId, (r) => finish(r));
    setTimeout(() => finish({ decision: "timeout", reason: null }), Math.max(1000, timeoutMs));
  });
}

/**
 * Read pending permission requests for a session. Returns an empty array
 * for unknown / restarted sessions. Used by GET /sessions/:id/pending-requests
 * so the dashboard can hydrate after a page reload.
 */
export function getPendingRequests(sessionId: string): PendingPermissionRequest[] {
  const slot = getSlot(sessionId);
  if (slot) return slot.pendingRequests.map((r) => ({ ...r }));
  const list = slotlessPending.get(sessionId);
  return list ? list.map((r) => ({ ...r })) : [];
}

/**
 * Answer a permission ask. Writes a `control_response` frame to the
 * subprocess stdin and removes the request from the pending queue.
 * Reuses the existing per-session writeQueue so we don't interleave
 * with a user turn already in flight.
 */
export async function respondToPermission(
  sessionId: string,
  requestId: string,
  decision: "allow" | "deny",
  reason: string | null = null,
  trustPeer = false,
  answerAuthor: string | null = null,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const slot = getSlot(sessionId);

  // Locate the request in the live slot, or — for a standalone skill run with
  // no slot — in the slot-less store. Either way we resolve it identically:
  // the hook long-poll (keyed by requestId) is what unblocks the turn.
  let pending: PendingPermissionRequest;
  let canonicalSid: string;
  if (slot) {
    if (slot.meta.status === "expired") return { ok: false, reason: "session expired" };
    const idx = slot.pendingRequests.findIndex((r) => r.requestId === requestId);
    if (idx < 0) return { ok: false, reason: "unknown request" };
    // "Allow all from $peer": grant session-scoped trust to the driving peer so
    // their later asks auto-approve. Only meaningful on an allow of a peer-driven
    // request; ignored for host asks or denials.
    if (trustPeer && decision === "allow") {
      const sid = slot.pendingRequests[idx].shareId;
      if (sid) slot.trustedShareIds.add(sid);
    }
    pending = slot.pendingRequests[idx];
    slot.pendingRequests.splice(idx, 1);
    canonicalSid = slot.meta.sessionId;
    clearPlanReviewComments(requestId); // review is over once decided

    // A synthesized plan review has no hook waiting on it. Approve → leave plan
    // mode and tell the agent to proceed; reject → send the feedback and stay
    // in plan mode so it revises (writeUserTurn handles reviving a dormant
    // between-turns subprocess). Record the decision and return early — the
    // waiter path below only applies to real (blocking) asks.
    if (pending.synthetic) {
      // Attribute the decision turn to whoever actually decided (host or a
      // full-capability peer), so the transcript's PlanDecisionNotice shows the
      // right name instead of always crediting the host.
      const decider = answerAuthor ?? "host";
      if (decision === "allow") {
        const proceed = "The plan is approved — proceed with implementing it.";
        // Deterministic notice first, then the hidden steering turn.
        ingestLifecycleNotice(canonicalSid, "plan-approval", decider, proceed);
        void writeUserTurn(canonicalSid, proceed, decider, null, { mode: "bypassPermissions", kind: AGENT_DIRECTIVE_KIND, autoAllowRun: true })
          .catch((e) => log.warn("active-sessions", "plan approve turn failed", { err: String((e as any)?.message ?? e) }));
      } else {
        const fb = reason?.trim() ? reason.trim() : "Please revise the plan.";
        const revise = `The plan was rejected. Revise it based on this feedback:\n\n${fb}`;
        ingestLifecycleNotice(canonicalSid, "plan-rejection", decider, revise);
        void writeUserTurn(canonicalSid, revise, decider, null, { mode: "plan", kind: AGENT_DIRECTIVE_KIND })
          .catch((e) => log.warn("active-sessions", "plan reject turn failed", { err: String((e as any)?.message ?? e) }));
      }
      try {
        ingestEventLine(JSON.stringify({
          ts: new Date().toISOString(),
          hook: "PermissionResponse",
          ctx: { session_id: canonicalSid, tool_name: pending.toolName, tool_input: safeJson(pending.input), request_id: requestId, tool_use_id: null, decision },
        }));
      } catch { /* best-effort transcript record */ }
      return { ok: true };
    }
  } else {
    const list = slotlessPending.get(sessionId) ?? [];
    const found = list.find((r) => r.requestId === requestId);
    if (!found) return { ok: false, reason: "unknown request" };
    pending = found;
    dropSlotlessPending(sessionId, requestId);
    canonicalSid = sessionId;
    clearPlanReviewComments(requestId); // review is over once decided
  }

  // Notify the hook's long-poll — that's the path that actually unblocks the
  // turn. The hook's stdout JSON (emitted by permission-gate.sh) carries the
  // allow/deny back to claude via the standard hookSpecificOutput contract,
  // so we deliberately do NOT write a control_response frame to claude's
  // stdin. Empirically, claude in `-p` print mode never emits
  // control_request, and a stray control_response frame on stdin caused
  // claude to exit early (turn went dormant after Allow without the tool
  // actually running) — observed in the stoic-blowing-lovelace session.
  // AskUserQuestion has no native answer channel in headless mode. We unblock
  // the tool with a deny, but the operator's selection is delivered as a
  // follow-up user turn (below) — a denied tool alone just gets acknowledged
  // and the model stops. Keep the deny reason minimal so the model waits for
  // that turn instead of half-acting on the reason text.
  const isAskAnswer = pending.toolName === "AskUserQuestion" && decision === "deny";
  const relayReason = isAskAnswer
    ? "The operator answered your question — their answer follows in the next message."
    : reason;

  const waiter = permissionWaiters.get(requestId);
  if (waiter) {
    waiter({ decision, reason: relayReason });
  } else {
    // No long-poller has registered yet (the hook is between POST and GET).
    // Stash so the next awaitPermissionDecision consumes it. Auto-expire to
    // avoid leaking entries when a hook crashes before getting to long-poll.
    earlyPermissionDecisions.set(requestId, { decision, reason: relayReason });
    setTimeout(() => earlyPermissionDecisions.delete(requestId), 60_000);
  }

  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook: "PermissionResponse",
      ctx: {
        session_id: canonicalSid,
        tool_name: pending.toolName,
        tool_input: typeof pending.input === "string" ? pending.input : safeJson(pending.input),
        request_id: requestId,
        tool_use_id: pending.toolUseId,
        decision,
      },
    }));
  } catch (e) {
    log.warn("active-sessions", "permission response ingest failed", { err: String((e as any)?.message ?? e) });
  }

  // Deliver the answer as a user turn so the model resumes the task WITH it.
  // Mirrors the synthetic-plan approve/reject follow-up. Runs after the waiter
  // is unblocked, so it queues as the next turn on the same stdin pipe.
  if (isAskAnswer) {
    const answer = (reason ?? "").trim() || "(the operator did not provide a specific answer)";
    const who = answerAuthor ?? "host";
    // Surface the answer as its own "Question answered" notice (with the picked
    // options), decoupled from the model-facing relay turn — which is tagged as
    // a hidden directive so it never renders as a plain chat bubble from the
    // peer. See ingestLifecycleNotice for why the notice can't ride on the relay
    // turn's own hook.
    ingestLifecycleNotice(canonicalSid, "question-answer", who, answer);
    // If the question was asked during a /plan turn, keep the session in plan
    // mode for the answer turn. Without this, writeUserTurn (mode undefined)
    // would set slot.planTurnActive = false and silently drop plan-mode
    // enforcement — letting the model mutate before its plan is approved.
    // The same hazard as plan mode above, one field over. writeUserTurn rewrites
    // slot.autoAllowPlanRun from its opts on every turn, so relaying the answer
    // without autoAllowRun would CLOSE an approved plan's auto-allow window mid
    // execution — one clarifying question would silently revoke the approval and
    // make every remaining write in the run re-prompt. The window is still open
    // at this point (it closes at the result frame, and the turn is parked on
    // this very ask), and answering a question continues that execution rather
    // than starting new work, so carry the flag across. Only reachable since asks
    // stopped being auto-approved during an approved-plan run.
    const planRunOpen = getSlot(canonicalSid)?.autoAllowPlanRun === true;
    const relayOpts = pending.planMode
      ? { mode: "plan" as const, kind: AGENT_DIRECTIVE_KIND }
      : { kind: AGENT_DIRECTIVE_KIND, ...(planRunOpen ? { autoAllowRun: true } : {}) };
    void writeUserTurn(
      canonicalSid,
      `${answer}\n\nThat is my answer to the question you just asked — please continue with the task using it.`,
      who,
      null,
      relayOpts,
    ).catch((e) => log.warn("active-sessions", "askquestion follow-up turn failed", { err: String((e as any)?.message ?? e) }));
  }

  return { ok: true };
}

