/**
 * Preview registry — the sandbox's authoritative record of which session is
 * previewing what, and the client for the runner containers that actually
 * execute it.
 *
 * The sandbox deliberately does NOT run preview processes. A preview is
 * agent-authored, long-lived and network-facing; this container holds the
 * claude binary, the Claude OAuth credentials, events.db and the control
 * socket. So the work happens in `preview-runner-<n>`, which has none of those,
 * and this module is bookkeeping plus a thin UDS client.
 *
 * SLOTS. There are three runner containers, declared statically in compose.
 * A slot is LEASED to one session for the life of its preview, which is what
 * makes "isolated by session" true at the container level: separate network,
 * separate PID namespace, separate process tree. One preview per session, so
 * slot == session == preview and the bookkeeping stays trivial.
 *
 * WHY A LEASE ID. Slots are recycled. Every runner call carries the leaseId the
 * slot is currently held under, so a request that was in flight when a lease
 * ended cannot land on the session that took the slot next.
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { request as udsRequest } from "node:http";
import { join, relative, resolve, sep } from "node:path";
import { log } from "@shared/logger";
import {
  PREVIEW_LIMITS,
  type PreviewLog,
  type PreviewPhase,
  type PreviewRunnerStatus,
  type PreviewSpec,
  type PreviewState,
} from "@shared/preview-spec";
import { SESSIONS_ROOT, WORKSPACE_DIR } from "./paths";
import { canonicalize } from "./cwd-policy";
import { ingestEventLine } from "./ingestor";

const SOCKET_DIR = process.env.HOOOP_PREVIEW_SOCKET_DIR || "/var/run/hooop-preview";
/** First published container port; slot n serves on BASE + n - 1. */
const SLOT_PORT_BASE = parseInt(process.env.HOOOP_PREVIEW_PORT_BASE ?? "", 10) || 7850;
const RUNNER_TOKEN_HEADER = "x-runner-token";
const RUNNER_TIMEOUT_MS = 15_000;

export interface PreviewRecord {
  previewId: string;
  /** Canonical session id at creation time. */
  sessionId: string;
  slot: number;
  leaseId: string;
  spec: PreviewSpec;
  /** Absolute cwd in the SANDBOX's path space (for display/debugging). */
  workdir: string;
  appPort: number | null;
  slotPort: number;
  state: PreviewState;
  phase: PreviewPhase;
  failedStep: number | null;
  failureReason: string | null;
  /** Tunnel URL once shared; null while the preview is host-local. */
  publicUrl: string | null;
  createdAt: number;
}

/** previewId → record. At most PREVIEW_LIMITS.slots entries. */
const previews = new Map<string, PreviewRecord>();

export class PreviewError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PreviewError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Runner transport
// ---------------------------------------------------------------------------

function socketFor(slot: number): string {
  return join(SOCKET_DIR, `runner-${slot}.sock`);
}

function tokenFor(slot: number): string | null {
  try {
    const t = readFileSync(join(SOCKET_DIR, `runner-${slot}.token`), "utf-8").trim();
    return t || null;
  } catch {
    return null;
  }
}

/** True when this install actually has preview runners wired up. */
export function previewsAvailable(): boolean {
  for (let slot = 1; slot <= PREVIEW_LIMITS.slots; slot += 1) {
    if (existsSync(socketFor(slot))) return true;
  }
  return false;
}

async function runnerCall<T>(
  slot: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const token = tokenFor(slot);
  if (!token) {
    throw new PreviewError(
      `preview runner ${slot} is not reachable. If this install predates previews, run \`hooop rebuild\` to bring the runner containers up.`,
      503,
    );
  }
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise<T>((res, rej) => {
    const headers: Record<string, string> = { [RUNNER_TOKEN_HEADER]: token };
    if (payload != null) {
      headers["content-type"] = "application/json; charset=utf-8";
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const req = udsRequest(
      { socketPath: socketFor(slot), method, path, headers, timeout: RUNNER_TIMEOUT_MS },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (c: Buffer) => chunks.push(c));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : {}; } catch { /* non-JSON */ }
          const status = response.statusCode ?? 0;
          if (status >= 400) {
            const reason = (parsed as { error?: string } | null)?.error ?? `runner ${slot} returned ${status}`;
            rej(new PreviewError(reason, status));
            return;
          }
          res(parsed as T);
        });
        response.on("error", rej);
      },
    );
    req.on("timeout", () => { req.destroy(new PreviewError(`preview runner ${slot} timed out`, 504)); });
    req.on("error", (err) => rej(err instanceof PreviewError ? err : new PreviewError(`preview runner ${slot} is unreachable: ${String(err)}`, 503)));
    if (payload != null) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Workdir policy
// ---------------------------------------------------------------------------

/**
 * Map a session's own workdir into the path the runner will see, refusing
 * anything that isn't a per-session directory.
 *
 * The runner bind-mounts the workspace at `/workspace`, so the two containers
 * describe the same bytes with different strings. What travels between them is
 * the path RELATIVE to the workspace root.
 *
 * The refusal that matters is `hooop mount`: a mounted host folder is bind-
 * mounted into the SANDBOX at `WORKSPACE_DIR/<name>`, layered inside that
 * container, and is simply not present in the runner. Per-session workdirs live
 * under `WORKSPACE_DIR/sessions/`, which paths.ts guarantees can never collide
 * with a mount name — so "is it under SESSIONS_ROOT" is exactly the right
 * question, and answering it here means the user gets an explanation instead of
 * a preview that starts and serves an empty directory.
 */
export function resolveSessionRoot(cwd: string): { ok: true; rootRelative: string; root: string } | { ok: false; reason: string } {
  const real = canonicalize(cwd);
  if (!real) return { ok: false, reason: `the session's working directory does not exist: ${cwd}` };

  const sessionsRoot = canonicalize(SESSIONS_ROOT);
  if (!sessionsRoot) {
    return { ok: false, reason: "this sandbox has no per-session workspace directory yet" };
  }
  if (real !== sessionsRoot && !real.startsWith(sessionsRoot + sep)) {
    return {
      ok: false,
      reason:
        "previews run over the session's own workspace, and this session's directory is outside it " +
        "(a `hooop mount` folder is mounted inside the sandbox only, so the preview runner cannot see it). " +
        "Clone or copy the project into the session's workspace and start the preview there.",
    };
  }

  const workspace = canonicalize(WORKSPACE_DIR) ?? WORKSPACE_DIR;
  const rootRelative = relative(workspace, real);
  if (!rootRelative || rootRelative.startsWith("..")) {
    return { ok: false, reason: "the session's working directory is outside the workspace" };
  }
  return { ok: true, rootRelative, root: real };
}

/** Where the spec's `workdir` lands, in the sandbox's own path space. */
function specWorkdir(root: string, workdir: string | null | undefined): { ok: true; path: string } | { ok: false; reason: string } {
  if (!workdir) return { ok: true, path: root };
  const target = resolve(join(root, workdir));
  if (target !== root && !target.startsWith(root + sep)) {
    return { ok: false, reason: "workdir escapes the session's workspace" };
  }
  if (!existsSync(target)) {
    return {
      ok: false,
      reason: `workdir does not exist: ${workdir}. If the project was just cloned, pass the clone's directory name as workdir.`,
    };
  }
  return { ok: true, path: target };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export function listPreviews(): PreviewRecord[] {
  return [...previews.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function getPreview(previewId: string): PreviewRecord | null {
  return previews.get(previewId) ?? null;
}

/** The one preview a session may hold, if any. */
export function previewForSession(sessionIds: readonly string[]): PreviewRecord | null {
  const set = new Set(sessionIds);
  for (const p of previews.values()) if (set.has(p.sessionId)) return p;
  return null;
}

function freeSlot(): number | null {
  const used = new Set([...previews.values()].map((p) => p.slot));
  for (let slot = 1; slot <= PREVIEW_LIMITS.slots; slot += 1) {
    if (!used.has(slot)) return slot;
  }
  return null;
}

/**
 * Lease a slot and begin executing a spec.
 *
 * Returns as soon as the runner has ACCEPTED the work — setup steps can take
 * minutes. Callers that need a settled answer use `awaitSettled`.
 */
export async function startPreview(opts: {
  sessionId: string;
  sessionIds: readonly string[];
  cwd: string;
  spec: PreviewSpec;
}): Promise<PreviewRecord> {
  if (!previewsAvailable()) {
    throw new PreviewError(
      "preview runners are not available in this install. Run `hooop rebuild` to bring them up.",
      503,
    );
  }

  const existing = previewForSession(opts.sessionIds);
  if (existing) {
    throw new PreviewError(
      `this session already has a preview ("${existing.spec.name}"). Use rebuild_preview to re-run its setup, restart_preview to respawn it, or stop_preview to replace it.`,
      409,
    );
  }

  const slot = freeSlot();
  if (slot === null) {
    const holders = listPreviews().map((p) => `${p.spec.name} (session ${p.sessionId.slice(0, 8)})`).join(", ");
    throw new PreviewError(
      `all ${PREVIEW_LIMITS.slots} preview slots are in use: ${holders}. Stop one before starting another.`,
      409,
    );
  }

  const rooted = resolveSessionRoot(opts.cwd);
  if (!rooted.ok) throw new PreviewError(rooted.reason, 400);
  const wd = specWorkdir(rooted.root, opts.spec.workdir);
  if (!wd.ok) throw new PreviewError(wd.reason, 400);

  const leaseId = randomUUID();
  await runnerCall(slot, "POST", "/lease", { leaseId, sessionId: opts.sessionId });

  let started: { appPort: number; slotPort: number };
  try {
    started = await runnerCall<{ appPort: number; slotPort: number }>(slot, "POST", "/start", {
      leaseId,
      spec: opts.spec,
      rootRelative: rooted.rootRelative,
    });
  } catch (err) {
    // Don't strand the lease on a slot nobody owns — the next start would find
    // no free slot and report the cap as reached with nothing running.
    await runnerCall(slot, "POST", "/release", { leaseId }).catch(() => { /* runner is cycling anyway */ });
    throw err;
  }

  const record: PreviewRecord = {
    previewId: randomUUID(),
    sessionId: opts.sessionId,
    slot,
    leaseId,
    spec: opts.spec,
    workdir: wd.path,
    appPort: started.appPort,
    slotPort: started.slotPort || SLOT_PORT_BASE + slot - 1,
    state: "starting",
    phase: { kind: "idle" },
    failedStep: null,
    failureReason: null,
    publicUrl: null,
    createdAt: Date.now(),
  };
  previews.set(record.previewId, record);
  return record;
}

/** Pull the runner's live view into the record. */
export async function refreshPreview(previewId: string): Promise<PreviewRecord | null> {
  const rec = previews.get(previewId);
  if (!rec) return null;
  try {
    const status = await runnerCall<PreviewRunnerStatus>(rec.slot, "GET", "/status");
    // A runner that cycled has no lease; treat that as the preview being gone
    // rather than reporting a stale "running" forever.
    if (status.leaseId !== rec.leaseId) {
      rec.state = "failed";
      rec.failureReason = "the preview runner restarted and this preview is no longer running";
      rec.phase = { kind: "idle" };
      return rec;
    }
    // `shared` is OUR fact, not the runner's — never let a status poll clear it.
    rec.state = rec.publicUrl && status.state === "running" ? "shared" : status.state;
    rec.phase = status.phase;
    rec.appPort = status.appPort;
    rec.failedStep = status.failedStep;
    rec.failureReason = status.failureReason;
  } catch (err) {
    log.warn("previews", "status poll failed", { previewId, err: String(err) });
  }
  return rec;
}

export async function refreshAll(): Promise<PreviewRecord[]> {
  await Promise.all([...previews.keys()].map((id) => refreshPreview(id)));
  return listPreviews();
}

export async function previewLogs(previewId: string, step?: number): Promise<PreviewLog[]> {
  const rec = previews.get(previewId);
  if (!rec) throw new PreviewError("unknown preview", 404);
  const path = step === undefined ? "/logs" : `/logs?step=${encodeURIComponent(String(step))}`;
  const out = await runnerCall<{ logs: PreviewLog[] }>(rec.slot, "GET", path);
  return out.logs ?? [];
}

export async function restartPreview(previewId: string): Promise<PreviewRecord> {
  const rec = mustGet(previewId);
  await runnerCall(rec.slot, "POST", "/restart", { leaseId: rec.leaseId });
  rec.state = "starting";
  rec.failedStep = null;
  rec.failureReason = null;
  return rec;
}

export async function rebuildPreview(previewId: string): Promise<PreviewRecord> {
  const rec = mustGet(previewId);
  await runnerCall(rec.slot, "POST", "/rebuild", { leaseId: rec.leaseId });
  rec.state = "starting";
  rec.failedStep = null;
  rec.failureReason = null;
  return rec;
}

/**
 * Record that a preview is (or is no longer) reachable over a tunnel.
 *
 * The URL is produced by the DASHBOARD — it owns cloudflared — and posted back
 * here so this registry stays the single place that knows a preview's public
 * state, and so a late-joining peer reads it from an ordinary session-scoped
 * fetch rather than needing the event that announced it.
 */
export async function setPreviewShared(previewId: string, url: string | null): Promise<PreviewRecord> {
  const rec = mustGet(previewId);
  rec.publicUrl = url;
  if (url && rec.state === "running") rec.state = "shared";
  if (!url && rec.state === "shared") rec.state = "running";
  await runnerCall(rec.slot, "POST", "/shared", { leaseId: rec.leaseId, shared: url != null })
    .catch((err) => log.warn("previews", "could not tell the runner about its share state", { previewId, err: String(err) }));
  return rec;
}

/** Stop a preview and release its slot. */
export async function stopPreview(previewId: string): Promise<void> {
  const rec = previews.get(previewId);
  if (!rec) return;
  previews.delete(previewId);
  await releaseSlot(rec);
}

/**
 * Release the runner. The supervisor wipes its scratch and exits so Docker
 * recreates the container clean for the next session — a restart alone would
 * preserve the writable layer, so the wipe is what carries the guarantee.
 */
async function releaseSlot(rec: PreviewRecord): Promise<void> {
  try {
    await runnerCall(rec.slot, "POST", "/release", { leaseId: rec.leaseId });
  } catch (err) {
    // The runner exits immediately after answering, so a dropped connection
    // here is the expected shape of success, not a failure worth surfacing.
    log.debug("previews", "release returned an error (runner is exiting)", { slot: rec.slot, err: String(err) });
  }
}

/**
 * Drop every preview belonging to any of these session ids.
 *
 * Takes the full alias set rather than one id because `claude --resume` remaps
 * a session mid-life, and a preview minted under a prior id must still die with
 * the conversation it belongs to.
 */
export async function reapPreviewsForSessions(sessionIds: readonly string[]): Promise<string[]> {
  const set = new Set(sessionIds);
  const doomed = [...previews.values()].filter((p) => set.has(p.sessionId));
  for (const rec of doomed) previews.delete(rec.previewId);
  await Promise.all(doomed.map((rec) => releaseSlot(rec)));
  return doomed.map((p) => p.previewId);
}

/** Shutdown drain: stop everything, release every slot. */
export async function shutdownPreviews(): Promise<void> {
  const all = [...previews.values()];
  previews.clear();
  await Promise.all(all.map((rec) => releaseSlot(rec)));
}

/**
 * Wait for a starting preview to reach a terminal-ish state, bounded.
 *
 * The budget exists because of how the permission gate works, and it is not a
 * detail: `permission-gate.sh` performs ONE long-poll (default 120s) and treats
 * a timeout as a DENY. A preview whose `npm ci` takes three minutes would
 * therefore be reported to the model as "denied" — the precise failure this
 * codebase keeps designing against, where a human-or-system step that is still
 * in flight gets reported as a definite negative.
 *
 * So we settle early and honestly instead: whatever state the preview is in
 * when the budget runs out is reported as that state, and "still installing" is
 * a legitimate answer the caller can phrase for the model.
 */
export async function awaitSettled(previewId: string, budgetMs: number): Promise<PreviewRecord | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const rec = await refreshPreview(previewId);
    if (!rec) return null;
    if (rec.state !== "starting") return rec;
    if (Date.now() >= deadline) return rec;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// ---------------------------------------------------------------------------
// Transcript events
// ---------------------------------------------------------------------------

export type PreviewHook =
  | "PreviewStarted" | "PreviewFailed" | "PreviewShared" | "PreviewRebuilt" | "PreviewStopped"
  // Not a state change: a request. The model tried to drive the page and nobody
  // had it open, and the only way out is a human opening the Browser panel —
  // there is deliberately no headless fallback to fall back to.
  | "PreviewNeedsViewer";

/**
 * Put a preview lifecycle change in the transcript, so it lands in search, the
 * notification classifier and every participant's live feed.
 *
 * `message` is what the dashboard renders as the divider label (deriveText →
 * systemText), so it is phrased for a human rather than left as a bare hook
 * name — the same convention the peer join/leave markers follow.
 */
export function emitPreviewEvent(
  hook: PreviewHook,
  rec: PreviewRecord,
  author: string | null,
): void {
  const name = rec.spec.name;
  const message =
    hook === "PreviewNeedsViewer" ? `The agent is trying to use "${name}" — open the Browser panel so it can`
      : hook === "PreviewStarted" ? `Preview "${name}" is running`
      : hook === "PreviewFailed" ? `Preview "${name}" failed: ${rec.failureReason ?? "unknown error"}`
        : hook === "PreviewShared" ? `Preview "${name}" is shared with this session`
          : hook === "PreviewRebuilt" ? `Preview "${name}" was rebuilt`
            : `Preview "${name}" stopped`;
  try {
    ingestEventLine(JSON.stringify({
      ts: new Date().toISOString(),
      hook,
      ctx: {
        session_id: rec.sessionId,
        preview_id: rec.previewId,
        preview_name: name,
        slot: rec.slot,
        public_url: rec.publicUrl,
        local_url: `http://127.0.0.1:${rec.slotPort}`,
        state: rec.state,
        author,
        message,
      },
    }));
  } catch (e) {
    log.warn("previews", "lifecycle event ingest failed", { hook, err: String((e as { message?: string })?.message ?? e) });
  }
}

// ---------------------------------------------------------------------------
// Model-facing text
// ---------------------------------------------------------------------------

/**
 * Describe a preview to the model, in the voice of a tool result.
 *
 * The three cases are deliberately distinguishable, because collapsing them is
 * the failure this codebase keeps guarding against — a step that is still in
 * flight, or that failed, must never read like success:
 *
 *   running/shared → here is the URL
 *   failed         → here is the exact command that broke and its output
 *   starting       → it is STILL WORKING; say which step, and say how to check
 */
export async function describePreview(rec: PreviewRecord): Promise<string> {
  const local = `http://127.0.0.1:${rec.slotPort}`;
  switch (rec.state) {
    case "shared":
      return `Preview "${rec.spec.name}" is running and shared with this session at ${rec.publicUrl}. The operator can also reach it locally at ${local}.`;
    case "running":
      return (
        `Preview "${rec.spec.name}" is running at ${local} (preview id: ${rec.previewId}). ` +
        `Only the local operator can reach that URL — call share_preview if someone else in this session needs to see it.`
      );
    case "failed": {
      const step = rec.failedStep;
      const logs = await previewLogs(rec.previewId).catch(() => [] as PreviewLog[]);
      const entry = logs.find((l) => l.step === step);
      const tail = entry ? tailOf(entry) : "";
      const which = step == null || step < 0
        ? `the run command (\`${rec.spec.run}\`)`
        : `setup step ${step + 1} (\`${rec.spec.setup?.[step] ?? "?"}\`)`;
      return (
        `Preview "${rec.spec.name}" FAILED in ${which}: ${rec.failureReason ?? "unknown error"}.` +
        (tail ? `\n\nOutput:\n${tail}` : "") +
        `\n\nFix the problem and call rebuild_preview (id: ${rec.previewId}), or stop_preview and start over with a corrected spec.`
      );
    }
    case "starting": {
      const where = rec.phase.kind === "setup"
        ? `setup step ${(rec.phase.index ?? 0) + 1} (\`${rec.phase.command ?? "?"}\`)`
        : "waiting for the app to answer";
      return (
        `Preview "${rec.spec.name}" is STILL STARTING — currently ${where}. It has not failed; ` +
        `it is simply taking longer than this call waits for. It keeps running in the background: ` +
        `call list_previews in a moment to see whether it came up. (preview id: ${rec.previewId})`
      );
    }
    default:
      return `Preview "${rec.spec.name}" is ${rec.state} (preview id: ${rec.previewId}).`;
  }
}

/** Last few lines of a step's output, bounded for a tool result. */
function tailOf(entry: PreviewLog, maxChars = 2000): string {
  const combined = [entry.stdout, entry.stderr].filter(Boolean).join("\n").trimEnd();
  if (combined.length <= maxChars) return combined;
  return "…\n" + combined.slice(combined.length - maxChars);
}

/** One-line summary per preview, for list_previews. */
export function summarizePreviews(records: PreviewRecord[]): string {
  if (records.length === 0) {
    return `No previews are running (0 of ${PREVIEW_LIMITS.slots} slots in use).`;
  }
  const lines = records.map((r) => {
    const where = r.publicUrl ? `shared at ${r.publicUrl}` : `local at http://127.0.0.1:${r.slotPort}`;
    const detail = r.state === "starting" && r.phase.kind === "setup"
      ? ` (setup step ${(r.phase.index ?? 0) + 1})`
      : r.state === "failed" ? ` (${r.failureReason ?? "failed"})` : "";
    return `- "${r.spec.name}" [${r.state}${detail}] ${where} — id ${r.previewId}, session ${r.sessionId}`;
  });
  return `${records.length} of ${PREVIEW_LIMITS.slots} preview slots in use:\n${lines.join("\n")}`;
}

function mustGet(previewId: string): PreviewRecord {
  const rec = previews.get(previewId);
  if (!rec) throw new PreviewError("unknown preview", 404);
  return rec;
}

/** Test seam: drop all in-memory state without touching any runner. */
export function __resetPreviewsForTest(): void {
  previews.clear();
}
