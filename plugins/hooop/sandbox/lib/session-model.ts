import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "@shared/logger";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const TAIL_BYTES = 64 * 1024;

const modelCache = new Map<string, { mtimeMs: number; model: string | null }>();

/**
 * Choose the best model string to DISPLAY for a session.
 *
 * `configured` is the session's `--model` override (what the user set at
 * creation or via `/model`). It may be a bare alias like "opus" that carries
 * NO version, which is why the header used to show "opus" instead of a
 * versioned name. `resolved` is the id claude actually ran, read from the
 * transcript (e.g. "claude-opus-4-8") — always versioned, but stale for the
 * window between a `/model` switch and the first turn on the new model.
 *
 * Rules:
 *   - A configured value that is already fully-qualified (has a "-<digit>"
 *     version segment, e.g. "claude-opus-4-8") wins as-is.
 *   - Otherwise prefer the versioned `resolved` id, but only when it belongs to
 *     the same family as the configured alias (so a just-switched alias whose
 *     new model hasn't run yet doesn't surface the previous model). When they
 *     disagree — or there is no resolved id yet — fall back to the alias.
 *   - With no override at all, use whatever the transcript resolved to.
 */
export function resolveDisplayModel(
  configured: string | null | undefined,
  resolved: string | null | undefined,
): string | null {
  const cfg = configured ?? null;
  const res = resolved ?? null;
  if (cfg && /-\d/.test(cfg)) return cfg;
  if (!cfg) return res;
  const rf = res ? modelFamily(res) : null;
  if (res && rf && rf === modelFamily(cfg)) return res;
  return cfg;
}

function modelFamily(m: string): string | null {
  return m.match(/(opus|sonnet|haiku)/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * Best-effort: `null` on anything that stops us reading the transcript.
 *
 * The transcript belongs to CLAUDE, which creates it 0600 under uid `agent`,
 * and this runs in the server (uid `hooopd`, in group `hooop`). So on any host
 * that enforces DAC the open() is EACCES — the directory grants are enough to
 * stat, walk and prune transcripts, but never to read their contents. That is
 * not a misconfiguration to repair: only the file's owner could chmod it, and
 * the server has a first-hand source for the resolved model anyway (the
 * system/init frame it parses off claude's stdout, kept in meta.lastStats).
 *
 * Hence a null return rather than a throw. This used to propagate the EACCES
 * out of `GET /sessions/:id/model` as a 500, once per Stop frame per viewer.
 */
export function getSessionModel(sessionId: string): { model: string | null } {
  const file = findTranscript(sessionId);
  if (!file) return { model: null };

  let mtimeMs = 0;
  try { mtimeMs = statSync(file).mtimeMs; } catch { /* ignore */ }
  const cached = modelCache.get(sessionId);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { model: cached.model };
  }

  let tail: string;
  try {
    tail = readTail(file, TAIL_BYTES);
  } catch (err) {
    // Cache the miss so a permanently unreadable transcript doesn't retry the
    // open on every poll, and warn ONCE per session so the cause is visible
    // in the log instead of being swallowed.
    warnUnreadableOnce(sessionId, file, err);
    modelCache.set(sessionId, { mtimeMs, model: null });
    return { model: null };
  }
  // Claude emits assistant frames with model: "<synthetic>" for built-in
  // slash commands (/cost, /clear, /compact) and other internal events.
  // Those frames get persisted to the transcript jsonl. If we naively
  // returned the LAST model field we'd surface "<synthetic>" any time a
  // synthetic frame was the most recent — which is the case on every
  // session wake (claude-mem's observer hook emits one). Walk matches
  // from newest to oldest and return the first NON-synthetic value.
  const matches = tail.match(/"model"\s*:\s*"([^"]+)"/g) ?? [];
  let model: string | null = null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i].match(/"model"\s*:\s*"([^"]+)"/)?.[1];
    if (!m || m === "<synthetic>") continue;
    model = m;
    break;
  }

  modelCache.set(sessionId, { mtimeMs, model });
  return { model };
}

// sessionId -> transcript path. The transcript lives in a fixed project dir for
// the life of a session, so once found the path is stable — cache it to avoid a
// readdirSync(PROJECTS_DIR) + existsSync-per-dir scan on every call (this ran
// even on a modelCache hit). Re-scan only on a miss or if the cached path has
// since vanished.
const transcriptPathCache = new Map<string, string>();

function findTranscript(sessionId: string): string | null {
  const cached = transcriptPathCache.get(sessionId);
  if (cached && existsSync(cached)) return cached;
  if (!existsSync(PROJECTS_DIR)) return null;
  try {
    for (const proj of readdirSync(PROJECTS_DIR)) {
      const candidate = join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
      if (existsSync(candidate)) {
        transcriptPathCache.set(sessionId, candidate);
        return candidate;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// Sessions already reported as unreadable. Bounded by the number of sessions
// this process sees; entries are cheap (a session id) and pruning them would
// only re-open the log spam this exists to prevent.
const warnedUnreadable = new Set<string>();

function warnUnreadableOnce(sessionId: string, file: string, err: unknown): void {
  if (warnedUnreadable.has(sessionId)) return;
  warnedUnreadable.add(sessionId);
  const code = (err as { code?: string } | null)?.code;
  log.warn("session-model", "transcript unreadable; falling back to lastStats", {
    sessionId,
    file,
    code,
    // EACCES here is EXPECTED on a DAC-enforcing host (claude writes the
    // transcript 0600 as `agent`; the server runs as `hooopd`) — the model still
    // resolves from the init frame. Any OTHER code is worth a closer look.
    expected: code === "EACCES",
  });
}

function readTail(path: string, maxBytes: number): string {
  const stat = statSync(path);
  const start = stat.size > maxBytes ? stat.size - maxBytes : 0;
  const len = stat.size - start;
  if (len <= 0) return "";
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, start);
    return buf.toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
