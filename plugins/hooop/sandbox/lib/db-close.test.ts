import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Real temp HOME + dynamic import, matching db-backup.test.ts, so paths.ts
// computes STATE_DIR from the throwaway dir.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbox-db-close-"));
  process.env.HOME = dir;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOME;
});

// closeDb is the actual fix for the native teardown abort: it finalizes prepared
// statements while the Node environment is still alive, instead of letting their
// C++ destructors run during teardown where RemoveEnvironmentCleanupHook
// asserts (env) != nullptr.
describe("closeDb", () => {
  it("closes the handle and is safe to call twice", async () => {
    const { getDb, closeDb } = await import("./db");
    const db = getDb();
    expect(db.open).toBe(true);
    closeDb();
    expect(db.open).toBe(false);
    closeDb(); // idempotent — the exit hook can race the drain
  });

  it("hands out a fresh, usable handle after a close", async () => {
    const { getDb, closeDb } = await import("./db");
    const first = getDb();
    closeDb();
    const second = getDb();
    expect(second).not.toBe(first);
    expect(second.open).toBe(true);
    // Usable, not merely open.
    second.prepare("INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run("k", "v");
    expect((second.prepare("SELECT value FROM state WHERE key = ?").get("k") as { value: string }).value).toBe("v");
    closeDb();
  });
});
