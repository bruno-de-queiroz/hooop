/**
 * Cwd allowlist for dashboard-spawned sessions. The primary defense is
 * filesystem permissions via the container's non-root user (Dockerfile drops
 * to `node`). This is the secondary layer: reject obviously dangerous paths
 * before they ever reach `spawn`, and let an operator restrict further via
 * an env var.
 *
 * HOOOP_CWD_ROOTS: comma-separated list of allowed root paths. When set,
 * the cwd must equal one of them or be a subpath of one. When unset, the
 * built-in deny rules below are the only enforcement.
 *
 * Symlink safety: both the input path and each allowed root are resolved via
 * realpathSync.native before comparison so a symlink inside an allowed root
 * cannot point outside it to bypass the policy.
 */

import { lstatSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";
import { log } from "@shared/logger";

const ALWAYS_DENIED_PREFIXES = ["/etc", "/proc", "/dev", "/sys", "/boot", "/var/run", "/var/lib/secrets"];

/**
 * Resolve a path to its OS-level canonical form. Returns null on any failure
 * (path does not exist, IO error, etc.).
 */
export function canonicalize(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

/**
 * Resolve a path to the canonical form of its DEEPEST EXISTING ancestor, with
 * any not-yet-existing tail appended.
 *
 * Plain canonicalize() returns null for a file that doesn't exist yet, which
 * is the common case for a Write. Resolving the ancestor instead means a write
 * through a symlinked parent directory is still caught, while a brand-new leaf
 * name is handled fine.
 *
 * Returns null when the tail contains a ".." component: once the existing part
 * has been resolved, a ".." in the non-existent remainder can't be reasoned
 * about safely, so callers should treat it as out of bounds.
 */
function canonicalizeDeepest(abs: string): string | null {
  let cur = abs;
  const tail: string[] = [];
  // Bounded: a path can't have more components than it has characters, and
  // the loop always moves strictly upward.
  for (let depth = 0; depth < 256; depth += 1) {
    const real = canonicalize(cur);
    if (real !== null) {
      if (tail.some((t) => t === "..")) return null;
      return tail.length > 0 ? join(real, ...tail.reverse()) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) return null; // hit the root without resolving anything
    tail.push(basename(cur));
    cur = parent;
  }
  return null;
}

/**
 * The per-session scratch directory: `<cwd>/tmp`.
 *
 * Why one exists: measured on a real auto-mode session, 30 of 72 permission cards
 * were the agent writing screenshots and helper scripts somewhere temporary and
 * reading them back. Its own output, escalating to a human every time.
 *
 * Why it lives INSIDE the workdir, which is the whole point: the workdir is already
 * the one place a session may read and write freely, for the model's file tools AND
 * for its Landlock-confined shell. So this needs no policy of its own — no blessed
 * path outside the boundary, no allow-list entry, no check that something hostile
 * has not taken the name. It is simply in the cwd.
 *
 * The previous version put it at `/tmp/hooop-session/<id>` and cost three separate
 * bugs to defend, all the same question in a different syscall: /tmp is shared by
 * every session in the container, so a blessed path there needs a symlink check on
 * the leaf, on the parent, and on every comparison. Inside the cwd, none of that
 * applies.
 *
 * TMPDIR, TMP and TEMP are all pointed here at spawn (see the arg builder), so
 * mktemp, tempfile and os.tmpdir() land here rather than in the shared /tmp — which
 * is what makes this hold for tools that never read the system prompt. All three,
 * because TMPDIR alone does not survive: it is on glibc's unsecvars list and the
 * setuid hooop-as-agent step strips it, so hooop-sandbox-exec restores it from TMP.
 *
 * Recorded because it cost a wrong conclusion: narrowing Landlock to the old /tmp
 * scratch dir was tried and reverted after every Bash command started exiting 1 on
 * `/tmp/claude-<pid>-cwd`, which looked like claude hardcoding /tmp. It was not.
 * claude uses os.tmpdir(), and TMPDIR had been stripped while TMP/TEMP were unset.
 * With all three set, claude's own temp state moves in here too (verified live:
 * `claude-1000` appears under ./tmp), so that option is open again if the shared
 * /tmp ever stops being an acceptable risk.
 */
export function sessionTmpDir(cwd: string): string {
  return join(cwd, "tmp");
}

/**
 * Remove the scratch root a previous version of hooop created at
 * `/tmp/hooop-session`, once, at boot.
 *
 * Sessions used to be steered at `/tmp/hooop-session/<id>` before scratch moved
 * inside the workdir (see sessionTmpDir). The directory is ours — created by this
 * uid, 1777 — and every session subdirectory under it belongs to the model's uid,
 * which cannot delete the parent because /tmp is sticky. So the server has to be
 * the one to clear it, or an upgraded install keeps last version's scratch (and
 * whatever was written in it) lying around in a world-writable directory forever.
 *
 * Idempotent and non-fatal: nothing depends on this succeeding.
 */
export function removeLegacyScratchRoot(): void {
  const legacy = join("/tmp", "hooop-session");
  try {
    if (!lstatSync(legacy).isDirectory()) return; // not ours to delete
  } catch {
    return; // already gone, the normal case after the first boot
  }
  try {
    rmSync(legacy, { recursive: true, force: true });
    log.info("cwd-policy", "removed the legacy /tmp scratch root", { legacy });
  } catch (err) {
    log.warn("cwd-policy", "could not remove the legacy /tmp scratch root", { legacy, err: String(err) });
  }
}

/**
 * True when `target` resolves to `cwd` itself or something beneath it.
 *
 * This is the containment check for TOOL arguments (a Write's file_path, a
 * Read's file_path, an MCP server's relative_path), as opposed to isAllowedCwd
 * which validates a session's own working directory. Both ends are resolved,
 * so neither a `..` traversal nor a symlink pointing outside the tree passes.
 *
 * Fails CLOSED: an unresolvable cwd, an empty/NUL-bearing target, or a target
 * whose unresolved tail contains ".." all return false (i.e. "outside"), so a
 * path we can't reason about escalates to a prompt rather than sliding through.
 */
export function isPathWithinCwd(cwd: string, target: string): boolean {
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) return false;
  if (typeof cwd !== "string" || cwd.length === 0) return false;

  // "~" is HOME-relative, never cwd-relative. Without this, `~/.claude/x`
  // fails isAbsolute(), gets joined onto the cwd as a literal directory named
  // "~", resolves to a nonexistent path INSIDE the workdir, and is reported as
  // contained — while whatever finally opens it expands the tilde and reads
  // $HOME. Claude normalises `~` in its own file tools before the hook sees
  // them, so this isn't reachable through Read/Write/Edit today, but MCP
  // servers receive their path arguments verbatim, so the disagreement is
  // real. Resolve it the same way a shell would.
  const expanded = target === "~" || target.startsWith("~/")
    ? join(homedir(), target.slice(1))
    : target;

  // A relative tool path is interpreted against the session cwd, matching how
  // the tool itself would resolve it.
  const abs = isAbsolute(expanded) ? expanded : join(cwd, expanded);
  const realTarget = canonicalizeDeepest(abs);
  if (realTarget === null) return false;

  // Fail closed on an unresolvable cwd, as this has always done. The session's
  // scratch dir needs no separate case: sessionTmpDir() is inside the cwd, so it is
  // covered by the same comparison, which is the reason it moved there.
  const realCwd = canonicalize(cwd);
  return realCwd !== null && within(realTarget, realCwd);
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * Resolve always-denied prefixes once at module load. On macOS /etc resolves
 * to /private/etc, so we must compare against the resolved forms.
 * Prefixes that don't exist on this host are kept in their raw form so that
 * syntactic checks (e.g. /proc on macOS) still work.
 */
const RESOLVED_DENIED_PREFIXES: string[] = ALWAYS_DENIED_PREFIXES.map(
  (p) => canonicalize(p) ?? p,
);

/**
 * Return true when the canonical path (or its parents) matches any denied prefix.
 */
function isUnderDeniedPrefix(resolvedPath: string): { denied: true; prefix: string } | false {
  for (const prefix of RESOLVED_DENIED_PREFIXES) {
    if (resolvedPath === prefix || resolvedPath.startsWith(prefix + "/")) {
      return { denied: true, prefix };
    }
  }
  // Also check the raw prefixes in case a path resolves to something that
  // contains one of the raw prefix strings (belt-and-suspenders).
  for (const prefix of ALWAYS_DENIED_PREFIXES) {
    if (resolvedPath === prefix || resolvedPath.startsWith(prefix + "/")) {
      return { denied: true, prefix };
    }
  }
  return false;
}

/**
 * Full cwd policy check with canonical path resolution.
 *
 * Returns `{ ok: true, canonical }` when the path is allowed, or
 * `{ ok: false, reason }` when it is rejected.
 *
 * Steps:
 *  1. Syntactic sanity checks (null byte, non-string, etc.).
 *  2. Resolve the path via realpathSync.native — rejects non-existent paths
 *     and surfaces symlink targets.
 *  3. Check canonical path against always-denied prefixes.
 *  4. If HOOOP_CWD_ROOTS is set, verify the canonical path sits under at
 *     least one (also canonicalized) allowed root.
 */
export function isCwdAllowed(
  rawPath: string,
): { ok: true; canonical: string } | { ok: false; reason: string } {
  if (typeof rawPath !== "string" || !rawPath) {
    return { ok: false, reason: "cwd must be a non-empty string" };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "cwd contains a null byte" };
  }

  // Resolve to canonical path (follows symlinks, resolves . and ..).
  // Rejects non-existent paths (fail closed).
  const resolved = canonicalize(rawPath);
  if (resolved === null) {
    return { ok: false, reason: `cwd does not exist or cannot be resolved: ${rawPath}` };
  }

  const denied = isUnderDeniedPrefix(resolved);
  if (denied) {
    return { ok: false, reason: `cwd under ${denied.prefix} is not allowed` };
  }

  const envRoots = process.env.HOOOP_CWD_ROOTS;
  if (envRoots) {
    const rawRoots = envRoots
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter((s) => s.length > 0);

    // Canonicalize each allowed root; skip roots that don't exist (with warning).
    const resolvedRoots: string[] = [];
    for (const root of rawRoots) {
      const resolvedRoot = canonicalize(root);
      if (resolvedRoot === null) {
        log.warn("cwd-policy", "configured root does not exist or cannot be resolved; skipping", { root });
        continue;
      }
      resolvedRoots.push(resolvedRoot);
    }

    const matched = resolvedRoots.some(
      (r) => resolved === r || resolved.startsWith(r + "/"),
    );
    if (!matched) {
      return {
        ok: false,
        reason: `cwd is not under any allowed root (${rawRoots.join(", ")})`,
      };
    }
  }

  return { ok: true, canonical: resolved };
}

/**
 * Legacy export: backwards-compatible boolean wrapper around cwd policy check.
 * Existing callers that only need ok/not-ok can keep using this without
 * changes. Also used by server.ts at POST /sessions time.
 *
 * This variant performs full canonicalization when the path exists. When the
 * path does NOT exist AND no env allowlist is configured, the always-denied
 * prefix check is still applied syntactically so that e.g. /etc/foo is
 * rejected even on hosts where that path somehow doesn't exist.
 *
 * When an env allowlist IS configured, a non-existent path is always rejected
 * (fail closed) because we cannot safely canonicalize it for comparison.
 */
export function isAllowedCwd(rawPath: string): { ok: boolean; reason?: string } {
  if (typeof rawPath !== "string" || !rawPath) {
    return { ok: false, reason: "cwd must be a non-empty string" };
  }
  if (rawPath.includes("\0")) {
    return { ok: false, reason: "cwd contains a null byte" };
  }
  // Reject `..` segments before normalisation — they don't belong in a value
  // a user typed into a form field.
  if (rawPath.split("/").some((seg) => seg === "..")) {
    return { ok: false, reason: "cwd contains '..' path traversal" };
  }

  // Try canonical resolution. When it succeeds we use it for all checks.
  const resolved = canonicalize(rawPath);

  if (resolved !== null) {
    // Full canonicalized check.
    const denied = isUnderDeniedPrefix(resolved);
    if (denied) {
      return { ok: false, reason: `cwd under ${denied.prefix} is not allowed` };
    }

    const envRoots = process.env.HOOOP_CWD_ROOTS;
    if (envRoots) {
      const rawRoots = envRoots
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter((s) => s.length > 0);

      // Canonicalize each allowed root; skip roots that don't exist (with warning).
      const resolvedRoots: string[] = [];
      for (const root of rawRoots) {
        const resolvedRoot = canonicalize(root);
        if (resolvedRoot === null) {
          log.warn("cwd-policy", "configured root does not exist or cannot be resolved; skipping", { root });
          continue;
        }
        resolvedRoots.push(resolvedRoot);
      }

      const matched = resolvedRoots.some(
        (r) => resolved === r || resolved.startsWith(r + "/"),
      );
      if (!matched) {
        return { ok: false, reason: `cwd is not under any allowed root (${rawRoots.join(", ")})` };
      }
    }

    return { ok: true };
  }

  // Path does not exist (resolved === null).
  // With an env allowlist active: fail closed — we cannot canonicalize for
  // comparison, so we cannot safely allow this path.
  const envRoots = process.env.HOOOP_CWD_ROOTS;
  if (envRoots) {
    return { ok: false, reason: `cwd does not exist or cannot be resolved: ${rawPath}` };
  }

  // No env restriction: fall back to syntactic always-denied check only.
  // This preserves backwards-compatible behaviour for tests and deployments
  // that check hypothetical paths without creating them first.
  for (const prefix of ALWAYS_DENIED_PREFIXES) {
    if (rawPath === prefix || rawPath.startsWith(prefix + "/")) {
      return { ok: false, reason: `cwd under ${prefix} is not allowed` };
    }
  }

  return { ok: true };
}
