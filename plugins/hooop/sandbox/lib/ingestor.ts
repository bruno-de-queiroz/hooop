import { existsSync, openSync, readSync, statSync, closeSync, appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { dirname } from "node:path";
import { EVENTS_FILE } from "./paths";
import { getDb, getState, setState, hasVecExtension, rotateIfNeeded } from "./db";
import { embed, isEmbeddingConfigured } from "./embeddings";
import { log } from "@shared/logger";

/**
 * Live event bus. Consumers (SSE endpoint at /api/stream, etc.) subscribe via
 * `eventBus.on("event", handler)`. Each ingested event is emitted after it is
 * persisted to the DB, so subscribers see the same view the database has.
 */
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(100);

let _started = false;

/**
 * Push-based ingestion model:
 *   - Hooks POST event JSON to /api/ingest (handled by the ingest route, which
 *     calls ingestEventLine()). HTTP-over-loopback dodges the macOS Docker
 *     Desktop limitation of not being able to bind Unix sockets in
 *     bind-mounted volumes — works on any platform with no FS perm gymnastics.
 *   - On startup, drain EVENTS_FILE from the saved offset so the dashboard
 *     catches up on events written while it was down (the hook emitter falls
 *     back to appending to EVENTS_FILE if the HTTP endpoint isn't reachable).
 */
export function startIngestor() {
  if (_started) return;
  _started = true;

  mkdirSync(dirname(EVENTS_FILE), { recursive: true });
  drainFile();
  // Boot rotation check — catches up if the previous run accumulated past the
  // cap while sleeping (or if the cap dropped via env between runs).
  try { rotateIfNeeded(); } catch (err) { log.warn("ingestor", "boot rotation skipped", { err }); }
}

/**
 * Rotation cadence: check every N ingests rather than on every line. N=5000
 * means an idle dashboard pays nothing; a busy one pays ~one PRAGMA page_count
 * + one min/max-id scan every few minutes.
 */
const ROTATION_CHECK_EVERY = parseInt(process.env.HOOOP_ROTATION_CHECK_EVERY ?? "", 10) || 5000;
let _ingestSinceRotateCheck = 0;

function maybeRotate(): void {
  _ingestSinceRotateCheck += 1;
  if (_ingestSinceRotateCheck < ROTATION_CHECK_EVERY) return;
  _ingestSinceRotateCheck = 0;
  try { rotateIfNeeded(); } catch (err) { log.warn("ingestor", "rotation check failed", { err }); }
}

/**
 * Called by /api/ingest for each pushed event. Persists, indexes, and
 * fans out to subscribers — exactly the same path drained lines take.
 *
 * Ordering matters for crash-safety: append → ingest → advance offset.
 * If ingest throws, the offset stays put and the next drain replays this
 * line. Advancing the offset before the DB insert (the earlier behaviour)
 * would silently drop events when SQLite/FTS/embed failed.
 *
 * Returns a result object so callers (e.g. POST /ingest) can surface
 * failures instead of silently returning { ok: true }.
 */
export function ingestEventLine(line: string): { ok: true; id?: number } | { ok: false; reason: string } {
  const withNl = line.endsWith("\n") ? line : line + "\n";
  try {
    // The directory may not exist yet on a fresh install (no /events/stream
    // open, no startIngestor() call, hook fires straight away). mkdirSync is
    // idempotent and cheap.
    mkdirSync(dirname(EVENTS_FILE), { recursive: true });
    appendFileSync(EVENTS_FILE, withNl);
  } catch (err) {
    log.error("ingestor", "failed to append audit log", { err });
    return { ok: false, reason: "audit-log-append-failed" };
  }
  let insertedId: number | undefined;
  try {
    const result = ingestLines([line]);
    insertedId = result[0]?.id;
  } catch (err) {
    log.error("ingestor", "ingest failed; leaving offset put so next drain replays", { err });
    return { ok: false, reason: "db-ingest-failed" };
  }
  try {
    const cur = parseInt(getState("events_offset") ?? "0", 10);
    setState("events_offset", String(cur + Buffer.byteLength(withNl, "utf-8")));
  } catch (err) {
    log.warn("ingestor", "offset update failed — next drain will replay this line (idempotency will de-dup)", { err });
  }
  maybeRotate();
  return { ok: true, ...(insertedId !== undefined ? { id: insertedId } : {}) };
}

function drainFile() {
  if (!existsSync(EVENTS_FILE)) return;
  const stat = statSync(EVENTS_FILE);
  const offset = parseInt(getState("events_offset") ?? "0", 10);
  if (stat.size <= offset) return;

  const fd = openSync(EVENTS_FILE, "r");
  const buf = Buffer.alloc(stat.size - offset);
  try {
    readSync(fd, buf, 0, buf.length, offset);
  } finally {
    closeSync(fd);
  }

  const text = buf.toString("utf-8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return;

  const complete = text.slice(0, lastNl + 1);
  const consumed = Buffer.byteLength(complete, "utf-8");
  const lines = complete.split("\n").filter((l) => l.trim());

  if (lines.length > 0) ingestLines(lines);
  setState("events_offset", String(offset + consumed));
}

function contentHash(line: string): string {
  return createHash("sha256").update(line).digest("hex").slice(0, 32);
}

function ingestLines(lines: string[]): Array<{ id: number }> {
  const db = getDb();
  const insertEvent = db.prepare(`
    INSERT INTO events (ts, session_id, hook_type, tool_name, text, payload, content_hash, kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // Idempotency lookup must cover BOTH tiers. After rotation, the canonical
  // copy of an event may live in the archive only; a drain replay (after
  // events.db wipe / recovery) would otherwise re-insert the same content
  // into hot, duplicating across tiers. Querying both indexes is fast because
  // each has a partial unique index on content_hash.
  const lookupByHash = db.prepare(`
    SELECT id FROM events WHERE content_hash = ?
    UNION ALL
    SELECT id FROM arch.events WHERE content_hash = ?
    LIMIT 1
  `);
  const insertFts = db.prepare("INSERT INTO events_fts (rowid, text) VALUES (?, ?)");

  const newRows: { id: number; text: string }[] = [];
  const emittable: Array<Record<string, unknown>> = [];
  const insertedIds: Array<{ id: number }> = [];

  const tx = db.transaction(() => {
    for (const line of lines) {
      let event: any;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const hash = contentHash(line);

      // Idempotency: if this exact line was already ingested, skip the insert
      // and return the existing id. This makes replay-after-offset-failure safe.
      const existing = lookupByHash.get(hash, hash) as { id: number } | undefined;
      if (existing) {
        insertedIds.push({ id: existing.id });
        continue;
      }

      const ts = event.ts ?? new Date().toISOString();
      const ctx = event.ctx ?? {};
      const sid = ctx.session_id ?? null;
      const hook = event.hook ?? null;
      const tool = ctx.tool_name ?? null;
      const kind = typeof ctx.kind === "string" ? ctx.kind : null;
      const t = deriveText(event);
      const info = insertEvent.run(ts, sid, hook, tool, t, line, hash, kind);
      const id = info.lastInsertRowid as number;
      insertedIds.push({ id });
      if (t) {
        insertFts.run(id, t);
        newRows.push({ id, text: t });
      }
      emittable.push({ id, ts, session_id: sid, hook_type: hook, tool_name: tool, text: t, author: ctx.author ?? null, images: Array.isArray(ctx.images) ? ctx.images : null, kind, agent_id: ctx.agent_id ?? null, payload: event });
    }
  });
  tx();

  // Fan out to live subscribers AFTER commit so they read consistent state.
  for (const e of emittable) eventBus.emit("event", e);

  if (isEmbeddingConfigured() && hasVecExtension() && newRows.length > 0) {
    void embedAndStore(newRows);
  }

  return insertedIds;
}

export function deriveText(event: any): string {
  const ctx = event?.ctx ?? {};
  const parts: string[] = [];
  if (event?.hook) parts.push(`[${event.hook}]`);
  if (ctx.tool_name) parts.push(`tool=${ctx.tool_name}`);
  for (const key of ["tool_input", "tool_response", "tool_result", "prompt", "message", "transcript", "last_assistant_message", "kind"]) {
    const v = ctx[key];
    if (v == null) continue;
    const s = typeof v === "string" ? v : safeStringify(v);
    if (s) parts.push(`${key}=${s}`);
  }
  return parts.join(" | ");
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

async function embedAndStore(rows: { id: number; text: string }[]) {
  const BATCH = 100;
  const db = getDb();
  const insertVec = db.prepare("INSERT INTO events_vec (rowid, embedding) VALUES (?, ?)");

  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    try {
      const vectors = await embed(chunk.map((r) => r.text));
      if (!vectors) return;
      const tx = db.transaction(() => {
        for (let j = 0; j < chunk.length; j++) {
          // The rowid MUST be bound as a BigInt. better-sqlite3 binds plain JS
          // integers as SQLite FLOAT, and sqlite-vec's vec0 rejects a non-INTEGER
          // primary key ("Only integers are allows for primary key values"),
          // which would silently drop every embedding and disable semantic search.
          insertVec.run(BigInt(chunk[j].id), JSON.stringify(vectors[j]));
        }
      });
      tx();
    } catch (err) {
      log.error("ingestor", "embed batch failed", { err });
    }
  }
}
