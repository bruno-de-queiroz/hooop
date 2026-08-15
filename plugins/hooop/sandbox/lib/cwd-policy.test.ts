import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmdirSync, symlinkSync, mkdirSync, rmSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAllowedCwd,
  isCwdAllowed,
  canonicalize,
  isPathWithinCwd,
  sessionScratchDir,
  ensureSessionScratch,
} from "./cwd-policy";

const originalEnv = process.env.HOOOP_CWD_ROOTS;

// Temp directories created per-test for symlink / realpath tests.
let tmpRoot: string | null = null;

beforeEach(() => {
  delete process.env.HOOOP_CWD_ROOTS;
  tmpRoot = null;
});
afterEach(() => {
  if (originalEnv === undefined) delete process.env.HOOOP_CWD_ROOTS;
  else process.env.HOOOP_CWD_ROOTS = originalEnv;

  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    tmpRoot = null;
  }
});

function makeTmpRoot(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "cwd-policy-test-"));
  return tmpRoot;
}

// ---------------------------------------------------------------------------
// isAllowedCwd — always-denied prefixes
// ---------------------------------------------------------------------------

describe("isAllowedCwd — always-denied prefixes", () => {
  it("rejects /etc, /proc, /dev, /sys, /boot, /var/run, /var/lib/secrets", () => {
    for (const p of ["/etc", "/proc", "/dev", "/sys", "/boot", "/var/run", "/var/lib/secrets"]) {
      expect(isAllowedCwd(p).ok, p).toBe(false);
      expect(isAllowedCwd(p + "/something").ok, p + "/something").toBe(false);
    }
  });

  it("rejects '..' path-traversal segments", () => {
    expect(isAllowedCwd("/workspace/../etc").ok).toBe(false);
    expect(isAllowedCwd("../etc").ok).toBe(false);
  });

  it("rejects null bytes", () => {
    expect(isAllowedCwd("/workspace\0/evil").ok).toBe(false);
  });

  it("rejects empty / non-string inputs", () => {
    expect(isAllowedCwd("").ok).toBe(false);
    expect(isAllowedCwd(null as any).ok).toBe(false);
    expect(isAllowedCwd(undefined as any).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isAllowedCwd — env-driven allowlist (using real temp dirs)
// ---------------------------------------------------------------------------

describe("isAllowedCwd — env-driven allowlist", () => {
  it("allows when path is exactly an allowed root (real dir)", () => {
    const root = makeTmpRoot();
    process.env.HOOOP_CWD_ROOTS = root;
    expect(isAllowedCwd(root).ok).toBe(true);
  });

  it("allows when path is under an allowed root (real dir)", () => {
    const root = makeTmpRoot();
    const sub = join(root, "projects", "foo");
    mkdirSync(sub, { recursive: true });
    process.env.HOOOP_CWD_ROOTS = root;
    expect(isAllowedCwd(sub).ok).toBe(true);
  });

  it("rejects when path is outside the allowlist", () => {
    const root = makeTmpRoot();
    process.env.HOOOP_CWD_ROOTS = root;
    expect(isAllowedCwd("/home/user").ok).toBe(false);
    expect(isAllowedCwd("/root").ok).toBe(false);
  });

  it("accepts multiple comma-separated roots (real dirs)", () => {
    const root1 = makeTmpRoot();
    const root2 = mkdtempSync(join(tmpdir(), "cwd-policy-test-b-"));
    const subA = join(root1, "x");
    const subB = join(root2, "y");
    mkdirSync(subA);
    mkdirSync(subB);
    process.env.HOOOP_CWD_ROOTS = `${root1}, ${root2}`;
    expect(isAllowedCwd(subA).ok).toBe(true);
    expect(isAllowedCwd(subB).ok).toBe(true);
    expect(isAllowedCwd("/elsewhere").ok).toBe(false);
    rmSync(root2, { recursive: true, force: true });
  });

  it("ignores trailing slashes in env roots (real dir)", () => {
    const root = makeTmpRoot();
    const sub = join(root, "x");
    mkdirSync(sub);
    process.env.HOOOP_CWD_ROOTS = root + "//";
    expect(isAllowedCwd(sub).ok).toBe(true);
  });

  it("does not allow a prefix-match cheat (root must not match a sibling with a longer name)", () => {
    const base = makeTmpRoot();
    const root = join(base, "workspace");
    const evil = join(base, "workspaces", "evil");
    mkdirSync(root);
    mkdirSync(evil, { recursive: true });
    process.env.HOOOP_CWD_ROOTS = root;
    expect(isAllowedCwd(evil).ok).toBe(false);
  });

  it("warns and skips a configured root that does not exist", () => {
    const root = makeTmpRoot();
    const sub = join(root, "x");
    mkdirSync(sub);
    process.env.HOOOP_CWD_ROOTS = root + ",/does-not-exist-cwd-policy-test";
    // Should still match via the real root.
    expect(isAllowedCwd(sub).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isAllowedCwd — no env restriction set
// ---------------------------------------------------------------------------

describe("isAllowedCwd — no env restriction set", () => {
  it("allows paths that are NOT in the always-denied list", () => {
    expect(isAllowedCwd("/workspace/anything").ok).toBe(true);
    expect(isAllowedCwd("/home/user").ok).toBe(true);
    expect(isAllowedCwd("/tmp/foo").ok).toBe(true);
  });

  it("still rejects always-denied prefixes even without env", () => {
    expect(isAllowedCwd("/etc/anything").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isCwdAllowed — symlink tests (new security tests)
// ---------------------------------------------------------------------------

describe("isCwdAllowed — symlink and canonicalization security", () => {
  it("rejects a symlink inside an allowed root pointing OUTSIDE it", () => {
    const root = makeTmpRoot();
    const outside = mkdtempSync(join(tmpdir(), "cwd-policy-outside-"));
    const link = join(root, "escape");
    symlinkSync(outside, link);
    process.env.HOOOP_CWD_ROOTS = root;

    const result = isCwdAllowed(link);
    expect(result.ok).toBe(false);
    expect((result as any).reason).toMatch(/not under any allowed root/);

    rmSync(outside, { recursive: true, force: true });
  });

  it("accepts a symlink inside an allowed root pointing to ANOTHER allowed root", () => {
    const root1 = makeTmpRoot();
    const root2 = mkdtempSync(join(tmpdir(), "cwd-policy-root2-"));
    const link = join(root1, "link-to-root2");
    symlinkSync(root2, link);
    process.env.HOOOP_CWD_ROOTS = `${root1},${root2}`;

    const result = isCwdAllowed(link);
    expect(result.ok).toBe(true);

    rmSync(root2, { recursive: true, force: true });
  });

  it("rejects a path with /../ that resolves to outside all allowed roots", () => {
    const root = makeTmpRoot();
    const sub = join(root, "sub");
    mkdirSync(sub);
    // A path like /tmp/cwd-policy-test-XXX/sub/../../.. could escape tmpdir
    // We test that a non-.. path that canonicalizes to outside root is rejected.
    const outside = mkdtempSync(join(tmpdir(), "cwd-policy-outside2-"));
    const link = join(sub, "escape");
    symlinkSync(outside, link);
    process.env.HOOOP_CWD_ROOTS = root;

    const result = isCwdAllowed(link);
    expect(result.ok).toBe(false);

    rmSync(outside, { recursive: true, force: true });
  });

  it("rejects a non-existent path", () => {
    const root = makeTmpRoot();
    process.env.HOOOP_CWD_ROOTS = root;

    const result = isCwdAllowed(join(root, "does-not-exist"));
    expect(result.ok).toBe(false);
    expect((result as any).reason).toMatch(/does not exist|cannot be resolved/);
  });

  it("accepts a real existing path under an allowed root (sanity check)", () => {
    const root = makeTmpRoot();
    const sub = join(root, "myproject");
    mkdirSync(sub);
    process.env.HOOOP_CWD_ROOTS = root;

    const result = isCwdAllowed(sub);
    expect(result.ok).toBe(true);
    expect((result as any).canonical).toBe(canonicalize(sub));
  });

  it("rejects a path that resolves into an always-denied prefix via symlink", () => {
    // Create a symlink that points at /etc (or /private/etc on macOS).
    const root = makeTmpRoot();
    const link = join(root, "etc-link");
    // Only run this if /etc exists (it does on Linux/macOS).
    let etcExists = false;
    try { canonicalize("/etc"); etcExists = true; } catch { /* skip */ }
    if (!etcExists) return;

    symlinkSync("/etc", link);
    process.env.HOOOP_CWD_ROOTS = root;

    const result = isCwdAllowed(link);
    expect(result.ok).toBe(false);
    expect((result as any).reason).toMatch(/not allowed/);
  });
});

describe("a scratch dir someone else planted", () => {
  // /tmp is world-writable and every session in an install shares one container
  // under one uid, so a session's blessed scratch path is a path OTHER sessions can
  // write. These use real symlinks on disk rather than mocks, because the whole
  // question is what the filesystem does.
  const ids: string[] = [];
  const freshId = (n: string) => {
    // A plain-looking session id (sessionScratchDir rejects anything else) that no
    // real session will collide with.
    const id = `aaaaaaaa-test-${n}-0000-000000000000`;
    ids.push(id);
    return id;
  };

  afterEach(() => {
    for (const id of ids.splice(0)) {
      try { rmSync(sessionScratchDir(id)!, { recursive: true, force: true }); } catch { /* gone */ }
    }
  });

  it("does not count a symlink at the scratch path as inside it", () => {
    // The attack: plant `ln -s /home/agent/.claude/projects /tmp/hooop-session/<victim>`
    // before the victim first uses its scratch. Without the lstat check the victim's
    // reads "inside its own scratch" resolve into another session's transcripts and
    // are auto-approved, because we told the gate that directory was contained.
    const id = freshId("symlk");
    const scratch = sessionScratchDir(id)!;
    const elsewhere = mkdtempSync(join(tmpdir(), "hooop-elsewhere-"));
    mkdirSync(join(scratch, ".."), { recursive: true });
    symlinkSync(elsewhere, scratch);

    expect(isPathWithinCwd("/workspace/s", `${scratch}/loot.txt`, scratch)).toBe(false);
    // Reached by its real name it is simply outside, as any other path would be.
    expect(isPathWithinCwd("/workspace/s", `${elsewhere}/loot.txt`, scratch)).toBe(false);
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("counts a real directory at the scratch path as inside it", () => {
    const id = freshId("realdi");
    const scratch = ensureSessionScratch(id);
    expect(scratch).toBe(sessionScratchDir(id));
    expect(isPathWithinCwd("/workspace/s", `${scratch}/shot.png`, scratch!)).toBe(true);
  });

  it("still blesses a scratch dir that does not exist yet", () => {
    // The first write into a fresh scratch dir, before anything created it.
    const scratch = sessionScratchDir(freshId("absent"))!;
    expect(isPathWithinCwd("/workspace/s", `${scratch}/first.txt`, scratch)).toBe(true);
  });

  it("grants no scratch allowance at all when the path is poisoned", () => {
    // ensureSessionScratch returning null is what keeps the system prompt from
    // steering the agent at a directory that is not its own.
    const id = freshId("poisn");
    const scratch = sessionScratchDir(id)!;
    const elsewhere = mkdtempSync(join(tmpdir(), "hooop-elsewhere-"));
    mkdirSync(join(scratch, ".."), { recursive: true });
    symlinkSync(elsewhere, scratch);

    expect(ensureSessionScratch(id)).toBeNull();
    rmSync(elsewhere, { recursive: true, force: true });
  });

  it("leaves the leaf to the session and makes the parent writable by it", () => {
    // This process runs as the server user; a session's claude runs as `agent`.
    // Caught live: creating the leaf here as 0700 left the parent hooopd-owned and
    // 0700, and the session got `mkdir: Permission denied` on its own scratch dir.
    const id = freshId("parent");
    const dir = ensureSessionScratch(id)!;
    expect(dir).toBe(sessionScratchDir(id));
    // The parent is prepared, writable + sticky like /tmp, so any session uid can
    // create its own leaf and only its owner can remove it.
    const parentMode = statSync(join(dir, "..")).mode;
    expect(parentMode & 0o777).toBe(0o777);
    expect(parentMode & 0o1000).toBe(0o1000); // sticky
    // The leaf itself is NOT created here.
    expect(existsSync(dir)).toBe(false);
  });
});
