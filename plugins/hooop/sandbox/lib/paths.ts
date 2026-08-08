import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const STATE_DIR = join(homedir(), ".claude", "hooop");
export const EVENTS_FILE = join(STATE_DIR, "events.jsonl");
export const DB_PATH = join(STATE_DIR, "events.db");
// (DASHBOARD_PID / DASHBOARD_LOG used to sit here and were never read by the
// sandbox — the dashboard has its own copy in dashboard/lib/paths.ts.)
export const CLAUDE_SESSIONS_DIR = join(homedir(), ".claude", "sessions");
export const CLAUDE_SKILLS_DIR = join(homedir(), ".claude", "skills");
// The agent's default session workdir. Project-level skills/commands live at
// `<cwd>/.claude/skills`. Historically all dashboard sessions shared this one
// cwd; each session now gets its own private dir under SESSIONS_ROOT (below).
export const WORKSPACE_DIR = join(homedir(), "workspace");

// Per-session private workspaces live under WORKSPACE_DIR/sessions/<sessionId>.
// Namespacing under `sessions/` guarantees these can never collide with a
// `hooop mount` folder (mounted at WORKSPACE_DIR/<name>), and gives the delete
// path + the Landlock policy a single, unambiguous root to reason about.
export const SESSIONS_ROOT = join(WORKSPACE_DIR, "sessions");

/** Absolute path to a session's own private workdir. */
export function sessionWorkdir(sessionId: string): string {
  return join(SESSIONS_ROOT, sessionId);
}

/**
 * The two Unix sockets the sandbox server listens on.
 *
 * CONTROL_SOCKET lives on the volume shared with the dashboard container and
 * carries every state-mutating route. HOOK_SOCKET is container-local and
 * carries only /permission-ask, /permission-wait and /ingest.
 *
 * They live here rather than in server.ts because active-sessions has to
 * inject HOOK_SOCKET into the claude child's environment: the hook scripts
 * read HOOOP_SANDBOX_SOCKET, so pointing that variable at the hook socket for
 * the child is what keeps permission-gate.sh working without the scripts
 * knowing a split happened — and, more importantly, without the model's
 * process tree being handed the path to the control plane.
 */
export const CONTROL_SOCKET = process.env.HOOOP_SANDBOX_SOCKET || "/var/run/hooop/sandbox.sock";
export const HOOK_SOCKET = process.env.HOOOP_HOOK_SOCKET || "/run/hooop-hooks/hook.sock";

/**
 * The two token files, deliberately one per plane and one per filesystem.
 *
 * SANDBOX_TOKEN_FILE sits beside the control socket on the shared volume, in a
 * directory the model's uid cannot traverse (0750 hooopd:hooopctl).
 *
 * HOOK_TOKEN_FILE sits beside the hook socket, NOT in the profile where it used
 * to live. That move is load-bearing rather than tidy: on macOS Docker Desktop
 * the profile is a virtiofs bind mount that does not enforce DAC at all — a 0600
 * file there is readable by every uid in the container, measured directly — so a
 * mode on a token stored there is decorative on the most common dev platform.
 * Both of these paths are real Linux filesystems (a named volume and container
 * overlayfs), so their modes are enforced identically on macOS and Linux.
 */
export const SANDBOX_TOKEN_FILE = process.env.HOOOP_SANDBOX_TOKEN_FILE
  || join(dirname(CONTROL_SOCKET), "sandbox.token");
export const HOOK_TOKEN_FILE = process.env.HOOOP_HOOK_TOKEN_FILE
  || join(dirname(HOOK_SOCKET), "hook.token");

/**
 * Helper that re-enters the model's uid, for the work that must belong to
 * `agent` rather than to the server: spawning claude, `git clone`, the `!bash`
 * fast lane, session workdirs, and signalling claude (kill(2) permission is not
 * inherited from the parent/child relationship, so the server cannot signal its
 * own agent-uid child). See landlock/hooop-as-agent.c.
 *
 * Unset outside the container — callers must treat "no helper" as "run inline",
 * because a local checkout has no setuid binary and tests must still pass.
 */
export const AS_AGENT = process.env.HOOOP_AS_AGENT || "";

// Embedding dimension. Default matches OpenAI text-embedding-3-small.
// If you switch to a smaller local model (e.g. Ollama nomic-embed-text = 768,
// bge-small = 384), set EMBED_DIM in hooop.env and re-run setup so the
// vec0 virtual table is recreated with the right dim.
export const EMBED_DIM = parseInt(process.env.EMBED_DIM ?? "1536", 10) || 1536;
