/**
 * Regression test for a crash that took the whole sandbox server down.
 *
 * Node's recursive fs.watch emits an `'error'` event when a watched directory
 * disappears under it, and EventEmitter RETHROWS `'error'` when nothing is
 * listening — so removing a session workdir turned into an uncaught ENOENT that
 * killed the process and every live session with it. Observed in production shape:
 *
 *     Error: ENOENT: no such file or directory, scandir '.../sessions/<id>'
 *         at #watchFolder (node:internal/fs/recursive_watch:122:21)
 *
 * The try/catch every call site already wraps `watch()` in does not help: it
 * covers the synchronous setup throw, not an event emitted later.
 *
 * These tests assert the emitter contract rather than trying to race a real
 * recursive re-scan, which is timing-dependent and platform-specific. The
 * contract IS the bug: a watcher with no 'error' listener is a latent crash.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { watchSafe } from "./watch-safe";

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "watch-safe-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("watchSafe", () => {
  it("attaches an 'error' listener, so an emitted error cannot become an uncaught throw", () => {
    const dir = join(root, "watched");
    mkdirSync(dir);
    const w = watchSafe(dir, { recursive: false }, () => {});

    // The whole bug in one assertion: with zero listeners, emit() rethrows.
    expect(w.listenerCount("error")).toBeGreaterThan(0);

    // Emitting the exact error Node produces must NOT throw.
    const enoent: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, scandir '${dir}'`);
    enoent.code = "ENOENT";
    expect(() => w.emit("error", enoent)).not.toThrow();

    w.close();
  });

  it("closes the watcher when it errors, rather than leaving a dead handle armed", () => {
    const dir = join(root, "gone");
    mkdirSync(dir);
    const w = watchSafe(dir, { recursive: false }, () => {});

    let closed = false;
    const realClose = w.close.bind(w);
    w.close = () => { closed = true; realClose(); };

    const err: NodeJS.ErrnoException = new Error("ENOENT");
    err.code = "ENOENT";
    w.emit("error", err);

    expect(closed).toBe(true);
  });

  it("survives a non-ENOENT error too (louder, but still not fatal)", () => {
    const dir = join(root, "perm");
    mkdirSync(dir);
    const w = watchSafe(dir, { recursive: false }, () => {});

    const err: NodeJS.ErrnoException = new Error("EACCES: permission denied");
    err.code = "EACCES";
    expect(() => w.emit("error", err)).not.toThrow();

    w.close();
  });

  it("still delivers change events (the handler does not swallow the happy path)", async () => {
    const dir = join(root, "live");
    mkdirSync(dir);

    // Keep writing until the watcher fires. fs.watch arms asynchronously, so a
    // single write straight after the call races the arming and is missed under
    // load — which is exactly how this test failed in the full suite while
    // passing on its own.
    let timer: NodeJS.Timeout | undefined;
    let n = 0;
    const w = watchSafe(dir, { recursive: false }, () => {});

    const seen = new Promise<void>((resolve) => {
      w.on("change", () => resolve());
      w.on("rename", () => resolve());
      timer = setInterval(() => writeFileSync(join(dir, `touched-${n++}.txt`), "x"), 100);
    });

    try {
      await expect(
        Promise.race([seen, new Promise((_, r) => setTimeout(() => r(new Error("no event")), 8000))]),
      ).resolves.toBeUndefined();
    } finally {
      if (timer) clearInterval(timer);
      w.close();
    }
  });

  it("still throws synchronously when the path cannot be watched at all", () => {
    // Callers rely on this: "never started" is handled by their existing
    // try/catch and is a different condition from "died later".
    expect(() => watchSafe(join(root, "does-not-exist"), { recursive: false }, () => {})).toThrow();
  });
});
