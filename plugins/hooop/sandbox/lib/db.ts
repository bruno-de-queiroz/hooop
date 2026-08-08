import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { mkdirSync, existsSync, renameSync, unlinkSync, copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { DB_PATH, EMBED_DIM, STATE_DIR } from "./paths";
import { log } from "@shared/logger";

let _db: Database.Database | null = null;

/**
 * Path of the cold archive DB. Rotated rows live here. Same schema as the
 * hot events.db, same FTS5 + sqlite-vec indexes, queried at search time via
 * an ATTACH alias `arch`. See `rotateIfNeeded` for the move protocol.
 */
export const ARCHIVE_DB_PATH = join(STATE_DIR, "events-archive.db");

export function getDb(): Database.Database {
  if (_db) return _db;

  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(dirname(DB_PATH), { recursive: true });

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  // Keep WAL bounded. Default is 1000 pages (~4 MB); we explicitly set it so
  // the on-disk -wal file doesn't grow unbounded between commits if a crash
  // prevents the auto-checkpoint from running. Smaller values trade some
  // write amplification for tighter recovery.
  db.pragma("wal_autocheckpoint = 1000");

  // sqlite-vec is a loadable extension that ships precompiled binaries for common platforms.
  try {
    sqliteVec.load(db);
  } catch (err) {
    log.warn("db", "failed to load sqlite-vec extension; semantic search disabled, BM25 still works", { err });
  }

  migrate(db);

  // Ensure the archive DB exists with the same schema, then attach it so
  // queries can union across both tiers. We migrate the archive via a
  // separate Database handle so the migration SQL stays plain (no `arch.`
  // prefix) and identical to the hot path.
  ensureArchiveSchema();
  db.exec(`ATTACH DATABASE '${escapeSqlString(ARCHIVE_DB_PATH)}' AS arch`);

  // Boot reconciliation: if a previous run crashed between the arch INSERT
  // and the hot DELETE of a rotation, the same content_hash now exists in
  // both tiers. Hot wins (it's the newer view of truth) — clean up arch.
  reconcileArchiveAfterAttach(db);

  _db = db;
  return db;
}

function escapeSqlString(s: string): string {
  return s.replace(/'/g, "''");
}

function ensureArchiveSchema(): void {
  mkdirSync(dirname(ARCHIVE_DB_PATH), { recursive: true });
  const arch = new Database(ARCHIVE_DB_PATH);
  try {
    arch.pragma("journal_mode = WAL");
    arch.pragma("synchronous = NORMAL");
    arch.pragma("wal_autocheckpoint = 1000");
    try { sqliteVec.load(arch); } catch { /* archive without vec is still useful for BM25 */ }
    migrate(arch);
  } finally {
    arch.close();
  }
}

function reconcileArchiveAfterAttach(db: Database.Database): void {
  // Use a single DELETE...WHERE EXISTS so the planner can use the unique
  // content_hash indexes on both sides. Skipped silently if archive is empty.
  try {
    const archHasRows = (db.prepare("SELECT 1 FROM arch.events LIMIT 1").get() as unknown) !== undefined;
    if (!archHasRows) return;
    const result = db.prepare(`
      DELETE FROM arch.events
      WHERE content_hash IS NOT NULL
        AND content_hash IN (SELECT content_hash FROM events WHERE content_hash IS NOT NULL)
    `).run();
    if (result.changes > 0) {
      log.info("db", "boot sweep: pruned arch rows duplicated in hot", { changes: result.changes });
      // Also strip the orphaned FTS / vec rows so search results stay clean.
      try { db.exec("INSERT INTO arch.events_fts(arch.events_fts) VALUES('rebuild')"); } catch { /* fts5 rebuild may need a different syntax in some sqlite builds */ }
    }
  } catch (err) {
    log.warn("db", "boot reconciliation skipped", { err });
  }
}

export function hasVecExtension(): boolean {
  const db = getDb();
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

/**
 * Force WAL pages to be merged back into the main DB. Cheap (skipped if WAL
 * is empty); useful on shutdown so the next start doesn't depend on the
 * -wal file's presence.
 */
export function checkpointDb(): void {
  if (!_db) return;
  try {
    _db.pragma("wal_checkpoint(TRUNCATE)");
    // Also checkpoint the attached archive so its WAL doesn't linger.
    _db.exec("PRAGMA arch.wal_checkpoint(TRUNCATE)");
  } catch (err) {
    log.error("db", "wal_checkpoint failed", { err });
  }
}

/**
 * Close the connection, finalizing every prepared statement WHILE the Node
 * environment is still alive.
 *
 * This is not housekeeping — it's the fix for a hard crash. Statements live for
 * the whole process here (see lib/ingestor.ts), and nothing used to close the
 * handle, so their C++ destructors ran during environment teardown instead.
 * better-sqlite3's `Statement::~Statement()` calls
 * `node::RemoveEnvironmentCleanupHook`, which asserts `(env) != nullptr` — by
 * teardown that pointer is gone, node aborts, and the process dies with
 *
 *   node[7]: void node::RemoveEnvironmentCleanupHook(...) at ../src/api/hooks.cc:142
 *   Assertion failed: (env) != nullptr
 *   3: Statement::~Statement() [better_sqlite3.node]
 *
 * observed 5 times in one afternoon. Because the abort happens on the way out,
 * it masked whatever triggered the exit AND skipped the drain's final
 * backupEventsDb()/checkpointDb() pass, leaving the DB dependent on its -wal
 * sidecar. Closing here is the pattern better-sqlite3's own docs prescribe
 * (`process.on('exit', () => db.close())`).
 *
 * Idempotent and never throws: this runs on the exit path, where a raised error
 * would replace one ugly death with another.
 */
export function closeDb(): void {
  const db = _db;
  if (!db) return;
  // Drop the module reference FIRST. A close() that somehow throws must not
  // leave a half-closed handle that a later getDb() would hand out.
  _db = null;
  try {
    if (db.open) db.close();
  } catch (err) {
    log.warn("db", "close failed", { err });
  }
}

const DEFAULT_BACKUP_SLOTS = 3;

async function writeAtomicBackup(srcDb: Database.Database, tmpPath: string): Promise<void> {
  await srcDb.backup(tmpPath);
}

function verifyBackup(tmpPath: string): void {
  let verdict: string;
  const verifier = new Database(tmpPath, { readonly: true });
  try {
    const row = verifier.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
    verdict = row?.integrity_check ?? "unknown";
  } finally {
    verifier.close();
  }
  if (verdict !== "ok") {
    throw new Error(`backup integrity_check failed: ${verdict}`);
  }
}

function rotateBackupSlots(destPath: string, slots: number): void {
  // events.db.bak.(slots-1) → drop. events.db.bak.k → events.db.bak.(k+1)
  // for k in [slots-2..0]. The canonical destPath isn't touched here; the
  // caller renames the tmp onto it next.
  for (let i = slots - 1; i >= 1; i--) {
    const older = `${destPath}.${i}`;
    const newer = `${destPath}.${i - 1}`;
    if (!existsSync(newer)) continue;
    try {
      if (existsSync(older)) unlinkSync(older);
      renameSync(newer, older);
    } catch { /* best-effort rotation */ }
  }
}

/**
 * Atomic, integrity-verified snapshot of events.db, with rotating slots.
 *
 * Flow:
 *   1) Page-level copy via better-sqlite3's online backup() into <dest>.tmp
 *      (survives concurrent writes).
 *   2) Open the temp file read-only and PRAGMA integrity_check; on failure,
 *      delete the temp and throw — we never roll a corrupt snapshot into
 *      rotation, so the last known-good slot survives.
 *   3) Rotate: shift events.db.bak.{N-2..0} → events.db.bak.{N-1..1}; the
 *      newest snapshot lands at events.db.bak (and events.db.bak.0).
 *
 * Default N=3: events.db.bak.0 (newest), .1, .2. With hourly cadence that's
 * 3 hours of history; deployers can override via HOOOP_BACKUP_SLOTS.
 */
export async function backupEventsDb(destPath: string = join(STATE_DIR, "events.db.bak")): Promise<string> {
  return runBackup(getDb(), destPath);
}

/**
 * Snapshot of the archive DB. Same shape as backupEventsDb. Called after a
 * rotation event (rare), not on the periodic backup cadence — the archive is
 * monotonic so its snapshot changes infrequently.
 */
export async function backupArchiveDb(destPath: string = join(STATE_DIR, "events-archive.db.bak")): Promise<string> {
  // Open a fresh read-only handle to the archive file so `backup()` walks
  // the canonical file rather than the attached alias on the main connection.
  const archConn = new Database(ARCHIVE_DB_PATH, { readonly: true });
  try {
    return await runBackup(archConn, destPath);
  } finally {
    archConn.close();
  }
}

async function runBackup(src: Database.Database, destPath: string): Promise<string> {
  const slots = parseInt(process.env.HOOOP_BACKUP_SLOTS ?? "", 10) || DEFAULT_BACKUP_SLOTS;
  const tmp = destPath + ".tmp";
  try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }

  await writeAtomicBackup(src, tmp);

  try {
    verifyBackup(tmp);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }

  rotateBackupSlots(destPath, slots);
  renameSync(tmp, destPath);
  try { copyFileSync(destPath, `${destPath}.0`); } catch { /* ignore */ }
  return destPath;
}

function migrate(db: Database.Database) {
  // Core events table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      session_id TEXT,
      hook_type TEXT,
      tool_name TEXT,
      text TEXT,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id);
    CREATE INDEX IF NOT EXISTS events_ts_idx ON events(ts);
    CREATE INDEX IF NOT EXISTS events_tool_idx ON events(tool_name);
    CREATE INDEX IF NOT EXISTS events_hook_idx ON events(hook_type);
  `);

  // Idempotency column: content_hash is a 32-char hex prefix of sha256(raw_line).
  // Added here (not in the CREATE TABLE above) so existing DBs get it without
  // a full schema recreation. The migration is idempotent — it checks
  // pragma_table_info before altering.
  const hasHash = (db.prepare(
    "SELECT 1 FROM pragma_table_info('events') WHERE name = 'content_hash'"
  ).get() as unknown) !== undefined;
  if (!hasHash) {
    db.exec("ALTER TABLE events ADD COLUMN content_hash TEXT");
  }
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS events_content_hash_uniq ON events(content_hash) WHERE content_hash IS NOT NULL"
  );

  // `kind` mirrors payload's `ctx.kind` (e.g. "task-notification", "command",
  // "plan-approval") as a real, indexed column — added so callers that filter
  // on it (e.g. agents.ts matching a background sub-agent's completion
  // notification) get an indexed lookup instead of an unindexed substring
  // scan over every row's raw JSON payload. Same idempotent add-if-missing
  // pattern as content_hash above.
  const hasKind = (db.prepare(
    "SELECT 1 FROM pragma_table_info('events') WHERE name = 'kind'"
  ).get() as unknown) !== undefined;
  if (!hasKind) {
    db.exec("ALTER TABLE events ADD COLUMN kind TEXT");
    // One-time backfill: pre-migration rows never had `kind` stamped at
    // insert time (see ingestor.ts), so without this they'd silently stop
    // matching the moment callers switch from scanning `payload` to
    // filtering on this column — a historical task-notification (or any
    // other kind-tagged row) would look like it never happened.
    db.exec(`
      UPDATE events SET kind = json_extract(payload, '$.ctx.kind')
      WHERE kind IS NULL AND json_extract(payload, '$.ctx.kind') IS NOT NULL
    `);
  }
  db.exec("CREATE INDEX IF NOT EXISTS events_kind_idx ON events(kind)");

  // BM25 full-text index. content='events' makes this an "external content" FTS5
  // table, so the FTS rowid maps directly to events.id.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      text,
      content='events',
      content_rowid='id',
      tokenize='unicode61'
    );
  `);

  // Vector index. Created only if the sqlite-vec extension is loaded.
  if (hasVecExtensionForDb(db)) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_vec USING vec0(
        embedding float[${EMBED_DIM}]
      );
    `);
  }

  // State table for ingestor offset and other lightweight bookkeeping.
  db.exec(`
    CREATE TABLE IF NOT EXISTS state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO state (key, value) VALUES ('events_offset', '0')").run();
}

function hasVecExtensionForDb(db: Database.Database): boolean {
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
    return false;
  }
}

export function getState(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM state WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setState(key: string, value: string) {
  getDb()
    .prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, value);
}

// ----------------------------------------------------------------------------
// Rotation: move oldest rows from hot to arch when the hot DB exceeds the size
// cap. The min-days floor stops us from ever rotating very recent activity.
// ----------------------------------------------------------------------------

const DEFAULT_HOT_DB_MAX_MB = 1024;     // 1 GB
const DEFAULT_HOT_DB_MIN_DAYS = 30;     // never archive rows younger than this

export interface RotationResult {
  /** Bytes of the hot DB before rotation (main file only, excludes WAL). */
  hotBytesBefore: number;
  /** Bytes of the hot DB after rotation. */
  hotBytesAfter: number;
  /** Number of rows moved to the archive. */
  moved: number;
  /** Oldest ts moved (ISO string), if any. */
  oldestMovedTs: string | null;
  /** Newest ts moved (ISO string), if any. */
  newestMovedTs: string | null;
}

function dbMainBytes(db: Database.Database, schema = "main"): number {
  const pageCount = (db.pragma(`${schema}.page_count`, { simple: true }) as number) || 0;
  const pageSize = (db.pragma(`${schema}.page_size`, { simple: true }) as number) || 0;
  return pageCount * pageSize;
}

/**
 * Check the hot DB size; if over the cap, move rows older than the min-days
 * floor to the archive. Returns the rotation result, or null if nothing was
 * eligible (either under cap, or no rows old enough).
 *
 * Crash-safety: the arch INSERT and the hot DELETE run in separate
 * transactions. A crash between them leaves the row in both tiers; the boot
 * sweep (`reconcileArchiveAfterAttach`) cleans it up at next start.
 */
export function rotateIfNeeded(): RotationResult | null {
  // Use Number() + isFinite so "0" stays 0 (instead of being swallowed by ||).
  // This lets tests force-rotate everything with MAX_MB=0 / MIN_DAYS=0.
  const rawMax = Number(process.env.HOOOP_HOT_DB_MAX_MB);
  const rawMin = Number(process.env.HOOOP_HOT_DB_MIN_DAYS);
  const maxMb = Number.isFinite(rawMax) && rawMax >= 0 ? rawMax : DEFAULT_HOT_DB_MAX_MB;
  const minDays = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : DEFAULT_HOT_DB_MIN_DAYS;
  const maxBytes = maxMb * 1024 * 1024;
  const db = getDb();

  const hotBytesBefore = dbMainBytes(db);
  if (hotBytesBefore <= maxBytes) return null;

  const cutoffTs = new Date(Date.now() - minDays * 86_400_000).toISOString();

  // Find the row-id range to move. Bulk SQL (not row-by-row) keeps this O(1)
  // transaction count even when many rows cross the cutoff at once.
  const bounds = db.prepare(`
    SELECT MIN(id) AS lo, MAX(id) AS hi, MIN(ts) AS oldestTs, MAX(ts) AS newestTs, COUNT(*) AS n
    FROM events
    WHERE ts < ?
  `).get(cutoffTs) as { lo: number | null; hi: number | null; oldestTs: string | null; newestTs: string | null; n: number };

  if (!bounds.n || bounds.lo == null || bounds.hi == null) {
    log.info("db", "rotation needed but min-days floor blocks it", {
      hotBytesBefore, maxBytes, minDays, cutoffTs,
    });
    return null;
  }

  // Phase 1: INSERT into arch (separate commit so a crash leaves arch fully
  // populated; the duplicate rows in hot get cleaned at next boot sweep).
  const insertArch = db.transaction(() => {
    db.prepare(`
      INSERT OR IGNORE INTO arch.events
      SELECT * FROM events WHERE id BETWEEN ? AND ?
    `).run(bounds.lo, bounds.hi);
    db.prepare(`
      INSERT OR IGNORE INTO arch.events_fts(rowid, text)
      SELECT id, text FROM events WHERE id BETWEEN ? AND ? AND text IS NOT NULL
    `).run(bounds.lo, bounds.hi);
    // events_vec is only present when the sqlite-vec extension loaded. The
    // archive may also lack the table if its load failed there — skip the
    // copy silently in that case.
    try {
      db.prepare(`
        INSERT OR IGNORE INTO arch.events_vec(rowid, embedding)
        SELECT rowid, embedding FROM events_vec
        WHERE rowid BETWEEN ? AND ?
      `).run(bounds.lo, bounds.hi);
    } catch (err) {
      log.warn("db", "vec copy skipped during rotation (extension absent)", { err });
    }
  });
  insertArch();

  // Phase 2: DELETE from hot. Use the FTS5 'delete-row' directive so the
  // external-content FTS table doesn't keep ghost entries.
  const deleteHot = db.transaction(() => {
    // FTS5 external-content delete: write 'delete' rows pointing at the
    // doc rowid + its old text. Do this first so the FTS index references
    // are gone before the underlying row.
    db.prepare(`
      INSERT INTO events_fts(events_fts, rowid, text)
      SELECT 'delete', id, text FROM events WHERE id BETWEEN ? AND ? AND text IS NOT NULL
    `).run(bounds.lo, bounds.hi);
    try {
      db.prepare(`DELETE FROM events_vec WHERE rowid BETWEEN ? AND ?`).run(bounds.lo, bounds.hi);
    } catch { /* extension absent */ }
    db.prepare(`DELETE FROM events WHERE id BETWEEN ? AND ?`).run(bounds.lo, bounds.hi);
  });
  deleteHot();

  // Reclaim the freed pages so the next size check sees the drop.
  db.exec("PRAGMA optimize");
  const hotBytesAfter = dbMainBytes(db);

  const result: RotationResult = {
    hotBytesBefore,
    hotBytesAfter,
    moved: bounds.n,
    oldestMovedTs: bounds.oldestTs,
    newestMovedTs: bounds.newestTs,
  };
  log.info("db", "rotation complete", { ...result });
  return result;
}

/**
 * Purge every events-DB trace of the given session ids across BOTH tiers
 * (hot + attached archive): the canonical `events` rows, their external-content
 * FTS5 index entries, and their sqlite-vec embeddings. Called when a session is
 * deleted so search and observability stop surfacing a session that's gone.
 *
 * Delete protocol mirrors `rotateIfNeeded`'s hot delete: per tier, emit the
 * FTS5 'delete' directive (rowid + old text) BEFORE dropping the base rows so
 * the external-content index leaves no ghost entries, then drop the vec rows
 * (skipped if the extension is absent for that tier), then the base rows.
 *
 * Returns the number of `events` rows removed across both tiers.
 */
export function deleteEventsForSessions(sessionIds: string[]): { deleted: number } {
  const ids = [...new Set(sessionIds.filter((s): s is string => typeof s === "string" && s.length > 0))];
  if (ids.length === 0) return { deleted: 0 };

  const db = getDb();
  const placeholders = ids.map(() => "?").join(",");
  let deleted = 0;

  // Each tier is purged in its own transaction so a failure in one (e.g. arch
  // lacking the vec extension) can't roll back the other. The FTS command
  // column is the bare table name even when the table is schema-qualified.
  const purgeTier = (prefix: "" | "arch.") => {
    const events = `${prefix}events`;
    const fts = `${prefix}events_fts`;
    const vec = `${prefix}events_vec`;
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO ${fts}(events_fts, rowid, text)
        SELECT 'delete', id, text FROM ${events}
        WHERE session_id IN (${placeholders}) AND text IS NOT NULL
      `).run(...ids);
      try {
        db.prepare(`
          DELETE FROM ${vec}
          WHERE rowid IN (SELECT id FROM ${events} WHERE session_id IN (${placeholders}))
        `).run(...ids);
      } catch { /* sqlite-vec extension absent in this tier */ }
      const res = db.prepare(`DELETE FROM ${events} WHERE session_id IN (${placeholders})`).run(...ids);
      deleted += res.changes;
    });
    try {
      tx();
    } catch (err) {
      log.warn("db", "session purge failed for a tier", { prefix, err });
    }
  };

  purgeTier("");
  purgeTier("arch.");

  // Reclaim freed pages so the on-disk index shrinks over time.
  try { db.exec("PRAGMA optimize"); } catch { /* best-effort */ }

  if (deleted > 0) {
    log.info("db", "purged events for deleted session(s)", { sessions: ids.length, deleted });
  }
  return { deleted };
}

/**
 * Distinct non-null session ids present in the events DB across both tiers
 * (hot + archive). Used by the boot reconciliation sweep to find event rows
 * whose owning session no longer exists.
 */
export function listEventSessionIds(): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT session_id AS s FROM events WHERE session_id IS NOT NULL
    UNION
    SELECT session_id AS s FROM arch.events WHERE session_id IS NOT NULL
  `).all() as Array<{ s: string }>;
  return rows.map((r) => r.s);
}

/** Bytes (main file only) used by the hot events.db. Exposed for tests. */
export function hotDbBytes(): number {
  return dbMainBytes(getDb());
}

/** Bytes used by the archive DB (main file). Exposed for tests. */
export function archDbBytes(): number {
  return dbMainBytes(getDb(), "arch");
}

/** True if the archive file exists and has any rows. Exposed for tests. */
export function archHasRows(): boolean {
  const db = getDb();
  return (db.prepare("SELECT 1 FROM arch.events LIMIT 1").get() as unknown) !== undefined;
}
