import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Same isolation pattern as db-backup.test.ts: a real temp HOME, and the module
// imported dynamically so paths.ts computes STATE_DIR from it.
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbox-shutdown-marker-"));
  process.env.HOME = dir;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.HOME;
});

// The marker exists so boot can tell "we restarted on purpose" from "we
// crashed". The checkpoint restores every session as dormant either way, so
// without it a crash looks exactly like sessions going idle on their own.
describe("clean-shutdown marker", () => {
  it("reports UNCLEAN when no marker exists (the crash case)", async () => {
    const { consumeUncleanShutdown } = await import("./shutdown-marker");
    expect(consumeUncleanShutdown()).toBe(true);
  });

  it("reports CLEAN after a drain wrote the marker", async () => {
    const { markCleanShutdown, consumeUncleanShutdown } = await import("./shutdown-marker");
    markCleanShutdown();
    expect(consumeUncleanShutdown()).toBe(false);
  });

  // Read-AND-clear: without the delete, one clean shutdown would make every
  // later crash read as clean forever.
  it("consumes the marker, so the NEXT boot reports unclean again", async () => {
    const { markCleanShutdown, consumeUncleanShutdown } = await import("./shutdown-marker");
    markCleanShutdown();
    expect(consumeUncleanShutdown()).toBe(false);
    expect(consumeUncleanShutdown()).toBe(true);
  });

  it("creates STATE_DIR when it doesn't exist yet (first-ever boot)", async () => {
    const { markCleanShutdown, consumeUncleanShutdown } = await import("./shutdown-marker");
    expect(existsSync(join(dir, ".claude", "hooop"))).toBe(false);
    markCleanShutdown();
    expect(consumeUncleanShutdown()).toBe(false);
  });

  // An undeletable marker must not invert into a PERMANENT "unclean" verdict
  // that cries wolf on every boot from then on.
  it("treats an unremovable marker as clean rather than crying wolf forever", async () => {
    const stateDir = join(dir, ".claude", "hooop");
    mkdirSync(stateDir, { recursive: true });
    // A directory where the marker file is expected: exists() passes, unlink fails.
    mkdirSync(join(stateDir, "clean-shutdown"), { recursive: true });
    const { consumeUncleanShutdown } = await import("./shutdown-marker");
    expect(consumeUncleanShutdown()).toBe(false);
  });
});
