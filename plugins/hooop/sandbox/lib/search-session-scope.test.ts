/**
 * search() session scoping: a scoped search must never return rows from a
 * session outside the scope, and an empty scope must return nothing (no
 * fall-through to an unscoped query). This is the SQL-level half of the
 * "events don't leak to peers from other sessions" rule; the dashboard passes
 * a peer's (alias-expanded) session set as the scope.
 *
 * Uses a temp $HOME so each test gets a clean events DB. BM25 needs no config.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sandbox-search-scope-"));
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
  const ingestor = await import("./ingestor");
  const search = await import("./search");
  return { ingestor, search };
}

function makeLine(sessionId: string, marker: string): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    hook: "PostToolUse",
    ctx: { session_id: sessionId, tool_name: "Bash", tool_input: { command: marker } },
  });
}

describe("search() session scoping (BM25)", () => {
  it("returns only in-scope rows when the same keyword exists in two sessions", async () => {
    const { ingestor, search } = await importFresh();
    // Same searchable keyword logged under two different sessions.
    ingestor.ingestEventLine(makeLine("sess-A", "sharedkeyword"));
    ingestor.ingestEventLine(makeLine("sess-B", "sharedkeyword"));

    const unscoped = await search.search("sharedkeyword", "bm25", 10);
    expect(unscoped.results).toHaveLength(2);

    const scoped = await search.search("sharedkeyword", "bm25", 10, ["sess-A"]);
    expect(scoped.results).toHaveLength(1);
    expect(scoped.results[0].session_id).toBe("sess-A");
  });

  it("honours a multi-id scope (alias set) but still excludes others", async () => {
    const { ingestor, search } = await importFresh();
    ingestor.ingestEventLine(makeLine("sess-A", "sharedkeyword"));
    ingestor.ingestEventLine(makeLine("sess-A2", "sharedkeyword"));
    ingestor.ingestEventLine(makeLine("sess-B", "sharedkeyword"));

    const scoped = await search.search("sharedkeyword", "bm25", 10, ["sess-A", "sess-A2"]);
    expect(scoped.results).toHaveLength(2);
    expect(scoped.results.map((r) => r.session_id).sort()).toEqual(["sess-A", "sess-A2"]);
  });

  it("returns nothing for a session with no matches (no leak)", async () => {
    const { ingestor, search } = await importFresh();
    ingestor.ingestEventLine(makeLine("sess-B", "sharedkeyword"));

    const scoped = await search.search("sharedkeyword", "bm25", 10, ["sess-A"]);
    expect(scoped.results).toHaveLength(0);
  });

  it("returns nothing for an empty scope instead of falling back to unscoped", async () => {
    const { ingestor, search } = await importFresh();
    ingestor.ingestEventLine(makeLine("sess-A", "sharedkeyword"));

    const scoped = await search.search("sharedkeyword", "bm25", 10, []);
    expect(scoped.results).toHaveLength(0);
  });
});
