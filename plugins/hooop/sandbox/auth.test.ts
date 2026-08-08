/**
 * Tests for the two bearer tokens the sandbox mints.
 *
 * This file did not exist before: token minting, the on-disk modes, the
 * reuse guard and the comparison helpers were entirely uncovered, and
 * server-ingest.test.ts actively mocks this module away. That is a thin place
 * for the credential that gates the whole control plane, so the modes in
 * particular are pinned here — they're a security property expressed as a
 * number that nothing else would catch if it drifted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both token paths come from lib/paths; point them at a temp dir so tests never
// touch a real profile or the container's run dirs. Mocked before the module
// under test is imported.
//
// Getters rather than plain values because the paths are re-pointed per test
// and this module is re-imported each time (see vi.resetModules below).
let sandboxTokenFile = "";
let hookTokenFile = "";
vi.mock("./lib/paths", () => ({
  get SANDBOX_TOKEN_FILE() {
    return sandboxTokenFile;
  },
  get HOOK_TOKEN_FILE() {
    return hookTokenFile;
  },
}));

vi.mock("@shared/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };
let tmpRoot = "";

beforeEach(() => {
  // Tokens are cached in module-level state, so every test needs a fresh
  // module instance to exercise minting rather than the cache.
  vi.resetModules();
  tmpRoot = mkdtempSync(join(tmpdir(), "auth-test-"));
  // Two directories, mirroring the split in the container: the control token
  // lives beside the control socket on the shared volume, the hook token beside
  // the container-local hook socket. Neither is in the profile any more.
  mkdirSync(join(tmpRoot, "run"), { recursive: true });
  mkdirSync(join(tmpRoot, "hooks"), { recursive: true });
  sandboxTokenFile = join(tmpRoot, "run", "sandbox.token");
  hookTokenFile = join(tmpRoot, "hooks", "hook.token");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

/** Permission bits only, as an octal string ("640"). */
function mode(path: string): string {
  return (statSync(path).mode & 0o777).toString(8);
}

describe("token minting", () => {
  it("mints a 64-hex-char sandbox token and persists it 0640", async () => {
    const { sandboxToken } = await import("./auth");
    const t = sandboxToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(sandboxTokenFile)).toBe("640");
  });

  it("mints a hook token and persists it 0640 — NOT world-readable", async () => {
    // Regression guard: this was 0644. Any process in the container could read
    // the credential for /ingest, /permission-ask and /permission-wait.
    const { hookToken } = await import("./auth");
    const t = hookToken();
    expect(t).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(hookTokenFile)).toBe("640");
  });

  it("issues two DIFFERENT tokens, and one never satisfies the other", async () => {
    const { sandboxToken, hookToken, sandboxTokenMatches, hookTokenMatches } = await import("./auth");
    expect(sandboxToken()).not.toBe(hookToken());
    // The whole point of the split: a leaked hook token must not reach the
    // control plane.
    expect(sandboxTokenMatches(hookToken())).toBe(false);
    expect(hookTokenMatches(sandboxToken())).toBe(false);
  });

  it("reuses a persisted token across restarts", async () => {
    const first = (await import("./auth")).sandboxToken();
    vi.resetModules();
    expect((await import("./auth")).sandboxToken()).toBe(first);
  });

  it("replaces a truncated/corrupt token file instead of trusting it", async () => {
    // A short file would otherwise become a short, guessable secret.
    const file = sandboxTokenFile;
    mkdirSync(join(tmpRoot, "run"), { recursive: true });
    writeFileSync(file, "deadbeef");
    const t = (await import("./auth")).sandboxToken();
    expect(t).not.toBe("deadbeef");
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("token comparison", () => {
  it("accepts the real token and rejects everything else", async () => {
    const { sandboxToken, sandboxTokenMatches } = await import("./auth");
    const real = sandboxToken();

    expect(sandboxTokenMatches(real)).toBe(true);
    expect(sandboxTokenMatches(null)).toBe(false);
    expect(sandboxTokenMatches(undefined)).toBe(false);
    expect(sandboxTokenMatches("")).toBe(false);
    expect(sandboxTokenMatches(real.slice(0, -1))).toBe(false); // truncated
    expect(sandboxTokenMatches(real + "0")).toBe(false); // extended

    // Flip a character to something it definitely isn't — picking a fixed
    // letter would silently pass whenever the random token already had it
    // there, which is a 1-in-16 flake per assertion.
    const flip = (c: string) => (c === "0" ? "1" : "0");
    expect(sandboxTokenMatches(real.slice(0, -1) + flip(real.at(-1)!))).toBe(false); // last char
    expect(sandboxTokenMatches(flip(real[0]) + real.slice(1))).toBe(false); // first char
  });

  it("does not throw on non-hex or multi-byte input", async () => {
    const { sandboxTokenMatches } = await import("./auth");
    expect(sandboxTokenMatches("🔑".repeat(16))).toBe(false);
    expect(() => sandboxTokenMatches("\0".repeat(64))).not.toThrow();
  });
});
