/**
 * Integration tests for the Landlock exec wrapper itself
 * (../landlock/hooop-sandbox-exec.c).
 *
 * Everything in landlock-policy.test.ts is about the TypeScript that COMPUTES
 * the allow-lists. Nothing there proves the C actually confines anything — and
 * for a long time nothing did: CI never compiled this file, so the only
 * feedback on a C-level regression was an image build (or a security
 * incident). These tests close that gap by compiling the wrapper with the
 * same flags the Dockerfile uses and asserting real kernel behaviour.
 *
 * Gated to Linux hosts that have a compiler and a working Landlock LSM, since
 * none of that exists on a macOS dev laptop. The gate is a real end-to-end
 * probe rather than a kernel-version check: Landlock can be compiled out or
 * disabled at boot, and the wrapper's own exit code is the honest signal.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "landlock", "hooop-sandbox-exec.c");

let root = "";
let helper = "";
let compileError: string | null = null;

/** Base RO set: enough to exec a shell and the coreutils it needs. */
const BASE_RO = ["/usr", "/etc"];

function run(
  rw: string[],
  ro: string[],
  argv: string[],
  opts: { mode?: "enforce" | "permissive"; env?: Record<string, string> } = {},
) {
  return spawnSync(helper, argv, {
    encoding: "utf-8",
    env: {
      ...process.env,
      ...opts.env,
      HOOOP_LANDLOCK_RW: rw.join(":"),
      HOOOP_LANDLOCK_RO: ro.join(":"),
      HOOOP_LANDLOCK_MODE: opts.mode ?? "enforce",
    },
  });
}

// Compile at MODULE scope, not in beforeAll: `describe.skipIf(!usable())` is
// evaluated during collection, which happens before any hook runs. Doing this
// in beforeAll would leave `helper` empty at gate time and silently skip the
// entire suite. spawnSync makes that straightforward.
if (process.platform === "linux") {
  root = mkdtempSync(join(tmpdir(), "landlock-enforce-"));
  helper = join(root, "hooop-sandbox-exec");

  // Same flags as sandbox/Dockerfile so a warning here is a warning there.
  const cc = spawnSync("cc", ["-O2", "-Wall", "-o", helper, SOURCE], { encoding: "utf-8" });
  if (cc.status !== 0) compileError = cc.stderr || `cc exited ${cc.status}`;
  // Compiling clean is itself an assertion: this file is security-critical and
  // builds with -Wall in the image.
  else if (cc.stderr.trim()) compileError = `cc emitted warnings:\n${cc.stderr}`;
}

/** True when we compiled AND the kernel actually enforces Landlock. */
function usable(): boolean {
  if (process.platform !== "linux" || !helper || compileError) return false;
  // A real end-to-end probe, not a kernel-version check: Landlock can be
  // compiled out or disabled at boot, and in enforce mode the wrapper's own
  // exit code is the honest signal.
  return run([], BASE_RO, ["/bin/true"]).status === 0;
}

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "linux")("hooop-sandbox-exec (compiled)", () => {
  it("compiles clean with the Dockerfile's flags", () => {
    expect(compileError).toBeNull();
  });

  describe.skipIf(!usable())("enforcement", () => {
    let work = "";
    let outside = "";

    beforeAll(() => {
      work = join(root, "work");
      outside = join(root, "outside");
      mkdirSync(work, { recursive: true });
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(work, "mine.txt"), "mine\n");
      writeFileSync(join(outside, "secret.txt"), "SECRET\n");
    });

    it("allows reads inside the RW root and denies them outside", () => {
      expect(run([work], BASE_RO, ["/bin/cat", join(work, "mine.txt")]).stdout).toBe("mine\n");

      const denied = run([work], BASE_RO, ["/bin/cat", join(outside, "secret.txt")]);
      expect(denied.stdout).not.toContain("SECRET");
      expect(denied.stderr).toContain("Permission denied");
    });

    it("refuses to grant through a symlinked RW entry, and fails closed", () => {
      // The escape: the session workdir is writable by the model's own
      // unconfined process, so `rmdir <cwd> && ln -s / <cwd>` would otherwise
      // turn the next spawn's RW grant into "/".
      const link = join(root, "rw-link");
      symlinkSync("/", link);

      const r = run([link], BASE_RO, ["/bin/cat", join(outside, "secret.txt")]);
      expect(r.status).toBe(126);
      expect(r.stderr).toContain("is a symlink");
      expect(r.stdout).not.toContain("SECRET");
    });

    it("tolerates a symlinked RO entry (merged-/usr ships /bin -> /usr/bin)", () => {
      const link = join(root, "ro-link");
      symlinkSync("/usr", link);
      // Warns, skips the entry, but still runs — /usr is granted in its own
      // right, and Landlock evaluates the resolved path.
      const r = run([work], [...BASE_RO, link], ["/bin/echo", "ok"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("ok\n");
    });

    it("skips a non-absolute entry instead of resolving it against cwd", () => {
      const r = run([work], [...BASE_RO, "relative-dir"], ["/bin/true"]);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("non-absolute");
    });

    it("installs a rule for a NON-DIRECTORY path (/dev/null needs RW)", () => {
      // Directory-only rights on a non-dir make the kernel reject the whole
      // rule with EINVAL, so this only works if the wrapper masks down to the
      // file-granular set.
      const r = run([work, "/dev/null"], BASE_RO, ["/bin/sh", "-c", "echo x > /dev/null && echo wrote"]);
      expect(r.stderr).not.toContain("landlock_add_rule failed");
      expect(r.stdout).toBe("wrote\n");
    });

    it("lets `git status` succeed under a dev-shaped profile", () => {
      // Regression test for the exit-128 bug: without /dev, /dev/null is
      // unopenable and git dies with "could not open '/dev/null'". Without a
      // readable ~/.gitconfig it dies with "unknown error occurred while
      // reading the configuration files" — an unreadable config is fatal to
      // git, where a missing one is fine.
      const repo = join(work, "repo");
      mkdirSync(repo, { recursive: true });
      expect(spawnSync("git", ["init", "-q", repo]).status).toBe(0);

      const home = join(root, "home");
      mkdirSync(home, { recursive: true });
      writeFileSync(join(home, ".gitconfig"), "[user]\n\tname = Test\n");

      const r = run(
        [work, "/dev"],
        [...BASE_RO, join(home, ".gitconfig")],
        ["git", "-C", repo, "status", "--porcelain"],
        { env: { HOME: home } },
      );
      expect(r.stderr).not.toContain("Permission denied");
      expect(r.status).toBe(0);
    });

    it("keeps the escalation credentials unreachable", () => {
      // The concrete thing this whole layer exists to prevent: reading the
      // sandbox/hook tokens, which grant control-plane authority.
      const fakeClaude = join(root, "home2", ".claude", "hooop");
      mkdirSync(fakeClaude, { recursive: true });
      writeFileSync(join(fakeClaude, "hook.token"), "tok\n");

      const r = run([work], BASE_RO, ["/bin/cat", join(fakeClaude, "hook.token")]);
      expect(r.stdout).not.toContain("tok");
      expect(r.stderr).toContain("Permission denied");
    });

    it("fails closed (126) rather than running unconfined when a rule can't be added", () => {
      // An RW entry that exists but is a symlink is the reachable case; the
      // point of the assertion is the EXIT CODE — enforce mode must never
      // fall through to execvp.
      const link = join(root, "rw-link-2");
      symlinkSync(outside, link);
      expect(run([link], BASE_RO, ["/bin/true"]).status).toBe(126);
    });

    it("permissive mode downgrades the same failure to a warning", () => {
      const link = join(root, "rw-link-3");
      symlinkSync(outside, link);
      const r = run([link], BASE_RO, ["/bin/true"], { mode: "permissive" });
      expect(r.status).toBe(0);
      expect(r.stderr).toContain("warning");
    });
  });
});
