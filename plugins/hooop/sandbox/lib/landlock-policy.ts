/**
 * Landlock filesystem-confinement policy for sandbox-spawned processes
 * (e.g. `claude`). This module does NOT apply Landlock itself — Landlock is
 * an OS-level LSM whose only entry points (landlock_create_ruleset(2),
 * landlock_add_rule(2), landlock_restrict_self(2)) restrict the CALLING
 * process, so the restriction has to happen inside the child before it
 * execs the real target. That's what `hooop-sandbox-exec` (see
 * ../landlock/hooop-sandbox-exec.c, compiled into the image at
 * HOOOP_SANDBOX_EXEC) is for.
 *
 * This module owns the two things that belong in TypeScript instead of C:
 *   - computing the RW/RO path allow-lists for a given profile + cwd
 *     (`landlockSpawnEnv`), since that logic wants Node's `os`/`fs`, not a
 *     C rewrite of path-existence checks; and
 *   - rewriting a `spawn(cmd, args, opts)` call into one that runs through
 *     the wrapper (`wrapWithLandlock`), with a safe unwrapped fallback for
 *     dev/test/non-Linux environments where the helper binary isn't baked
 *     into the image.
 *
 * Profiles:
 *   "tight" — RO limited to base OS dirs (/usr, /bin, /etc, ...). Suitable
 *             for a plain shell/tool invocation that only needs the system
 *             toolchain plus its own cwd.
 *   "broad" — tight's RO set, plus the claude config/cache dirs and the
 *             baked-in hooop/bun/node-modules trees. This is what the
 *             `claude` child process itself needs to read (skills, plugin
 *             manifests, its own installed CLI, etc).
 *   "dev"   — what a real development shell needs: tight's RO set plus
 *             /opt, /app, /proc, /sys, ~/.config and ~/.gitconfig, and RW on
 *             /dev, ~/.cache, ~/.local and ~/.claude/shell-snapshots on top
 *             of the cwd. "tight" is NOT survivable for a dev shell — see
 *             devRwRoots() for the two things that surprised us.
 *   "preview" — the preview runner's profile (a separate container; see
 *             preview-runner/). Like "dev", but the whole of ~ is writable
 *             because a preview's setup steps legitimately install toolchains
 *             (mise, uv, pip --user, corepack). See previewRwRoots() for why
 *             that is safe THERE and not in "dev".
 *
 * Every profile gets the session's cwd plus a temp dir as RW; Landlock
 * intentionally never grants write access outside a profile's RW set.
 *
 * CANONICALIZATION. Every path is resolved via realpath before it reaches
 * the wrapper. Two reasons, both load-bearing:
 *   - The wrapper refuses to grant through a symlink (Landlock attaches a
 *     rule to the inode behind the fd, so following one would grant the
 *     TARGET — that's the `rmdir <cwd> && ln -s / <cwd>` escape). Resolving
 *     here means the wrapper only ever sees real directories.
 *   - On a merged-/usr distro (Debian, and so this image) /bin, /sbin, /lib
 *     and /lib64 are symlinks into /usr. Without resolving, every single
 *     spawn would emit a warning per entry onto the user's stderr.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { log } from "@shared/logger";
import { canonicalize } from "./cwd-policy";

export type LandlockProfile = "tight" | "broad" | "dev" | "preview";

/**
 * Thrown when a path cannot be safely expressed in the wrapper's env-var
 * protocol. Callers should fail the spawn rather than continue unconfined —
 * that's the whole point of raising instead of filtering.
 */
export class LandlockPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LandlockPolicyError";
  }
}

/**
 * HOOOP_LANDLOCK_RW / _RO are colon-separated, so a path containing a colon
 * cannot be expressed. Splitting one would silently grant a DIFFERENT
 * directory (a cwd of "/srv/a:b" grants "/srv/a"), so such paths are
 * rejected rather than passed through. Newline is rejected on the same
 * principle — nothing good comes of it in an env var.
 */
const UNSAFE_IN_PATH_LIST = /[:\n]/;

/**
 * Path to the compiled Landlock exec wrapper baked into the sandbox image
 * (see sandbox/Dockerfile). Overridable for tests / alternate layouts.
 */
export const HOOOP_SANDBOX_EXEC = process.env.HOOOP_SANDBOX_EXEC || "/usr/local/bin/hooop-sandbox-exec";

/**
 * Enforcement mode forwarded to the wrapper via HOOOP_LANDLOCK_MODE.
 * Anything other than the literal string "permissive" is treated as
 * "enforce" — fail-closed by default, matching the C wrapper's own default.
 */
export function landlockMode(): "enforce" | "permissive" {
  return process.env.HOOOP_LANDLOCK_MODE === "permissive" ? "permissive" : "enforce";
}

// Read-only roots common to every profile: the base OS install. Without
// these, exec'ing `claude` (or any shell it spawns) can't even resolve the
// dynamic linker or read /etc/passwd-style files it stats at startup.
const TIGHT_RO_ROOTS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

// Additional read-only roots the "broad" profile grants on top of
// TIGHT_RO_ROOTS: claude's own config/cache, the baked-in hooop plugin
// surface, bun, the app bundle, and the globally-installed node CLIs
// (claude-code itself lives under /usr/local/lib/node_modules).
function broadExtraRoRoots(): string[] {
  const home = homedir();
  return [
    `${home}/.claude`,
    "/opt/hooop",
    "/opt/bun",
    "/app",
    `${home}/.config`,
    `${home}/.cache`,
    "/usr/local/lib/node_modules",
    "/usr/local/bin",
  ];
}

/**
 * Extra READ-ONLY roots for "dev" on top of TIGHT_RO_ROOTS.
 *
 * `~/.gitconfig` is a FILE, not a directory, and it is not optional: git
 * treats a config file that exists but can't be read as a hard error
 * ("fatal: unknown error occurred while reading the configuration files"),
 * not as a missing file. Granting it depends on the wrapper masking
 * directory-only rights off non-directory rules — see HOOOP_LANDLOCK_ACCESS_FILE
 * in hooop-sandbox-exec.c.
 *
 * `/proc` is needed because bash process substitution (`<(cmd)`) goes through
 * /dev/fd → /proc/self/fd, and node/git/python stat it constantly.
 *
 * Granting it does NOT leak other processes' secrets, which is worth stating
 * because it looks like it should: reading /proc/<pid>/environ, /mem, /cwd,
 * /root or /fd/* of another process goes through PTRACE_MODE_READ, and
 * Landlock installs a ptrace_access_check hook that denies a confined process
 * from ptracing anything outside its own domain. Verified on this kernel — a
 * same-uid victim's environ reads fine unconfined and is EACCES from inside
 * the sandbox. (Secrets in the confined shell's OWN inherited environment are
 * of course readable; that's a separate, acknowledged limitation — see the
 * spawn comment in active-sessions.ts.)
 *
 * ~/.local is RO, not RW, and that asymmetry is load-bearing — see the note
 * on devRwRoots().
 */
function devExtraRoRoots(): string[] {
  const home = homedir();
  return [
    "/opt",
    "/app",
    "/proc",
    "/sys",
    `${home}/.config`,
    `${home}/.gitconfig`,
    `${home}/.local`,
    // Plugins put their own bin/ directories on PATH (observed:
    // ~/.claude/plugins/cache/<owner>/<plugin>/<version>/bin), so a
    // plugin-shipped CLI is unrunnable without this. Like shell-snapshots
    // it's a narrow leaf: .credentials.json and hooop/hook.token are SIBLINGS
    // of plugins/, not underneath it, so they stay unreachable.
    `${home}/.claude/plugins`,
  ];
}

/**
 * Extra READ-WRITE roots for "dev" on top of the cwd + temp dir every
 * profile gets. Two of these are non-obvious:
 *
 *   /dev — `/dev/null` is opened O_RDWR, so it needs RW, not RO. Omitting
 *     /dev is what made `git status` exit 128 under the old "tight" profile
 *     ("could not open '/dev/null' for reading and writing"), and it breaks
 *     every `>/dev/null` in every shell wrapper. Also covers /dev/zero,
 *     /dev/urandom, /dev/tty, /dev/fd.
 *
 *   ~/.claude/shell-snapshots — claude writes a shell snapshot here and
 *     sources it at the top of every Bash tool call. Landlock rules do NOT
 *     require ancestor permissions, so granting this leaf grants nothing
 *     else under ~/.claude: the credentials, transcripts and hook token
 *     beside it stay unreachable. Safe despite being executable content: the
 *     snapshot is sourced by the SAME confined shell, so a poisoned snapshot
 *     runs inside the same Landlock domain and gains nothing.
 *
 * DELIBERATELY NOT RW: ~/.local. It is the first entry on PATH, and the
 * PreToolUse hooks (permission-gate.sh, emit-event.sh) run UNCONFINED — by
 * necessity, since the gate must read a token this profile denies. They
 * resolve `grep`, `sed`, `curl` and `node` off that inherited PATH, and the
 * sandbox server likewise spawns `claude` and `git` unqualified. A writable
 * directory that early on PATH is therefore a complete escape: plant
 * ~/.local/bin/grep, wait for the next tool call, and your code runs
 * unconfined. This was demonstrated end-to-end, exfiltrating the very hook
 * token the confined shell had just been refused.
 *
 * The cost is that `pip install --user` / `uv tool install` no longer work
 * from inside a session. That is the correct trade: installing an executable
 * onto the PATH of an unconfined process is exactly the operation that should
 * require a human. ~/.local stays READ-ONLY below, so tools already installed
 * there still run.
 */
function devRwRoots(): string[] {
  const home = homedir();
  return [
    "/dev",
    `${home}/.cache`,
    `${home}/.npm`, // npm's cache; `npm install` fails outright without it
    // Nested RW inside the RO ~/.local below. Landlock applies the most
    // specific matching rule, so this restores tool state/data writes while
    // ~/.local/bin — the entry on PATH — stays read-only. Verified.
    `${home}/.local/share`,
    `${home}/.claude/shell-snapshots`,
  ];
}

/**
 * Extra READ-ONLY roots for "preview". Same shape as "dev" minus the
 * claude-specific entries (the preview runner has no claude, no plugins and no
 * ~/.claude at all — that directory is deliberately not mounted into it).
 */
function previewExtraRoRoots(): string[] {
  const home = homedir();
  return ["/opt", "/app", "/proc", "/sys", `${home}/.gitconfig`];
}

/**
 * Extra READ-WRITE roots for "preview".
 *
 * This grants the runner's whole HOME, which "dev" pointedly refuses to do for
 * ~/.local. The difference is not an oversight, so it is worth stating exactly
 * why the same grant is unsafe there and safe here.
 *
 * In the sandbox, ~/.local is the first entry on PATH and the PreToolUse hooks
 * (permission-gate.sh, emit-event.sh) run UNCONFINED — they must, since the
 * gate reads a token the profile denies. A writable directory that early on
 * PATH is therefore a full escape: plant ~/.local/bin/grep and your code runs
 * outside the sandbox on the next tool call. See devRwRoots().
 *
 * The preview runner has no such asymmetry. It runs no hooks, has no control
 * plane to escape to, and every process in the container — the setup steps and
 * the long-lived run command alike — is spawned through this same wrapper into
 * the same Landlock domain. There is no unconfined reader of that PATH to
 * poison. Writing a binary into ~/.local/bin and executing it is not an
 * escalation; it is the feature (`uv tool install`, `pip install --user`,
 * `mise install`, `corepack prepare`), and refusing it would make the
 * language-agnostic spec a lie for every non-baked toolchain.
 *
 * The boundary that matters in the runner is the workspace one: cwd is the
 * session's own workdir, so a preview still cannot read a SIBLING session's
 * files. That is what this profile is actually defending, and HOME being
 * writable does not weaken it.
 */
function previewRwRoots(): string[] {
  const home = homedir();
  return ["/dev", home];
}

/** De-dupe while preserving first-seen order. */
function dedupe(paths: string[]): string[] {
  return [...new Set(paths)];
}

/**
 * Resolve an optional allow-list entry to its canonical form, dropping it if
 * it doesn't exist or can't be expressed in the colon-separated protocol.
 * Optional entries are filtered rather than fatal: the RO sets are static
 * supersets (`~/.claude`, `/opt/hooop`) that legitimately don't exist on every
 * profile, and refusing to confine at all over one of them would trade a real
 * boundary for a cosmetic one.
 */
function resolveOptional(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const real = canonicalize(p);
    if (real === null) continue; // absent on this host/image
    if (UNSAFE_IN_PATH_LIST.test(real)) {
      log.warn("landlock-policy", "dropping allow-list path containing ':' or newline", { path: real });
      continue;
    }
    out.push(real);
  }
  return out;
}

/**
 * Resolve a REQUIRED entry (the session cwd). Unlike the optional sets this
 * throws rather than filters: a session with no writable root would fail with
 * a cascade of confusing EACCES, and a cwd we cannot express is a
 * configuration problem the operator can actually fix (rename the mount).
 *
 * A cwd that doesn't resolve is kept in raw form rather than dropped — it
 * must always be writable, and a stat can lose a race against directory
 * creation. The wrapper re-checks it anyway.
 */
function resolveRequiredCwd(cwd: string): string {
  const real = canonicalize(cwd) ?? cwd;
  if (UNSAFE_IN_PATH_LIST.test(real)) {
    throw new LandlockPolicyError(
      `session working directory cannot be sandboxed because its path contains ':' or a newline: ${real}. ` +
        `Landlock allow-lists are colon-separated, so this path would silently grant a different directory. Rename it.`,
    );
  }
  return real;
}

/**
 * Compute the env vars the Landlock wrapper reads (HOOOP_LANDLOCK_RW,
 * HOOOP_LANDLOCK_RO, HOOOP_LANDLOCK_MODE) for a given profile + working
 * directory.
 *
 * RW is the same for both profiles: the session's cwd (always kept, even if
 * a stat somehow fails — a session must be able to use its own workdir) and
 * a scratch/temp dir. RO is the profile's root list, filtered down to paths
 * that actually exist on this host/image (a "broad" root like ~/.claude may
 * not exist yet on a brand new profile — Landlock would refuse to open() a
 * missing path anyway, so filtering here just avoids relying on the C side
 * to silently skip it).
 */
export function landlockSpawnEnv(profile: LandlockProfile, cwd: string): Record<string, string> {
  const tmpDir = process.env.TMPDIR || "/tmp";

  // Defensive: cwd must always be writable by the spawned process regardless
  // of whether the stat happens to succeed for it (e.g. a race right before
  // the directory is created) — it's unconditionally included, then every
  // other RW candidate is filtered down to paths that actually exist.
  const extraRw =
    profile === "dev" ? devRwRoots() : profile === "preview" ? previewRwRoots() : [];
  const rw = dedupe([
    resolveRequiredCwd(cwd),
    ...resolveOptional([tmpDir, ...extraRw]),
  ]);

  const roCandidates =
    profile === "broad"
      ? [...TIGHT_RO_ROOTS, ...broadExtraRoRoots()]
      : profile === "dev"
        ? [...TIGHT_RO_ROOTS, ...devExtraRoRoots()]
        : profile === "preview"
          ? [...TIGHT_RO_ROOTS, ...previewExtraRoRoots()]
          : TIGHT_RO_ROOTS;
  // Canonicalizing collapses the merged-/usr symlinks (/bin, /sbin, /lib →
  // /usr/*) into duplicates of /usr, so dedupe AFTER resolving, not before.
  const ro = dedupe(resolveOptional(roCandidates));

  return {
    HOOOP_LANDLOCK_RW: rw.join(":"),
    HOOOP_LANDLOCK_RO: ro.join(":"),
    HOOOP_LANDLOCK_MODE: landlockMode(),
  };
}

/**
 * Path to the Landlock-wrapping shell that claude spawns for its Bash tool
 * (see ../landlock/hooop-bash). Pointed at by CLAUDE_CODE_SHELL.
 */
export const HOOOP_BASH_SHELL = process.env.HOOOP_BASH_SHELL || "/usr/local/bin/hooop-bash";

/**
 * Whether the model's own Bash tool is confined.
 *   "require" — confine, and REFUSE to start a session if we can't. This is
 *               what the container sets: an unconfined shell there is a
 *               security failure, not a degraded mode.
 *   "off"     — don't confine (dev laptops, macOS, non-Linux CI, where the
 *               helper binary doesn't exist and the container boundary isn't
 *               there to fall back on anyway).
 *
 * Defaults to "off" so a local checkout keeps working; sandbox/Dockerfile
 * sets "require".
 */
export type BashConfineMode = "require" | "off";

export function bashConfineMode(): BashConfineMode {
  return process.env.HOOOP_BASH_CONFINE === "require" ? "require" : "off";
}

/** One "confinement is off" line per process, not one per session spawn. */
let loggedConfineOff = false;

/**
 * Everything needed to confine a session's Bash tool, or null when
 * confinement is off.
 *
 * Throws when the mode is "require" but confinement can't be applied. That
 * asymmetry is the whole point: claude's own CLAUDE_CODE_SHELL resolver
 * SILENTLY falls back to shell auto-detection when the override doesn't
 * resolve, so "the env var was set" proves nothing. The only way to fail
 * closed is to check the preconditions out here and refuse to spawn — a
 * session that starts with an unconfined shell looks identical to a confined
 * one from the inside.
 */
export function bashConfinementEnv(cwd: string): Record<string, string> | null {
  if (bashConfineMode() === "off") {
    // Say so exactly once. "Confinement is quietly off" and "confinement is
    // on" must never look the same in the logs — if someone deploys the image
    // with HOOOP_BASH_CONFINE overridden, this line is the only evidence.
    if (!loggedConfineOff) {
      loggedConfineOff = true;
      log.info("landlock-policy", "bash confinement is OFF (HOOOP_BASH_CONFINE is not 'require')", {
        cwdSample: cwd,
      });
    }
    return null;
  }

  for (const [what, path] of [["shell shim", HOOOP_BASH_SHELL], ["landlock wrapper", HOOOP_SANDBOX_EXEC]] as const) {
    if (!existsSync(path)) {
      throw new LandlockPolicyError(
        `HOOOP_BASH_CONFINE=require but the ${what} is missing at ${path}; refusing to start a session with an unconfined shell`,
      );
    }
  }

  // Throws (LandlockPolicyError) if the cwd can't be expressed — correct:
  // that's exactly the "cannot confine" case we must not paper over.
  return { ...landlockSpawnEnv("dev", cwd), CLAUDE_CODE_SHELL: HOOOP_BASH_SHELL };
}

// Only warn once per process when the wrapper binary is missing — this is
// expected (and noisy if repeated per-spawn) in dev/test/non-Linux
// environments where the image hasn't baked the helper in.
let warnedMissingHelper = false;

/**
 * Rewrite a `spawn(cmd, args, ...)` call so it runs through the Landlock
 * exec wrapper instead of `cmd` directly. Callers should use the returned
 * `file`/`args` in place of the originals and merge `env` into the child's
 * environment.
 *
 * Falls back to an unwrapped `{ file: cmd, args, env: {} }` when the
 * wrapper binary isn't present at HOOOP_SANDBOX_EXEC — this is the case in
 * local dev, unit tests, and any non-Linux host, none of which bake the
 * compiled binary in. The fallback is intentionally silent-after-first-use
 * (single warn) rather than fatal: the primary confinement in those
 * environments is still the container boundary / OS user permissions, and
 * refusing to spawn at all would break local development.
 */
export function wrapWithLandlock(
  profile: LandlockProfile,
  cwd: string,
  cmd: string,
  args: string[],
): { file: string; args: string[]; env: Record<string, string> } {
  if (existsSync(HOOOP_SANDBOX_EXEC)) {
    return {
      file: HOOOP_SANDBOX_EXEC,
      args: [cmd, ...args],
      env: landlockSpawnEnv(profile, cwd),
    };
  }

  if (!warnedMissingHelper) {
    warnedMissingHelper = true;
    log.warn("landlock-policy", "hooop-sandbox-exec helper not found; spawning unsandboxed (dev/test/non-linux fallback)", {
      HOOOP_SANDBOX_EXEC,
    });
  }
  return { file: cmd, args, env: {} };
}
