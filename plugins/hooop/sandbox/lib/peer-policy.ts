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
import { listMcps } from "./mcps";

/**
 * Which MCP servers run INSIDE the sandbox container (stdio) as opposed to
 * reaching out to an account somewhere (http/sse).
 *
 * This is the distinction the write rule below actually needs, and the tool NAME
 * cannot supply it. A stdio server is a child process in this container: its blast
 * radius is the container, exactly like the native tools, which is the same
 * argument that makes an in-workdir `Edit` routine. An http/sse server acts on the
 * host's Gmail, Drive or tracker — outside the box, where a path argument means
 * nothing and containment is not a concept.
 *
 * Cached briefly because this is consulted on every tool call, and re-read rather
 * than held forever because the host can install a server mid-life (it takes effect
 * at the next session spawn anyway).
 *
 * Unknown servers are NOT local. That is the fail-closed direction: an unreadable
 * config, or a name we cannot map, keeps today's stricter behaviour.
 */
type McpLookup = () => Array<{ name: string; type: string; plugin?: string }>;
let mcpLookup: McpLookup = () => listMcps().servers;
const MCP_LOOKUP_TTL_MS = 30_000;
let mcpCache: { at: number; local: Set<string> } | null = null;

/** Test seam: swap the source of MCP server definitions. Pass null to restore. */
export function setMcpLookupForTests(fn: McpLookup | null): void {
  mcpLookup = fn ?? (() => listMcps().servers);
  mcpCache = null;
}

function localMcpServers(): Set<string> {
  const now = Date.now();
  if (mcpCache && now - mcpCache.at < MCP_LOOKUP_TTL_MS) return mcpCache.local;
  const local = new Set<string>();
  try {
    for (const srv of mcpLookup()) {
      if (srv.type !== "stdio") continue;
      // Two spellings, because claude namespaces a plugin's server as
      // `plugin_<plugin>_<name>` in the tool name while the config knows it as
      // `<name>` under `<plugin>`.
      local.add(srv.name);
      if (srv.plugin) local.add(`plugin_${srv.plugin}_${srv.name}`);
    }
  } catch {
    /* unreadable config → nothing is known-local → every MCP write stays critical */
  }
  mcpCache = { at: now, local };
  return local;
}

/** `mcp__<server>__<action>` split into its two halves. */
function splitMcpTool(toolName: string): { server: string; action: string } {
  const rest = toolName.slice("mcp__".length);
  const i = rest.indexOf("__");
  return i < 0 ? { server: "", action: rest } : { server: rest.slice(0, i), action: rest.slice(i + 2) };
}

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

// Irreversible / high-blast-radius commands. In auto mode — and on the `!bash`
// fast lane when a GUEST is driving it — these prompt the host instead of running
// silently. Broad on purpose: a false positive only routes a command to a host
// approval, never runs something it shouldn't.
//
// The fast-lane half of that sentence was aspirational for a while. peerBashAllowed
// (below) covers git push, secrets and env dumps, and nothing consulted this list,
// so a full share could `!rm -rf` straight past the model and the gate. The bash
// route now asks isCriticalBash and raises a host-only card; this note is here
// because the list's reach is not obvious from the list.
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
export function isCriticalTool(
  toolName: string,
  input: unknown,
  cwd?: string | null,
  /** The session's own scratch dir (see sessionScratchDir). Counts as inside the
   *  boundary: it is the agent's own output, and it is per-session so one session
   *  still cannot read another's. */
  scratch?: string | null,
): boolean {
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
      if (!isPathWithinCwd(cwd, target, scratch)) return true;
    }
  }

  // (1b) MCP mutations — the FALLBACK for when containment could not answer.
  //
  // This is what the comment above MCP_MUTATING_ACTION has always described ("a
  // heuristic on the action segment", "with no path argument we recognise") and not
  // what the code did: it tested the verb against `<server>__<action>` and returned
  // true regardless of any path, so a Serena `replace_content` on a file INSIDE the
  // workdir outranked a native `Edit` on the same file. Harmless while the cost of a
  // false positive was one extra card. Now that a critical ask is host-only — and
  // both relief valves, trust and auto mode, exclude the critical set by design —
  // that asymmetry meant a guest co-driving a Serena session pinged the host on
  // every edit, with no way to opt out.
  //
  // So: a mutation whose path we checked, inside the workdir, on a server running in
  // THIS container, is routine like the native equivalent. Everything else stays the
  // host's: no path to check, no cwd to check against, or a server that acts outside
  // the box, where the path argument is a claim rather than a boundary.
  if (isMcpTool(toolName)) {
    const { server, action } = splitMcpTool(toolName);
    // Verb matched on the ACTION only. Against `<server>__<action>` a server called
    // `gdrive-writer` or `run-tools` made every one of its tools critical.
    if (MCP_MUTATING_ACTION.test(action)) {
      if (!cwd || paths.length === 0) return true;   // nothing was contained
      if (!localMcpServers().has(server)) return true; // acts outside this container
      return false;                                   // contained, in-container
    }
  }

  return false;
}
