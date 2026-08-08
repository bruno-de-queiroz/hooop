/**
 * Command policy for PEER co-drivers (not the local host). A peer is someone
 * invited via a share link; pairing is semi-trusted, so this is a guardrail
 * against accidental/casual exfiltration and unwanted pushes — NOT a hard
 * boundary against a determined hostile party (a shell denylist can always be
 * obfuscated; the real boundary is "don't share with someone you don't trust").
 *
 * Enforced authoritatively sandbox-side on the `!bash` fast lane (which bypasses
 * the model + permission gate) and, for git push, also on permission approvals.
 *
 * isCriticalTool additionally serves the MODEL's own tool calls (auto mode,
 * approved-plan runs, trusted-peer turns), where the adversary model is
 * stronger than "semi-trusted human": prompt injection from repo content or a
 * fetched page. The containment half of that check is a real boundary; the
 * denylist half remains a guardrail.
 */

import { isPathWithinCwd } from "./cwd-policy";

/** git push / force-push in any form: `git push`, `git -C dir push`, `git push --force`. */
export function isGitPush(command: string): boolean {
  // Match a `git` invocation that also contains a `push` subcommand/word.
  // Deliberately broad (errs toward catching) — a false positive just routes a
  // command to host approval rather than silently running it.
  return /\bgit\b[^\n;|&]*\bpush\b/i.test(command);
}

/** Any `git` invocation at all, whatever the subcommand. Used to keep auto
 * mode prompting for git specifically — even read-only-looking subcommands
 * like `log`/`show`/`diff`/`clone` can be made to run arbitrary code via
 * repo-controlled config (`core.pager`, a `.gitattributes` `textconv`/`diff`
 * filter, `--upload-pack=<cmd>`), so this isn't narrowed to a "mutating
 * subcommands" list the way the plain destructive-command checks below are. */
export function isGitCommand(command: string): boolean {
  return /\bgit\b/i.test(command);
}

// Paths whose contents are secrets/tokens the host doesn't want a peer reading.
// Mirrors the philosophy of the user's settings.json deny-list, extended for
// the direct-exec lane.
const SECRET_PATTERNS: RegExp[] = [
  /\.credentials\.json/i,
  /\.claude\.json/i,
  /\/var\/run\/hooop/i,    // sandbox + hook tokens, socket
  /hook\.token/i,
  /\bid_rsa\b|\bid_ed25519\b|\bid_ecdsa\b/i,
  /(^|[\s\/'"~])\.ssh(\/|\b)/i, // ~/.ssh, .ssh/, /home/agent/.ssh
  /(^|[\s\/'"~])\.aws(\/|\b)/i,
  /(^|[\s\/'"~])\.env(\.|\b)/i,
];

// Bare environment dumps leak any token that lives in the process env.
// Allows `env VAR=x cmd` (env with assignment args), blocks `env`, `env|...`,
// `env > f`, and `printenv`.
const ENV_DUMP_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)printenv\b/i,
  /(^|[;&|]\s*)env\s*($|[|>])/i,
];

// Irreversible / high-blast-radius commands. In auto mode (and the sandbox Bash
// fast-lane) these keep prompting the host instead of running silently. Broad on
// purpose — a false positive only routes a command to a host approval, never
// runs something it shouldn't.
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*\s+)*-[a-z]*[rf][a-z]*/i, // rm -rf, rm -fr, rm -r -f, …
  /\brmdir\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^\n]*\bof=/i,
  />\s*\/dev\/(sd|nvme|disk)/i,             // overwrite a raw block device
  /\b(chmod|chown)\b[^\n]*\s-[a-z]*R/i,     // recursive perm/owner changes
  /\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/i,
  /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
  /\bcurl\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i, // curl … | sh
  /\bwget\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i, // wget … | sh
];

export interface PolicyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Whether a peer may run this `!bash` command directly. Host commands are never
 * checked (the host already has full shell + the dashboard token).
 */
export function peerBashAllowed(command: string): PolicyResult {
  if (isGitPush(command)) {
    return { ok: false, reason: "git push is host-only in a shared session" };
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(command)) {
      return { ok: false, reason: "command would read host secrets/tokens (blocked for guests)" };
    }
  }
  for (const re of ENV_DUMP_PATTERNS) {
    if (re.test(command)) {
      return { ok: false, reason: "environment dumps are blocked for guests (may contain tokens)" };
    }
  }
  return { ok: true };
}

/**
 * A Bash command that is "critical" enough to always surface a host prompt even
 * when the session is running unattended (auto mode). Union of: any git
 * invocation, secret/token reads, environment dumps, and irreversible/
 * destructive commands. Git is all-or-nothing rather than a denylist of
 * mutating subcommands — auto mode is meant to be safe to leave running
 * against a model that might be prompt-injected, and git history/config
 * carries too many ways to matter (rewriting, remotes, hooks, credentials)
 * to try to enumerate. Reuses the peer-policy denylists so there is ONE
 * definition of dangerous.
 */
export function isCriticalBash(command: string): boolean {
  if (isGitCommand(command)) return true;
  for (const re of SECRET_PATTERNS) if (re.test(command)) return true;
  for (const re of ENV_DUMP_PATTERNS) if (re.test(command)) return true;
  for (const re of DESTRUCTIVE_PATTERNS) if (re.test(command)) return true;
  return false;
}

/**
 * Input fields that carry a filesystem path, across both native tools and the
 * MCP servers this image ships. Checked generically rather than per-tool so a
 * newly-added tool is covered by default instead of silently exempt.
 */
const PATH_FIELDS = [
  "file_path",
  "notebook_path",
  "path",
  "relative_path",
  "target_file",
  "file",
  "directory",
  // Glob takes its target as `pattern` with an OPTIONAL `path` root, so a
  // pattern like "/etc/**" escapes the workdir without `path` ever being set.
  // Treated as a path here: containment resolves the literal prefix, and a
  // relative pattern (the normal case, e.g. "src/**/*.ts") still resolves
  // inside the cwd and stays routine.
  "pattern",
] as const;

/**
 * Action verbs that make an MCP tool a write/execute. `isCriticalTool` used to
 * return false for EVERY `mcp__*` name, so under auto mode (or an approved
 * plan, or a trusted peer) serena's `replace_content`/`write_memory`/
 * `insert_after_symbol` family and playwright's `browser_evaluate` — arbitrary
 * JS in the browser process — all executed with no prompt at all.
 *
 * This is a heuristic on the action segment of `mcp__<server>__<action>`, and
 * it is deliberately over-broad: the cost of a false positive is one extra
 * permission card, the cost of a false negative is an unprompted write. It is
 * a "keep asking the human" gate, NOT a security boundary — an MCP server that
 * writes from an innocuously-named tool still gets through, which is why the
 * containment check below applies to MCP tools too.
 */
const MCP_MUTATING_ACTION =
  /(write|edit|insert|replace|delete|remove|rename|create|move|upload|install|execute|eval|build|run|save|store|append|patch|publish|send|upsert)/i;

function isMcpTool(toolName: string): boolean {
  return toolName.startsWith("mcp__");
}

/**
 * Every path-shaped value in a tool input, for containment checking.
 *
 * Accepts arrays as well as bare strings: an MCP server exposing
 * `{paths: [...]}` or `{file_path: [...]}` would otherwise be exempt from
 * containment entirely, since a non-string value was previously just skipped.
 */
function pathArgsOf(input: unknown): string[] {
  if (input === null || typeof input !== "object") return [];
  const rec = input as Record<string, unknown>;
  const out: string[] = [];
  const take = (v: unknown) => {
    if (typeof v === "string" && v.length > 0) out.push(v);
  };
  for (const field of PATH_FIELDS) {
    const v = rec[field];
    if (Array.isArray(v)) v.forEach(take);
    else take(v);
  }
  // Plural spellings of the same fields, which MCP servers commonly use.
  for (const field of PATH_FIELDS) {
    const v = rec[`${field}s`];
    if (Array.isArray(v)) v.forEach(take);
    else take(v);
  }
  return out;
}

/**
 * Whether a tool call is "critical" — must keep prompting the host even in auto
 * mode, an approved plan run, or a trusted-peer turn.
 *
 * Three independent reasons a call is critical:
 *   1. Bash judged by isCriticalBash (git, secrets, destructive commands).
 *   2. A path argument matching a secret pattern (~/.ssh, .env, credentials).
 *   3. A path argument OUTSIDE the session's working directory — passing `cwd`
 *      enables this. Without it the check was a secret-substring denylist with
 *      no notion of a boundary at all, so `Write` to any absolute path the
 *      denylist didn't happen to name was auto-approved.
 *
 * `cwd` is optional so slot-less callers (standalone skill runs, which have no
 * session workdir) keep working; when it's absent, reason 3 is simply not
 * evaluated rather than defaulting to "outside" — a skill run legitimately has
 * no boundary to be outside of, and failing closed there would make every such
 * call prompt.
 */
export function isCriticalTool(toolName: string, input: unknown, cwd?: string | null): boolean {
  if (toolName === "Bash") {
    const cmd = (input as { command?: unknown } | null)?.command;
    return typeof cmd === "string" && isCriticalBash(cmd);
  }

  const paths = pathArgsOf(input);

  // (2) Secret-path denylist — applies to every tool, native or MCP.
  for (const target of paths) {
    for (const re of SECRET_PATTERNS) if (re.test(target)) return true;
  }

  // (3) Containment. Escaping the session workdir always warrants a prompt,
  // whatever the tool is.
  if (cwd) {
    for (const target of paths) {
      if (!isPathWithinCwd(cwd, target)) return true;
    }
  }

  // (1b) MCP writes/execs with no path argument we recognise (e.g.
  // browser_evaluate, write_memory) — see MCP_MUTATING_ACTION.
  if (isMcpTool(toolName) && MCP_MUTATING_ACTION.test(toolName.slice("mcp__".length))) return true;

  return false;
}
