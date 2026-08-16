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
      // A plugin's server appears in tool names ONLY as `plugin_<plugin>_<name>`
      // (`mcp__plugin_hooop_tools__…`), while the config knows it as `<name>` under
      // `<plugin>`. Register the namespaced spelling for those and the bare name
      // for everything else — registering both would let a local plugin server
      // named `github` vouch for a REMOTE user-scoped `github`, whose writes would
      // then read as in-container and stop asking.
      if (srv.plugin) local.add(`plugin_${srv.plugin}_${srv.name}`);
      else local.add(srv.name);
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

/**
 * A Bash command with its heredoc BODIES removed, so patterns match the command and
 * not the data it carries.
 *
 * Why this exists: a session writing a landing page about hooop's own gating became
 * unusable. The page copy contains the words "git push" and "rm -rf", the model
 * edits files with `python3 - <<\'PY\'`, and every paragraph therefore looked like a
 * dangerous command and raised a host card. Seventeen cards in one sitting, all of
 * them prose.
 *
 * It also makes the rules CONSISTENT. `pathArgsOf` never looked at a Write's
 * `content`, so writing a script with Write and running it was always routine while
 * the same script in a heredoc was inspected. Two spellings of one action should not
 * get two answers. The honest description of the denylist is that it reads the
 * command, not the payload — and Landlock, not this, is what bounds what the payload
 * can do once it runs.
 */
export function withoutHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let terminator: string | null = null;
  let dashed = false;
  for (const line of lines) {
    if (terminator !== null) {
      const probe = dashed ? line.replace(/^[\t ]+/, "") : line;
      if (probe.trim() === terminator) {
        out.push(line);
        terminator = null;
      }
      continue; // body dropped
    }
    out.push(line);
    const m = /<<(-?)\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(line);
    if (m) {
      dashed = m[1] === "-";
      terminator = m[3];
    }
  }
  return out.join("\n");
}

/** Git subcommands that PUBLISH, RECONFIGURE, or DESTROY history/work. */
const GIT_CRITICAL_SUB = new Set([
  // publishes to somewhere else
  "push", "send-email", "request-pull",
  // reconfigures the repo, including hooks and credential helpers
  "config", "credential", "remote", "submodule",
  // destroys history or uncommitted work
  "reset", "rebase", "filter-branch", "filter-repo", "gc", "prune", "reflog", "clean",
]);

/**
 * A `git` invocation that warrants a host prompt, as opposed to any mention of git.
 *
 * This used to be "any git at all", on the argument that even `git log` can run
 * arbitrary code through repo-controlled config (`core.pager`, a `textconv` filter,
 * `--upload-pack`). The argument is true and the conclusion was still wrong: the
 * model can run arbitrary code with `node -e` or an npm script without touching git,
 * so gating `git status` buys nothing against code execution — Landlock is what
 * bounds that — while costing a card on every `git status`, `git add`, `git commit`
 * and `git check-ignore`. Measured on this install: 141 of 533 Bash calls invoke git
 * and only 16 of those touch the network.
 *
 * So the line is drawn at what is irreversible or outward-facing instead: publishing,
 * reconfiguring, and destroying work. The explicit code-injection flags stay critical
 * because they have no innocent use, and `-c` is allowed only for the identity keys
 * the model legitimately passes to `commit`.
 */
export function isCriticalGit(command: string): boolean {
  const code = withoutHeredocBodies(command);
  const re = /(?:^|[\n;&|(]\s*|&&\s*|\|\|\s*)(?:\w+=\S*\s+)*git\b([^\n;&|]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const rest = m[1] ?? "";
    if (/--(?:upload|receive)-pack\b|--exec\b/i.test(rest)) return true;
    for (const raw of rest.match(/-c\s+[A-Za-z0-9._-]+\s*=/g) ?? []) {
      const key = raw.replace(/^-c\s+/, "").replace(/\s*=$/, "").toLowerCase();
      if (key !== "user.name" && key !== "user.email") return true;
    }
    // Skip global options (-C dir, -c k=v, --no-pager, …) to reach the subcommand.
    const sub = /^(?:\s+(?:-[Cc]\s+\S+|--?[A-Za-z][\w-]*(?:=\S*)?))*\s+([a-z][a-z-]*)/.exec(rest);
    if (sub && GIT_CRITICAL_SUB.has(sub[1].toLowerCase())) return true;
  }
  return false;
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
  // Everything below was reachable with no card until an open() probe on a live
  // session showed which of these actually exist and are readable by the model's
  // uid. The gh one is the sharp one: `hooop setup` signs the sandbox in to the
  // OPERATOR's GitHub account, so that file is a host credential sitting inside
  // Landlock's read-only allow-list, where no kernel rule will stop a read of it.
  /(^|[\s\/'"~])\.config\/gh(\/|\b)/i,
  /(^|[\s\/'"~])\.gitconfig\b/i,
  /(^|[\s\/'"~])\.git-credentials\b/i,
  /(^|[\s\/'"~])\.netrc\b/i,
  /(^|[\s\/'"~])\.npmrc\b/i,
  /(^|[\s\/'"~])\.docker\/config\.json/i,
  /(^|[\s\/'"~])\.kube(\/|\b)/i,
  /(^|[\s\/'"~])\.config\/gcloud(\/|\b)/i,
  // `cat /proc/self/environ` read the whole environment while saying neither
  // "env" nor "printenv", so it walked around ENV_DUMP_PATTERNS entirely.
  /\/proc\/(self|\d+|\$\$|\*)\/environ/i,
];

// Bare environment dumps leak any token that lives in the process env.
// Allows `env VAR=x cmd` (env with assignment args), blocks `env`, `env|...`,
// `env > f`, and `printenv`.
const ENV_DUMP_PATTERNS: RegExp[] = [
  /(^|[;&|]\s*)printenv\b/i,
  /(^|[;&|]\s*)env\s*($|[|>])/i,
];

// Ways to run a string the peer constructed, which is how every other rule in
// this file gets spelled around: `eval "$(printf '\\x72\\x6d -rf .')"` is `rm -rf`
// that matches no destructive pattern, and `sh -c` is the same trick with a
// different name. Forbidden for a peer rather than escalated, because there is no
// version of "approve this constructed string" a host can meaningfully read.
//
// NOT a closed set, and it cannot be: `$(…)`, backticks and an npm script in the
// repo are the same capability under different spellings, and those stay allowed
// on purpose (they are too common in ordinary commands to block). What bounds
// those is capability, not text — see the note on SECRET_PATTERNS about the gh
// token, which no kernel rule stops.
const CONSTRUCTED_EXEC_PATTERNS: RegExp[] = [
  // Anchored to COMMAND POSITION, not "mentions the word". Unanchored, these
  // refused `cat eval-results.md` and `grep -rn source src/` — and a refusal has no
  // recourse at all: the host cannot approve it either, so a false positive here is
  // worse than one on a card. Same reasoning ENV_DUMP_PATTERNS already uses to allow
  // `env FOO=bar cmd` while blocking a bare `env`.
  /(^|[\n;&|(]\s*|&&\s*|\|\|\s*)eval\b/i,
  /(^|[\n;&|(]\s*|&&\s*|\|\|\s*)source\s/i,
  /(^|[\n;&|]\s*)\.\s+\S/,                    // `. ./script`
  /\b(ba|z|k|da)?sh\s+(-[a-z]*\s+)*-c\b/i,   // sh -c, bash -lc, zsh -c
];

/**
 * A `git` INVOCATION, as opposed to the word "git" appearing anywhere.
 *
 * A newline counts as a separator alongside `;`, `&&` and `|`. Leaving it out was a
 * hole: every command in the session that exposed all this is multi-line, with `cd`
 * on the first line and git on the third, and `^` without the m flag only matches the
 * start of the whole string.
 *
 * Used only for the peer refusal, where isGitCommand's "any mention" cost too much:
 * it refused `grep -rn git README.md` and `ls git-hooks/` outright, with no way for
 * the host to allow them. Measured on real data, 6 of 38 matches of the broad
 * pattern were that kind of phantom.
 *
 * isCriticalBash keeps the BROAD check on purpose, and the asymmetry is the point.
 * There, a false positive costs one card the host can answer, while a false negative
 * means auto mode runs git unattended — so it errs the other way. Here the failure
 * modes are reversed. And nothing is lost by anchoring: a git invocation this misses
 * still hits isCriticalBash and escalates to the host, so the peer never runs git
 * unattended either way.
 */
function isGitInvocation(command: string): boolean {
  return /(^|[\n;&|(]\s*|&&\s*|\|\|\s*)(\w+=\S*\s+)*git\b/i.test(command);
}

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
export function peerBashAllowed(rawCommand: string): PolicyResult {
  // Same reasoning as isCriticalBash: a guest writing a paragraph that mentions git
  // is not invoking git, and a refusal has no recourse at all.
  const command = withoutHeredocBodies(rawCommand);
  // ANY git, not just push. Narrowing this to push was the wrong shape: `git
  // remote set-url`, `git config credential.helper`, a `core.pager` that runs a
  // command, `git bundle` — the ways to push or to leak through git are not a
  // subcommand list. isGitCommand already carries that argument for auto mode.
  if (isGitInvocation(command)) {
    return { ok: false, reason: "git is host-only in a shared session" };
  }
  for (const re of CONSTRUCTED_EXEC_PATTERNS) {
    if (re.test(command)) {
      return { ok: false, reason: "running a constructed string (eval, sh -c, source) is host-only in a shared session" };
    }
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
  // The command, not the data it carries — see withoutHeredocBodies. A session
  // writing prose about `git push` and `rm -rf` raised a card per paragraph.
  const code = withoutHeredocBodies(command);
  if (isCriticalGit(code)) return true;
  for (const re of SECRET_PATTERNS) if (re.test(code)) return true;
  for (const re of ENV_DUMP_PATTERNS) if (re.test(code)) return true;
  for (const re of DESTRUCTIVE_PATTERNS) if (re.test(code)) return true;
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
  if (paths.length > 0) {
    // No cwd is NOT the same as nothing to worry about, and this used to skip the
    // whole check and fall through to `return false`. A slot lookup can miss — the
    // ~200ms window where `claude --resume` mints a new session_id and the registry
    // is still keyed on the old one, or an ask from a child whose slot is already
    // gone — and on a miss the callers pass cwd: null. The read fast-lane then
    // silently allowed ANY path with no card at all ("only an escape escalates",
    // except nothing can escape a workdir that isn't there): another session's
    // transcript, another session's scratch, /etc. The secret-path list above was
    // the only thing still standing. The MCP branch below has always failed closed
    // on a missing cwd; native tools now do the same.
    if (!cwd) return true;
    for (const target of paths) {
      if (!isPathWithinCwd(cwd, target)) return true;
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
