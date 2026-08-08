/**
 * Rotation + archive-attach integration tests.
 *
 * We point STATE_DIR at a temp directory so each test starts with a clean
 * pair of (hot, arch) DBs. The vec extension is loaded if the build's
 * sqlite-vec is available; otherwise vector-related assertions are skipped
 * but BM25 + ingest paths still get exercised.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sandbox-rotation-"));
  process.env.HOME = tmp;                                       // STATE_DIR derives from $HOME/.claude/hooop
  process.env.HOOOP_HOT_DB_MAX_MB = "0";                   // any non-empty hot triggers rotation
  process.env.HOOOP_HOT_DB_MIN_DAYS = "0";                 // ...and any age is eligible
  process.env.HOOOP_ROTATION_CHECK_EVERY = "1000000";      // disable auto-rotation in tests we drive manually
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

function makeLine(payload: Record<string, unknown>, tsDaysAgo = 0): string {
  const ts = new Date(Date.now() - tsDaysAgo * 86_400_000).toISOString();
  // The ingestor's deriveText() picks up tool_input but not stray fields,
  // so put the test marker inside tool_input where it'll surface in the
  // BM25 index and in the `text` column.
  return JSON.stringify({
    ts,
    hook: "PostToolUse",
    ctx: { tool_name: "Bash", tool_input: payload },
  });
}

describe("rotation: archive attach + schema mirror (D1, D5)", () => {
  it("creates the archive DB next to the hot DB on first boot", async () => {
    const { db } = await importFresh();
    db.getDb();
    const archPath = db.ARCHIVE_DB_PATH;
    expect(existsSync(archPath)).toBe(true);
    expect(db.archHasRows()).toBe(false);
  });

  it("boot sweep removes arch rows whose content_hash already exists in hot", async () => {
    const { db, ingestor } = await importFresh();
    const line = makeLine({ command: "ls" });
    const r = ingestor.ingestEventLine(line);
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true });

    // Forge the crash-mid-rotation scenario: copy the hot row into arch
    // without deleting it from hot.
    const dbi = db.getDb();
    dbi.exec(`
      INSERT INTO arch.events SELECT * FROM events;
      INSERT INTO arch.events_fts(rowid, text) SELECT id, text FROM events WHERE text IS NOT NULL;
    `);
    expect(db.archHasRows()).toBe(true);

    // Re-import to trigger the boot sweep on a fresh getDb().
    const fresh = await importFresh();
    fresh.db.getDb();
    expect(fresh.db.archHasRows()).toBe(false);
  });
});

describe("rotation: drain dedup against archive (D2)", () => {
  it("does NOT re-insert into hot a content_hash that already lives in arch", async () => {
    const { db, ingestor } = await importFresh();
    const line = makeLine({ command: "echo hi" });
    ingestor.ingestEventLine(line);

    // Move the row into arch by force (simulating a completed rotation).
    const dbi = db.getDb();
    dbi.exec(`
      INSERT INTO arch.events SELECT * FROM events;
      INSERT INTO arch.events_fts(rowid, text) SELECT id, text FROM events WHERE text IS NOT NULL;
      INSERT INTO events_fts(events_fts, rowid, text) SELECT 'delete', id, text FROM events WHERE text IS NOT NULL;
      DELETE FROM events;
    `);
    expect(db.archHasRows()).toBe(true);
    const hotBefore = dbi.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(hotBefore.n).toBe(0);

    // Now re-ingest the same line (simulating a drain replay after a hot wipe).
    ingestor.ingestEventLine(line);
    const hotAfter = dbi.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(hotAfter.n).toBe(0);  // dedup kept it out of hot
    const archAfter = dbi.prepare("SELECT COUNT(*) AS n FROM arch.events").get() as { n: number };
    expect(archAfter.n).toBe(1);
  });
});

describe("rotation: move oldest to archive (D4)", () => {
  it("respects the min-days floor — under-cap returns null", async () => {
    process.env.HOOOP_HOT_DB_MAX_MB = "1024";   // huge cap, never rotate
    const { db, ingestor } = await importFresh();
    ingestor.ingestEventLine(makeLine({ command: "x" }));
    expect(db.rotateIfNeeded()).toBeNull();
  });

  it("over-cap + min-days=0 moves all eligible rows", async () => {
    process.env.HOOOP_HOT_DB_MAX_MB = "0";
    process.env.HOOOP_HOT_DB_MIN_DAYS = "0";
    const { db, ingestor } = await importFresh();
    // Stamp rows 1 day in the past so they're unambiguously eligible —
    // the rotation cutoff (strictly `<`) excludes same-millisecond rows.
    for (let i = 0; i < 5; i++) {
      ingestor.ingestEventLine(makeLine({ command: `cmd-${i}` }, 1));
    }
    const before = db.getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    expect(before.n).toBe(5);

    const result = db.rotateIfNeeded();
    expect(result).not.toBeNull();
    expect(result!.moved).toBe(5);

    const hotAfter = db.getDb().prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number };
    const archAfter = db.getDb().prepare("SELECT COUNT(*) AS n FROM arch.events").get() as { n: number };
    expect(hotAfter.n).toBe(0);
    expect(archAfter.n).toBe(5);
  });

  it("min-days floor protects recent rows; only old ones move", async () => {
    process.env.HOOOP_HOT_DB_MAX_MB = "0";
    process.env.HOOOP_HOT_DB_MIN_DAYS = "7";
    const { db, ingestor } = await importFresh();
    // 3 old (10 days), 2 recent (today)
    ingestor.ingestEventLine(makeLine({ command: "old-1" }, 10));
    ingestor.ingestEventLine(makeLine({ command: "old-2" }, 10));
    ingestor.ingestEventLine(makeLine({ command: "old-3" }, 10));
    ingestor.ingestEventLine(makeLine({ command: "now-1" }, 0));
    ingestor.ingestEventLine(makeLine({ command: "now-2" }, 0));

    const result = db.rotateIfNeeded();
    expect(result).not.toBeNull();
    expect(result!.moved).toBe(3);

    const hotRows = db.getDb().prepare("SELECT text FROM events ORDER BY id").all() as Array<{ text: string }>;
    expect(hotRows.map((r) => r.text).every((t) => t.includes("now-"))).toBe(true);
    const archRows = db.getDb().prepare("SELECT text FROM arch.events ORDER BY id").all() as Array<{ text: string }>;
    expect(archRows.map((r) => r.text).every((t) => t.includes("old-"))).toBe(true);
  });
});

describe("search union across hot + arch (D3)", () => {
  it("BM25 returns hits from both tiers, tier-tagged", async () => {
    process.env.HOOOP_HOT_DB_MAX_MB = "0";
    process.env.HOOOP_HOT_DB_MIN_DAYS = "0";
    const { db, ingestor, search } = await importFresh();

    // Insert 2 rows (clearly old so rotation cutoff includes them) then rotate.
    ingestor.ingestEventLine(makeLine({ command: "alpha-archived-keyword" }, 1));
    ingestor.ingestEventLine(makeLine({ command: "beta-archived-keyword" }, 1));
    const rot = db.rotateIfNeeded();
    expect(rot, JSON.stringify(rot)).not.toBeNull();
    expect(db.archHasRows()).toBe(true);

    // Insert 1 more row, leave it in hot.
    ingestor.ingestEventLine(makeLine({ command: "gamma-hot-keyword" }));

    const archHits = await search.search("alpha-archived-keyword", "bm25", 10);
    expect(archHits.results).toHaveLength(1);
    expect(archHits.results[0].tier).toBe("arch");
    expect(archHits.results[0].text).toContain("alpha-archived-keyword");

    const hotHits = await search.search("gamma-hot-keyword", "bm25", 10);
    expect(hotHits.results).toHaveLength(1);
    expect(hotHits.results[0].tier).toBe("hot");

    // Both-tier query: search for a token that's in arch only — should still
    // surface from the archive even though hot is non-empty.
    const both = await search.search("archived-keyword", "bm25", 10);
    expect(both.results.length).toBe(2);
    expect(both.results.every((r) => r.tier === "arch")).toBe(true);
  });

  it("search dedupes when the same content_hash appears in both tiers (mid-rotation crash)", async () => {
    const { db, ingestor, search } = await importFresh();

    ingestor.ingestEventLine(makeLine({ command: "duplicate-token-xyz" }));
    // Force the crash-mid-rotation state by COPYING (not moving) the row to arch.
    db.getDb().exec(`
      INSERT INTO arch.events SELECT * FROM events;
      INSERT INTO arch.events_fts(rowid, text) SELECT id, text FROM events WHERE text IS NOT NULL;
    `);

    const hits = await search.search("duplicate-token-xyz", "bm25", 10);
    expect(hits.results).toHaveLength(1);  // dedup kept it to one
    expect(hits.results[0].tier).toBe("hot");
  });
});
