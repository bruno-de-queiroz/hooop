import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmdirSync, symlinkSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isAllowedCwd, isCwdAllowed, canonicalize } from "./cwd-policy";

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
