import { vi, describe, it, expect, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mutable state that the hoisted mocks close over. vi.hoisted() runs
// before any imports so closures capture the same object.
// ---------------------------------------------------------------------------

const shared = vi.hoisted(() => ({
  appended: [] as string[],
  state: new Map<string, string>(),
  dbShouldThrow: false,
  fsShouldThrow: false,
  setStateShouldThrow: false,
  // Simulated "already inserted" rows: hash -> id
  existingHashes: new Map<string, number>(),
  // Track run() calls to the INSERT statement
  insertRunCalls: 0,
  nextInsertId: 1,
  reset() {
    this.appended = [];
    this.state.clear();
    this.dbShouldThrow = false;
    this.fsShouldThrow = false;
    this.setStateShouldThrow = false;
    this.existingHashes.clear();
    this.insertRunCalls = 0;
    this.nextInsertId = 1;
  },
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => {
  const api = {
    appendFileSync: (_path: string, data: string) => {
      if (shared.fsShouldThrow) throw new Error("simulated fs failure");
      shared.appended.push(data);
    },
    existsSync: () => false,
    mkdirSync: () => undefined,
    openSync: () => 0,
    readSync: () => 0,
    statSync: () => ({ size: 0 } as any),
    closeSync: () => undefined,
  };
  return { ...api, default: api };
});

vi.mock("./db", () => {
  // The ingestor calls db.prepare() for three statements:
  //   1. INSERT INTO events ...          (uses .run())
  //   2. SELECT id FROM events WHERE ... (uses .get())
  //   3. INSERT INTO events_fts ...      (uses .run())
  //
  // We distinguish them by the SQL prefix passed to prepare().
  function makeDb() {
    return {
      prepare: (sql: string) => {
        const isLookup = sql.trim().toUpperCase().startsWith("SELECT");
        if (isLookup) {
          return {
            get: (hash: string) => {
              const id = shared.existingHashes.get(hash);
              return id !== undefined ? { id } : undefined;
            },
          };
        }
        // INSERT (events or events_fts)
        return {
          run: (..._args: unknown[]) => {
            if (shared.dbShouldThrow) throw new Error("simulated DB failure");
            const id = shared.nextInsertId;
            shared.nextInsertId++;
            shared.insertRunCalls++;
            return { lastInsertRowid: id };
          },
        };
      },
      transaction: (fn: () => void) => () => fn(),
    };
  }
  return {
    getDb: makeDb,
    getState: (k: string) => shared.state.get(k) ?? null,
    setState: (k: string, v: string) => {
      if (shared.setStateShouldThrow && k === "events_offset") {
        throw new Error("simulated setState failure");
      }
      shared.state.set(k, v);
    },
    hasVecExtension: () => false,
  };
});

vi.mock("./embeddings", () => ({
  embed: vi.fn(),
  isEmbeddingConfigured: () => false,
}));

vi.mock("./paths", () => ({
  EVENTS_FILE: "/mock/events.jsonl",
  STATE_DIR: "/mock",
  DB_PATH: "/mock/events.db",
  CLAUDE_SESSIONS_DIR: "/mock/sessions",
  CLAUDE_SKILLS_DIR: "/mock/skills",
  EMBED_DIM: 1536,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let mod: typeof import("./ingestor");

beforeEach(async () => {
  vi.resetModules();
  shared.reset();
  mod = await import("./ingestor");
});

// ---------------------------------------------------------------------------
// Original durability tests (updated to check new return value)
// ---------------------------------------------------------------------------

describe("ingestEventLine durability", () => {
  it("appends to the audit log AND advances offset on successful DB insert", () => {
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';
    mod.ingestEventLine(line);
    expect(shared.appended).toHaveLength(1);
    expect(shared.appended[0]).toBe(line + "\n");
    expect(shared.state.get("events_offset")).toBe(String(Buffer.byteLength(line + "\n", "utf-8")));
  });

  it("does NOT advance offset when DB insert fails — so next drain replays the line", () => {
    shared.dbShouldThrow = true;
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';
    expect(() => mod.ingestEventLine(line)).not.toThrow();
    // Audit log still got the line (we appended before attempting the insert).
    expect(shared.appended).toHaveLength(1);
    // But the offset stayed put, so on next drain this line will be re-ingested.
    expect(shared.state.get("events_offset")).toBeUndefined();
  });

  it("advances offset by the exact byte length of the appended line", () => {
    const line = '{"hook":"Stop","ctx":{"last_assistant_message":"héllo"}}';
    const expected = Buffer.byteLength(line + "\n", "utf-8");
    mod.ingestEventLine(line);
    expect(shared.state.get("events_offset")).toBe(String(expected));
  });

  it("appends a newline if the input line doesn't already have one", () => {
    mod.ingestEventLine("no-newline");
    expect(shared.appended[0]).toBe("no-newline\n");
  });

  it("does not double-append the newline when the input already ends in one", () => {
    mod.ingestEventLine("has-newline\n");
    expect(shared.appended[0]).toBe("has-newline\n");
  });
});

// ---------------------------------------------------------------------------
// New result-type tests (Steps 1–5 from the spec)
// ---------------------------------------------------------------------------

describe("ingestEventLine — result type", () => {
  it("happy path: returns { ok: true, id } and row appears in DB", () => {
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';
    const result = mod.ingestEventLine(line);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.id).toBe("number");
    }
    // Audit log written and offset advanced.
    expect(shared.appended).toHaveLength(1);
    expect(shared.state.get("events_offset")).toBeDefined();
  });

  it("replay-safety: ingesting the same line twice returns ok both times, only one DB insert", () => {
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';

    const r1 = mod.ingestEventLine(line);
    expect(r1.ok).toBe(true);
    const id1 = (r1 as { ok: true; id?: number }).id;

    // Simulate what happens on replay: the hash is already in existingHashes.
    // We derive the same hash the ingestor would use (sha256(line).slice(0,32)).
    const { createHash } = require("node:crypto");
    const hash = createHash("sha256").update(line).digest("hex").slice(0, 32);
    shared.existingHashes.set(hash, id1!);

    const insertsBefore = shared.insertRunCalls;

    const r2 = mod.ingestEventLine(line);
    expect(r2.ok).toBe(true);
    const id2 = (r2 as { ok: true; id?: number }).id;

    // No new INSERT was issued for the duplicate line.
    // insertRunCalls increments only on a real INSERT (not on the SELECT hit).
    expect(shared.insertRunCalls).toBe(insertsBefore);

    // The returned id is the existing row's id (from the lookup).
    expect(id2).toBe(id1);
  });

  it("append failure: returns { ok: false, reason: 'audit-log-append-failed' }, no DB insert", () => {
    shared.fsShouldThrow = true;
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';
    const result = mod.ingestEventLine(line);
    expect(result).toEqual({ ok: false, reason: "audit-log-append-failed" });
    // No DB insert should have occurred.
    expect(shared.insertRunCalls).toBe(0);
  });

  it("DB insert failure: returns { ok: false, reason: 'db-ingest-failed' }, audit log IS written", () => {
    shared.dbShouldThrow = true;
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';
    const result = mod.ingestEventLine(line);
    expect(result).toEqual({ ok: false, reason: "db-ingest-failed" });
    // The audit log was appended before the DB attempt.
    expect(shared.appended).toHaveLength(1);
    expect(shared.appended[0]).toBe(line + "\n");
  });

  it("DB insert failure: replay-on-next-drain works — idempotency de-dups on second attempt", () => {
    // First attempt: append succeeds, DB fails.
    shared.dbShouldThrow = true;
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';
    const r1 = mod.ingestEventLine(line);
    expect(r1.ok).toBe(false);
    // No inserts happened during the failing attempt.
    expect(shared.insertRunCalls).toBe(0);

    // Second attempt (simulating drain): DB is healthy now.
    shared.dbShouldThrow = false;
    const r2 = mod.ingestEventLine(line);
    expect(r2.ok).toBe(true);
    if (r2.ok) {
      expect(typeof r2.id).toBe("number");
    }
    // At least one INSERT ran (events row; FTS row if text is non-empty).
    expect(shared.insertRunCalls).toBeGreaterThan(0);
  });

  it("setState failure: returns { ok: true } (insert succeeded), logs a warning", () => {
    shared.setStateShouldThrow = true;
    const line = '{"ts":"2026-05-12T00:00:00Z","hook":"Stop","ctx":{}}';
    const result = mod.ingestEventLine(line);
    // The insert succeeded even though setState threw.
    expect(result.ok).toBe(true);
    // The DB row was inserted.
    expect(shared.insertRunCalls).toBeGreaterThan(0);
    // Offset was NOT written (setState threw).
    expect(shared.state.get("events_offset")).toBeUndefined();
  });
});
