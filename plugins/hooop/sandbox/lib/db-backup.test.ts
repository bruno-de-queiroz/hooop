import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbox-db-backup-"));
  process.env.HOME = dir;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOME;
  delete process.env.HOOOP_BACKUP_SLOTS;
});

describe("backupEventsDb (better-sqlite3 backup contract)", () => {
  it("produces a readable SQLite snapshot with the same content as the source", async () => {
    const { getDb, backupEventsDb } = await import("./db");
    const db = getDb();
    db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("test-key", "hello");

    const dest = join(dir, "events.db.bak");
    await backupEventsDb(dest);

    expect(existsSync(dest)).toBe(true);
    expect(statSync(dest).size).toBeGreaterThan(0);

    const bak = new Database(dest, { readonly: true });
    const row = bak.prepare("SELECT value FROM state WHERE key = ?").get("test-key") as { value: string };
    expect(row?.value).toBe("hello");
    bak.close();
  });

  it("rewrites the destination atomically (no .tmp left dangling)", async () => {
    const { backupEventsDb } = await import("./db");
    const dest = join(dir, "events.db.bak");
    await backupEventsDb(dest);
    const sizeFirst = statSync(dest).size;
    await backupEventsDb(dest);
    const sizeSecond = statSync(dest).size;
    expect(sizeSecond).toBe(sizeFirst);
    expect(existsSync(dest + ".tmp")).toBe(false);
  });

  it("rotates events.db.bak.{0..N-1} on each run", async () => {
    process.env.HOOOP_BACKUP_SLOTS = "3";
    const { getDb, backupEventsDb } = await import("./db");
    const db = getDb();
    const dest = join(dir, "events.db.bak");

    const setStateAndBackup = async (value: string) => {
      db.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
        .run("rotation-test", value);
      await backupEventsDb(dest);
    };

    await setStateAndBackup("v1");
    await setStateAndBackup("v2");
    await setStateAndBackup("v3");

    // Slot 0 (newest) has v3; slot 1 has v2 (was the previous newest);
    // slot 2 has v1 (was rotated out).
    const read = (slot: string) => {
      const d = new Database(slot, { readonly: true });
      try {
        const row = d.prepare("SELECT value FROM state WHERE key = ?").get("rotation-test") as { value?: string };
        return row?.value;
      } finally { d.close(); }
    };
    expect(read(`${dest}.0`)).toBe("v3");
    expect(read(`${dest}.1`)).toBe("v2");
    expect(read(`${dest}.2`)).toBe("v1");
  });

  it("rejects a corrupted snapshot and keeps the previous good backup in place", async () => {
    const { getDb, backupEventsDb } = await import("./db");
    const dest = join(dir, "events.db.bak");

    // First, a healthy backup. This is the "last known good".
    await backupEventsDb(dest);
    const goodBytesBefore = statSync(dest).size;

    // Inject a real corruption: monkey-patch the live db's backup() so it
    // writes garbage to the temp path. The verifier inside backupEventsDb
    // should open that garbage, see PRAGMA integrity_check fail, and
    // throw — leaving the existing dest untouched.
    const db = getDb();
    const spy = vi.spyOn(db, "backup").mockImplementation(async (filename: string) => {
      writeFileSync(filename, "NOT A SQLITE FILE\n");
      return { totalPages: 0, remainingPages: 0 } as any;
    });

    try {
      // The error message can come from either gate: the verifier's open()
      // ("file is not a database") or the integrity_check pragma itself
      // ("integrity_check failed: ..."). Either way, the corrupted snapshot
      // must NOT be promoted onto `dest`.
      await expect(backupEventsDb(dest)).rejects.toThrow(/integrity_check|not a database/);
    } finally {
      spy.mockRestore();
    }
    // Verifier cleaned up the corrupted tmp on rejection.
    expect(existsSync(dest + ".tmp")).toBe(false);

    // The known-good backup at `dest` MUST be untouched.
    expect(statSync(dest).size).toBe(goodBytesBefore);
    const verifier = new Database(dest, { readonly: true });
    try {
      const row = verifier.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      expect(row?.integrity_check).toBe("ok");
    } finally {
      verifier.close();
    }
  });
});
