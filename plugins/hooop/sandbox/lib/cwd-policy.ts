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

import { realpathSync } from "node:fs";
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
 * The scratch directory a session may use freely, outside its workdir.
 *
 * Why one exists at all: measured on a real auto-mode session, 30 of 72 permission
 * cards came from the agent writing screenshots and helper scripts to `/tmp` and
 * then reading them back. Nothing about that is dangerous — it is the agent's own
 * output — but `/tmp` is outside the workdir, so every read escalated to a human.
 *
 * Why it is not just `/tmp`: every session in an install shares one sandbox
 * container, so a blanket `/tmp` allowance would let one session read another's
 * scratch with no prompt. Containment between sessions is the thing keeping them
 * apart. Per-session, it stays contained by construction.
 *
 * Bless the path, do not create it: an agent that never uses it costs nothing, and
 * the system prompt (see SCRATCH_SYSTEM_PROMPT) is what makes it the habit.
 */
export function sessionScratchDir(sessionId: string): string | null {
  // A session id is a uuid from claude, but this builds a filesystem path that
  // grants relaxed access — so refuse anything that is not plainly one, rather
  // than letting a crafted id widen the boundary (`../..`, an absolute path, a
  // separator of any kind).
  if (!/^[A-Za-z0-9._-]{8,128}$/.test(sessionId) || sessionId.includes("..")) return null;
  return join("/tmp", "hooop-session", sessionId);
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
export function isPathWithinCwd(cwd: string, target: string, scratch?: string | null): boolean {
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

  // An unresolvable cwd is still "outside" for the cwd test — the fail-closed
  // behaviour this function has always had — but it must not shadow the scratch
  // test below, which does not depend on the cwd at all. Nesting them cost the
  // scratch allowance entirely whenever a cwd could not be canonicalized.
  const realCwd = canonicalize(cwd);
  if (realCwd !== null && within(realTarget, realCwd)) return true;

  // The session's own scratch dir counts as inside. Resolved the same way (so a
  // symlink out of it does not pass) and only when the caller supplies one — a
  // slot-less call has no session, and therefore no scratch.
  if (scratch) {
    const realScratch = canonicalize(scratch) ?? scratch;
    if (within(realTarget, realScratch)) return true;
  }
  return false;
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
