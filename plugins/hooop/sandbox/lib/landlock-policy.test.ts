import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// node:os is mocked so homedir() is deterministic and test-controlled — the
// "broad" profile's RO set includes `${homedir()}/.claude`, and we need to
// both create and NOT create that directory across tests without touching
// the real developer/CI home dir.
let fakeHome = "";
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

// @shared/logger is mocked so we can assert the "warn once per process"
// behavior of wrapWithLandlock's fallback path without depending on the
// real logger's stderr output (which is itself suppressed under VITEST).
const warnMock = vi.fn();
vi.mock("@shared/logger", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnMock(...args),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const ORIGINAL_ENV = { ...process.env };
let tmpRoot: string;

beforeEach(() => {
  // Fresh module instance per test: HOOOP_SANDBOX_EXEC and the "warned once"
  // flag are both captured at module-load time / in module-level state, so
  // each test needs its own import after setting env vars.
  vi.resetModules();
  warnMock.mockClear();

  // Canonicalize the temp root: the policy resolves every entry through
  // realpathSync.native, so on macOS an uncanonicalized mkdtemp path
  // (/var/folders/...) comes back as /private/var/folders/... and every
  // toContain(cwd) assertion below compares the wrong spelling of the same
  // directory. Linux has no /var symlink, which is why this only bites here.
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "landlock-policy-test-")));
  fakeHome = join(tmpRoot, "home");
  mkdirSync(fakeHome, { recursive: true });

  delete process.env.HOOOP_LANDLOCK_MODE;
  delete process.env.HOOOP_SANDBOX_EXEC;
  delete process.env.HOOOP_BASH_CONFINE;
  delete process.env.HOOOP_BASH_SHELL;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

function makeCwd(): string {
  return mkdtempSync(join(tmpRoot, "cwd-"));
}

/**
 * How the HOST spells a base OS dir after the policy has canonicalized it, or
 * null when it doesn't exist here at all.
 *
 * Needed because these assertions are about Linux paths but also run on a macOS
 * dev laptop: /etc is a symlink to /private/etc there, and /proc + /sys don't
 * exist. The policy resolves symlinks and drops missing optional entries, so
 * both are correct behaviour rather than something to assert around. CI runs on
 * ubuntu-latest, which is where the /proc and /sys expectations actually bite.
 */
function canon(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// landlockMode
// ---------------------------------------------------------------------------

describe("landlockMode", () => {
  it("defaults to enforce when unset", async () => {
    const { landlockMode } = await import("./landlock-policy");
    expect(landlockMode()).toBe("enforce");
  });

  it("is permissive only for the exact literal 'permissive'", async () => {
    process.env.HOOOP_LANDLOCK_MODE = "permissive";
    const { landlockMode } = await import("./landlock-policy");
    expect(landlockMode()).toBe("permissive");
  });

  it("treats any other value (typos, blank, etc.) as enforce", async () => {
    process.env.HOOOP_LANDLOCK_MODE = "Permissive"; // wrong case
    const { landlockMode } = await import("./landlock-policy");
    expect(landlockMode()).toBe("enforce");
  });
});

// ---------------------------------------------------------------------------
// landlockSpawnEnv
// ---------------------------------------------------------------------------

describe("landlockSpawnEnv", () => {
  it("tight profile: RW includes cwd, RO includes base OS dirs, excludes ~/.claude", async () => {
    // Create ~/.claude so this test proves tight EXCLUDES it deliberately
    // (profile logic), not just because the dir happens to be absent.
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const cwd = makeCwd();
    const env = landlockSpawnEnv("tight", cwd);

    const rw = env.HOOOP_LANDLOCK_RW.split(":");
    const ro = env.HOOOP_LANDLOCK_RO.split(":");

    expect(rw).toContain(cwd);
    expect(ro).toContain("/usr");
    expect(ro).toContain(canon("/etc"));
    expect(ro).not.toContain(join(fakeHome, ".claude"));
  });

  it("broad profile: RO includes ~/.claude (when present) plus the tight base", async () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const cwd = makeCwd();
    const env = landlockSpawnEnv("broad", cwd);
    const ro = env.HOOOP_LANDLOCK_RO.split(":");

    expect(ro).toContain(join(fakeHome, ".claude"));
    expect(ro).toContain("/usr");
    expect(ro).toContain(canon("/etc"));
  });

  it("broad profile omits ~/.claude from RO when the dir does not exist", async () => {
    // fakeHome exists but its .claude subdir is never created in this test.
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const cwd = makeCwd();
    const env = landlockSpawnEnv("broad", cwd);
    expect(env.HOOOP_LANDLOCK_RO.split(":")).not.toContain(join(fakeHome, ".claude"));
  });

  it("always keeps cwd in RW, even if it does not exist on disk", async () => {
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const cwd = join(tmpRoot, "does-not-exist-cwd");
    const env = landlockSpawnEnv("tight", cwd);
    expect(env.HOOOP_LANDLOCK_RW.split(":")).toContain(cwd);
  });

  it("de-dupes RW when cwd equals TMPDIR", async () => {
    const cwd = makeCwd();
    process.env.TMPDIR = cwd;
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("tight", cwd);
    const rw = env.HOOOP_LANDLOCK_RW.split(":");
    expect(rw.filter((p) => p === cwd)).toHaveLength(1);
    delete process.env.TMPDIR;
  });

  it("forwards the current landlock mode", async () => {
    process.env.HOOOP_LANDLOCK_MODE = "permissive";
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const cwd = makeCwd();
    expect(landlockSpawnEnv("tight", cwd).HOOOP_LANDLOCK_MODE).toBe("permissive");
  });

  it("dev profile: grants /dev RW so /dev/null is openable (the `git status` exit-128 bug)", async () => {
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const rw = landlockSpawnEnv("dev", makeCwd()).HOOOP_LANDLOCK_RW.split(":");
    // /dev/null is opened O_RDWR, so this must be in RW and not merely RO.
    expect(rw).toContain("/dev");
  });

  it("dev profile: RO adds the dev toolchain surface on top of the tight base", async () => {
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const ro = landlockSpawnEnv("dev", makeCwd()).HOOOP_LANDLOCK_RO.split(":");
    expect(ro).toContain("/usr");
    // /proc is needed for bash process substitution via /dev/fd. Neither it nor
    // /sys exists on macOS, where the policy correctly drops them.
    for (const p of ["/proc", "/sys"]) {
      const real = canon(p);
      if (real) expect(ro).toContain(real);
    }
  });

  it("dev profile: grants ~/.claude/shell-snapshots WITHOUT granting ~/.claude", async () => {
    // The narrow leaf grant is the whole point — Landlock rules don't require
    // ancestor permissions, so the credentials and hook token sitting beside
    // it in ~/.claude must stay unreachable.
    mkdirSync(join(fakeHome, ".claude", "shell-snapshots"), { recursive: true });
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("dev", makeCwd());
    const all = [...env.HOOOP_LANDLOCK_RW.split(":"), ...env.HOOOP_LANDLOCK_RO.split(":")];

    expect(all).toContain(join(fakeHome, ".claude", "shell-snapshots"));
    expect(all).not.toContain(join(fakeHome, ".claude"));
  });

  it("dev profile: withholds the paths that make the escalation possible", async () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".ssh"), { recursive: true });
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("dev", makeCwd());
    const all = [...env.HOOOP_LANDLOCK_RW.split(":"), ...env.HOOOP_LANDLOCK_RO.split(":")];

    expect(all).not.toContain(join(fakeHome, ".claude"));
    expect(all).not.toContain(join(fakeHome, ".ssh"));
    expect(all).not.toContain("/var/run/hooop");
  });

  it("resolves symlinked entries so the wrapper never sees one", async () => {
    // Two reasons this matters: the wrapper refuses to grant through a
    // symlink (it would grant the TARGET), and on merged-/usr distros /bin
    // and /lib are symlinks — unresolved, every spawn would warn.
    const real = join(tmpRoot, "real-cwd");
    mkdirSync(real, { recursive: true });
    const link = join(tmpRoot, "link-cwd");
    symlinkSync(real, link);

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const rw = landlockSpawnEnv("dev", link).HOOOP_LANDLOCK_RW.split(":");

    expect(rw).toContain(real);
    expect(rw).not.toContain(link);
  });

  it("throws rather than mis-granting when the cwd contains a ':'", async () => {
    // The allow-list is colon-separated, so "/a:b" would silently split into
    // "/a" and "b" — granting a DIFFERENT directory. Fail loudly instead.
    const weird = join(tmpRoot, "has:colon");
    mkdirSync(weird, { recursive: true });

    const { landlockSpawnEnv, LandlockPolicyError } = await import("./landlock-policy");
    expect(() => landlockSpawnEnv("dev", weird)).toThrow(LandlockPolicyError);
  });

  it("drops an OPTIONAL path containing a ':' instead of throwing", async () => {
    // Optional RO roots are a static superset; one weird path shouldn't take
    // the whole sandbox down. Only the required cwd is fatal.
    process.env.TMPDIR = join(tmpRoot, "tmp:dir");
    mkdirSync(process.env.TMPDIR, { recursive: true });

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const cwd = makeCwd();
    const rw = landlockSpawnEnv("dev", cwd).HOOOP_LANDLOCK_RW.split(":");

    expect(rw).toContain(cwd);
    expect(rw.some((p) => p.includes("tmp:dir"))).toBe(false);
    delete process.env.TMPDIR;
  });
});

// ---------------------------------------------------------------------------
// bashConfinementEnv — the model's own Bash tool
// ---------------------------------------------------------------------------

describe("bashConfinementEnv", () => {
  /** Both binaries present, as they are in the sandbox image. */
  function installHelpers(): { shim: string; exec: string } {
    const shim = join(tmpRoot, "hooop-bash");
    const exec = join(tmpRoot, "hooop-sandbox-exec");
    writeFileSync(shim, "#!/bin/sh\nexec /bin/bash \"$@\"\n", { mode: 0o755 });
    writeFileSync(exec, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    process.env.HOOOP_BASH_SHELL = shim;
    process.env.HOOOP_SANDBOX_EXEC = exec;
    return { shim, exec };
  }

  it("is off by default, so a local checkout is never confined by accident", async () => {
    installHelpers();
    const { bashConfinementEnv } = await import("./landlock-policy");
    expect(bashConfinementEnv(makeCwd())).toBeNull();
  });

  it("points CLAUDE_CODE_SHELL at the shim and ships the dev allow-list", async () => {
    const { shim } = installHelpers();
    process.env.HOOOP_BASH_CONFINE = "require";

    const { bashConfinementEnv } = await import("./landlock-policy");
    const cwd = makeCwd();
    const env = bashConfinementEnv(cwd)!;

    expect(env.CLAUDE_CODE_SHELL).toBe(shim);
    expect(env.HOOOP_LANDLOCK_RW.split(":")).toContain(cwd);
    // "dev", not "tight" — a Bash tool without /dev can't run git.
    expect(env.HOOOP_LANDLOCK_RW.split(":")).toContain("/dev");
  });

  it("refuses to start rather than run unconfined when the shim is missing", async () => {
    installHelpers();
    process.env.HOOOP_BASH_CONFINE = "require";
    process.env.HOOOP_BASH_SHELL = join(tmpRoot, "absent-shim");

    const { bashConfinementEnv, LandlockPolicyError } = await import("./landlock-policy");
    // The critical property: NOT a silent null. claude's own CLAUDE_CODE_SHELL
    // resolver falls back to shell auto-detection when the override doesn't
    // resolve, so returning null here would produce an unconfined session that
    // looks identical to a confined one.
    expect(() => bashConfinementEnv(makeCwd())).toThrow(LandlockPolicyError);
  });

  it("refuses to start when the landlock wrapper is missing", async () => {
    installHelpers();
    process.env.HOOOP_BASH_CONFINE = "require";
    process.env.HOOOP_SANDBOX_EXEC = join(tmpRoot, "absent-exec");

    const { bashConfinementEnv, LandlockPolicyError } = await import("./landlock-policy");
    expect(() => bashConfinementEnv(makeCwd())).toThrow(LandlockPolicyError);
  });

  it("refuses to start when the cwd cannot be expressed in the allow-list", async () => {
    installHelpers();
    process.env.HOOOP_BASH_CONFINE = "require";
    const weird = join(tmpRoot, "cwd:with:colons");
    mkdirSync(weird, { recursive: true });

    const { bashConfinementEnv, LandlockPolicyError } = await import("./landlock-policy");
    expect(() => bashConfinementEnv(weird)).toThrow(LandlockPolicyError);
  });
});

// ---------------------------------------------------------------------------
// wrapWithLandlock
// ---------------------------------------------------------------------------

describe("wrapWithLandlock", () => {
  it("falls back to the raw cmd/args when the helper binary is absent", async () => {
    process.env.HOOOP_SANDBOX_EXEC = join(tmpRoot, "no-such-binary");
    const { wrapWithLandlock } = await import("./landlock-policy");
    const cwd = makeCwd();

    const result = wrapWithLandlock("tight", cwd, "claude", ["--foo", "bar"]);

    expect(result).toEqual({ file: "claude", args: ["--foo", "bar"], env: {} });
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("warns only once per process across repeated fallback calls", async () => {
    process.env.HOOOP_SANDBOX_EXEC = join(tmpRoot, "no-such-binary");
    const { wrapWithLandlock } = await import("./landlock-policy");
    const cwd = makeCwd();

    wrapWithLandlock("tight", cwd, "claude", []);
    wrapWithLandlock("tight", cwd, "claude", []);
    wrapWithLandlock("broad", cwd, "claude", []);

    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it("wraps through the helper (file/args/env) when it exists", async () => {
    const helperPath = join(tmpRoot, "hooop-sandbox-exec");
    writeFileSync(helperPath, "#!/bin/sh\nexec \"$@\"\n", { mode: 0o755 });
    process.env.HOOOP_SANDBOX_EXEC = helperPath;

    const { wrapWithLandlock, HOOOP_SANDBOX_EXEC } = await import("./landlock-policy");
    expect(HOOOP_SANDBOX_EXEC).toBe(helperPath);

    const cwd = makeCwd();
    const result = wrapWithLandlock("tight", cwd, "claude", ["--foo"]);

    expect(result.file).toBe(helperPath);
    expect(result.args).toEqual(["claude", "--foo"]);
    expect(result.env.HOOOP_LANDLOCK_RW.split(":")).toContain(cwd);
    expect(warnMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// dev profile: PATH-shadowing escape (adversarial-review regression)
// ---------------------------------------------------------------------------

describe("dev profile does not hand back an escape via PATH", () => {
  it("keeps ~/.local read-only while granting the off-PATH subdirs it needs", async () => {
    // ~/.local/bin leads claude's PATH, and the PreToolUse hooks run
    // UNCONFINED (the gate must read a token this profile denies). Granting
    // ~/.local RW let a confined shell plant ~/.local/bin/grep and get
    // unconfined execution on the next tool call — demonstrated end-to-end,
    // exfiltrating the very hook token the shell had just been refused.
    mkdirSync(join(fakeHome, ".local", "share"), { recursive: true });
    mkdirSync(join(fakeHome, ".npm"), { recursive: true });

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("dev", makeCwd());
    const rw = env.HOOOP_LANDLOCK_RW.split(":");
    const ro = env.HOOOP_LANDLOCK_RO.split(":");

    expect(rw).not.toContain(join(fakeHome, ".local"));
    expect(ro).toContain(join(fakeHome, ".local"));
    // …but the off-PATH subdirs tools actually need stay writable (Landlock
    // applies the most specific rule, so these win over the RO parent).
    expect(rw).toContain(join(fakeHome, ".local", "share"));
    expect(rw).toContain(join(fakeHome, ".npm"));
  });
});

// ---------------------------------------------------------------------------
// preview profile (the preview runner's container)
// ---------------------------------------------------------------------------

describe("preview profile", () => {
  it("grants the whole HOME read-write, unlike dev", async () => {
    // The inverse of the dev-profile test above, and deliberately so. In the
    // runner there is no unconfined hook reading that PATH — every process in
    // the container goes through this same wrapper into the same Landlock
    // domain — so installing a toolchain into HOME is the feature, not an
    // escape. See previewRwRoots() for the full argument.
    mkdirSync(join(fakeHome, ".local", "bin"), { recursive: true });

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("preview", makeCwd());
    const rw = env.HOOOP_LANDLOCK_RW.split(":");

    expect(rw).toContain(fakeHome);
    // ~/.local/bin is covered by the HOME grant rather than listed separately.
    expect(rw).not.toContain(join(fakeHome, ".local"));
  });

  it("keeps the session cwd writable and never grants a sibling workdir", async () => {
    // The boundary the runner actually defends: one preview must not be able
    // to read another session's files, even though the whole workspace is
    // bind-mounted into the container.
    const sessionsRoot = join(tmpRoot, "workspace", "sessions");
    const mine = join(sessionsRoot, "session-a");
    const theirs = join(sessionsRoot, "session-b");
    mkdirSync(mine, { recursive: true });
    mkdirSync(theirs, { recursive: true });

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("preview", mine);
    const rw = env.HOOOP_LANDLOCK_RW.split(":");
    const ro = env.HOOOP_LANDLOCK_RO.split(":");

    expect(rw).toContain(mine);
    expect(rw).not.toContain(theirs);
    expect(ro).not.toContain(theirs);
    expect(rw).not.toContain(sessionsRoot);
    expect(ro).not.toContain(sessionsRoot);
  });

  it("grants /dev read-write so git and shell redirection work", async () => {
    // Same lesson as the dev profile: /dev/null is opened O_RDWR, and omitting
    // it makes every `git` invocation exit 128.
    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("preview", makeCwd());
    const rw = env.HOOOP_LANDLOCK_RW.split(":");

    const dev = canon("/dev");
    if (dev) expect(rw).toContain(dev);
  });

  it("does not grant ~/.claude, which the runner never mounts", async () => {
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });

    const { landlockSpawnEnv } = await import("./landlock-policy");
    const env = landlockSpawnEnv("preview", makeCwd());
    const ro = env.HOOOP_LANDLOCK_RO.split(":");

    // Not in the RO set the way "broad" lists it. (It IS under the HOME RW
    // grant, but the runner container has no ~/.claude to reach — this asserts
    // we didn't copy the claude-specific entries across from another profile.)
    expect(ro).not.toContain(join(fakeHome, ".claude"));
  });
});
