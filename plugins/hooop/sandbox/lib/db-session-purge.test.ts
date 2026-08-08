/**
 * deleteEventsForSessions: purging a deleted session's events from the search
 * DB across BOTH tiers (hot + archive), including the external-content FTS5
 * index and the sqlite-vec table.
 *
 * Points STATE_DIR at a temp $HOME so each test gets a clean (hot, arch) pair.
 * The vec extension is loaded if the build ships sqlite-vec; vec-specific
 * assertions are skipped otherwise but BM25 + base-row paths always run.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sandbox-purge-"));
  process.env.HOME = tmp;
  process.env.HOOOP_HOT_DB_MAX_MB = "0";
  process.env.HOOOP_HOT_DB_MIN_DAYS = "0";
  process.env.HOOOP_ROTATION_CHECK_EVERY = "1000000";
  delete process.env.OPENAI_API_KEY;
  delete process.env.EMBEDDING_BASE_URL;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.HOOOP_HOT_DB_MAX_MB;
  delete process.env.HOOOP_HOT_DB_MIN_DAYS;
  delete process.env.HOOOP_ROTATION_CHECK_EVERY;
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function importFresh() {
  vi.resetModules();
  const db = await import("./db");
  const ingestor = await import("./ingestor");
  const search = await import("./search");
  return { db, ingestor, search };
}

function makeLine(sessionId: string, marker: string, tsDaysAgo = 0): string {
  const ts = new Date(Date.now() - tsDaysAgo * 86_400_000).toISOString();
  return JSON.stringify({
    ts,
    hook: "PostToolUse",
    ctx: { session_id: sessionId, tool_name: "Bash", tool_input: { command: marker } },
  });
}

describe("deleteEventsForSessions: hot tier", () => {
  it("removes only the target session's rows from events + FTS", async () => {
    const { db, ingestor, search } = await importFresh();
    ingestor.ingestEventLine(makeLine("sess-A", "alpha-keyword-aaa"));
    ingestor.ingestEventLine(makeLine("sess-A", "alpha-keyword-bbb"));
    ingestor.ingestEventLine(makeLine("sess-B", "beta-keyword-ccc"));

    const before = db.getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(before.n).toBe(3);

    const res = db.deleteEventsForSessions(["sess-A"]);
    expect(res.deleted).toBe(2);

    const rows = db.getDb().prepare("SELECT session_id FROM events").all() as Array<{ session_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess-B");

    // FTS must not surface the deleted session anymore.
    const goneA = await search.search("alpha-keyword-aaa", "bm25", 10);
    expect(goneA.results).toHaveLength(0);
    const stillB = await search.search("beta-keyword-ccc", "bm25", 10);
    expect(stillB.results).toHaveLength(1);
    expect(stillB.results[0].session_id).toBe("sess-B");
  });

  it("is a no-op for unknown or empty ids", async () => {
    const { db, ingestor } = await importFresh();
    ingestor.ingestEventLine(makeLine("sess-A", "keeper"));
    expect(db.deleteEventsForSessions([]).deleted).toBe(0);
    expect(db.deleteEventsForSessions([""]).deleted).toBe(0);
    expect(db.deleteEventsForSessions(["does-not-exist"]).deleted).toBe(0);
    const n = db.getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(n.n).toBe(1);
  });
});

describe("deleteEventsForSessions: archive tier", () => {
  it("purges rows that were rotated into the archive (FTS delete on arch.events_fts)", async () => {
    const { db, ingestor, search } = await importFresh();
    // Old rows so the rotation cutoff (strict <) includes them.
    ingestor.ingestEventLine(makeLine("sess-A", "archived-keyword-aaa", 1));
    ingestor.ingestEventLine(makeLine("sess-B", "archived-keyword-bbb", 1));
    const rot = db.rotateIfNeeded();
    expect(rot, JSON.stringify(rot)).not.toBeNull();
    expect(db.archHasRows()).toBe(true);

    // Sanity: search finds sess-A in the archive before the purge.
    const preHit = await search.search("archived-keyword-aaa", "bm25", 10);
    expect(preHit.results).toHaveLength(1);
    expect(preHit.results[0].tier).toBe("arch");

    const res = db.deleteEventsForSessions(["sess-A"]);
    expect(res.deleted).toBe(1);

    // sess-A gone from arch base rows AND its FTS index; sess-B untouched.
    const archRows = db.getDb().prepare("SELECT session_id FROM arch.events").all() as Array<{ session_id: string }>;
    expect(archRows).toHaveLength(1);
    expect(archRows[0].session_id).toBe("sess-B");

    const goneA = await search.search("archived-keyword-aaa", "bm25", 10);
    expect(goneA.results).toHaveLength(0);
    const stillB = await search.search("archived-keyword-bbb", "bm25", 10);
    expect(stillB.results).toHaveLength(1);
  });

  it("purges the same session across BOTH tiers at once", async () => {
    const { db, ingestor, search } = await importFresh();
    // One old row (rotated to arch) + one fresh row (stays hot) for sess-A.
    ingestor.ingestEventLine(makeLine("sess-A", "split-keyword-old", 1));
    db.rotateIfNeeded();
    ingestor.ingestEventLine(makeLine("sess-A", "split-keyword-new", 0));

    const both = await search.search("split-keyword", "bm25", 10);
    expect(both.results.length).toBe(2);

    const res = db.deleteEventsForSessions(["sess-A"]);
    expect(res.deleted).toBe(2);

    const gone = await search.search("split-keyword", "bm25", 10);
    expect(gone.results).toHaveLength(0);
  });
});

describe("reconcileOrphanEvents: boot sweep", () => {
  it("purges events for sessions with no transcript/registry/claude-session, keeps known ones", async () => {
    vi.resetModules();
    const db = await import("./db");
    const ingestor = await import("./ingestor");
    const active = await import("./active-sessions");
    const fs = await import("node:fs");
    const path = await import("node:path");

    // sess-live has a transcript on disk → must be kept.
    const projDir = path.join(tmp, ".claude", "projects", "-work");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "sess-live.jsonl"), "{}\n");

    ingestor.ingestEventLine(makeLine("sess-live", "live-keyword"));
    ingestor.ingestEventLine(makeLine("sess-orphan", "orphan-keyword"));
    ingestor.ingestEventLine(makeLine("pending-xyz", "pending-keyword"));

    const before = db.getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(before.n).toBe(3);

    const res = active.reconcileOrphanEvents();
    expect(res.sessions).toBe(2);   // sess-orphan + pending-xyz
    expect(res.deleted).toBe(2);

    const rows = db.getDb().prepare("SELECT session_id FROM events").all() as Array<{ session_id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].session_id).toBe("sess-live");
  });

  it("is a no-op when every event session still exists", async () => {
    vi.resetModules();
    const db = await import("./db");
    const ingestor = await import("./ingestor");
    const active = await import("./active-sessions");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const projDir = path.join(tmp, ".claude", "projects", "-work");
    fs.mkdirSync(projDir, { recursive: true });
    fs.writeFileSync(path.join(projDir, "sess-keep.jsonl"), "{}\n");
    ingestor.ingestEventLine(makeLine("sess-keep", "keep-keyword"));

    const res = active.reconcileOrphanEvents();
    expect(res).toEqual({ deleted: 0, sessions: 0 });
    const n = db.getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(n.n).toBe(1);
  });
});
