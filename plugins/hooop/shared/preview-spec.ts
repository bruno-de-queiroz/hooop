/**
 * The preview spec — hooop's language-agnostic description of "how to bring
 * this project up".
 *
 * Shared by three packages, which is why it lives here: the SANDBOX validates
 * an incoming spec and stores it, the PREVIEW-RUNNER executes it, and the
 * DASHBOARD renders it back to the humans deciding whether to share it.
 *
 * Shape is deliberately Dockerfile-analogous, because that is the vocabulary
 * every runtime already has a mental model for, and because the model is
 * expected to DERIVE a spec from a repository it just read:
 *
 *   WORKDIR      → workdir
 *   ENV          → env
 *   RUN          → setup[]     (ordered, fail-fast, one log per step)
 *   EXPOSE       → (hooop assigns the port; see `port`)
 *   CMD          → run
 *   HEALTHCHECK  → readyPath / readyTimeoutSec
 *
 * Commands are FREE-FORM SHELL STRINGS and hooop passes them through verbatim.
 * It never appends `--host`, never rewrites a port flag, never guesses a
 * package manager. It doesn't need to: the runner's supervisor owns the only
 * 0.0.0.0 socket in its container and forwards to whatever loopback port the
 * app chose, so the usual "your dev server bound 127.0.0.1 and I can't reach
 * it" problem is solved at the socket layer rather than by mangling argv.
 */

/** How the app is told which port to listen on. */
export interface PreviewPortSpec {
  /**
   * Name of the environment variable the framework reads (`PORT`, `VITE_PORT`,
   * `FLASK_RUN_PORT`, `RAILS_PORT`, …). When omitted, `PORT` is still exported —
   * this only adds a second alias, for frameworks that insist on their own name.
   *
   * `$PORT` is additionally available for interpolation inside `run`/`setup`,
   * because the commands run through a shell.
   */
  env?: string | null;
  /**
   * The port the app ACTUALLY listens on, when it cannot be told.
   *
   * Everything above assumes the app honours `$PORT`. Plenty do not: a hardcoded
   * `listen(3000)`, a port baked into a config file, a binary with a compiled-in
   * default. For those the runner's assigned port is never bound, the readiness
   * probe polls a dead socket, and the preview fails with "the app did not
   * respond on port N" — which reads like a broken app rather than a port
   * mismatch. Naming the real port here makes the forwarder and the probe target
   * it instead of the assigned one.
   *
   * `PORT` is still exported (harmlessly) so a command that does interpolate
   * `$PORT` keeps working. Loopback vs 0.0.0.0 remains the runner's problem, not
   * yours — that is what the forwarder is for.
   */
  fixed?: number | null;
}

export interface PreviewSpec {
  /** Short human label shown in the dashboard. */
  name: string;
  /**
   * Directory to run in, RELATIVE to the session's own workdir. This is the
   * `git clone` case: an empty session that clones `foo/` sets workdir "foo".
   * Absolute paths and `..` are rejected — see validatePreviewSpec.
   */
  workdir?: string | null;
  /** Extra environment for every setup step and for `run`. */
  env?: Record<string, string> | null;
  /**
   * Ordered setup commands — the `RUN` lines. Executed once on start and again
   * on Rebuild, fail-fast: the first non-zero exit stops the sequence and the
   * preview reports which step failed, with its output.
   *
   * Keep these idempotent: every LEASE starts from a cold container, so a
   * preview that is stopped and started again re-runs them from scratch.
   */
  setup?: string[] | null;
  /** The long-lived service command — the `CMD` line. Required. */
  run: string;
  port?: PreviewPortSpec | null;
  /** Path polled to decide the app is actually serving. Defaults to "/". */
  readyPath?: string | null;
  /** How long to wait for readyPath before calling the start failed. */
  readyTimeoutSec?: number | null;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const PREVIEW_LIMITS = {
  /** Slots == concurrent previews == previewing sessions (one preview each). */
  slots: 3,
  maxNameLen: 80,
  maxWorkdirLen: 512,
  maxSetupSteps: 20,
  maxCommandLen: 8 * 1024,
  maxEnvVars: 64,
  maxEnvKeyLen: 128,
  maxEnvValueLen: 4 * 1024,
  maxReadyPathLen: 512,
  defaultReadyTimeoutSec: 120,
  maxReadyTimeoutSec: 900,
  /** Random per-preview app port range (inside the runner's own netns). */
  appPortMin: 20000,
  appPortMax: 29999,
} as const;

/** Env var names hooop sets itself; a spec may not override them. */
const RESERVED_ENV = new Set(["PORT", "HOST", "HOOOP_PREVIEW_ID", "HOOOP_PREVIEW_SLOT"]);

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type SpecValidation =
  | { ok: true; spec: PreviewSpec }
  | { ok: false; reason: string };

function badString(v: unknown, max: number): boolean {
  return typeof v !== "string" || v.length === 0 || v.length > max || v.includes("\0");
}

/**
 * Validate and normalize an untrusted spec.
 *
 * Deliberately NOT a parser: commands survive byte-for-byte. Everything here is
 * a bound or a structural check, so that "hooop never rewrites your command"
 * stays literally true. The one semantic rule is on `workdir`, which has to
 * stay inside the session's own directory — the caller resolves it against the
 * real workdir and re-checks, this just rejects the obvious escapes early.
 */
export function validatePreviewSpec(input: unknown): SpecValidation {
  if (!input || typeof input !== "object") return { ok: false, reason: "spec must be an object" };
  const raw = input as Record<string, unknown>;

  if (badString(raw.name, PREVIEW_LIMITS.maxNameLen)) {
    return { ok: false, reason: `name must be a non-empty string of at most ${PREVIEW_LIMITS.maxNameLen} characters` };
  }
  if (badString(raw.run, PREVIEW_LIMITS.maxCommandLen)) {
    return { ok: false, reason: "run is required: the command that starts the long-lived service (the Dockerfile CMD)" };
  }

  let workdir: string | null = null;
  if (raw.workdir != null) {
    if (badString(raw.workdir, PREVIEW_LIMITS.maxWorkdirLen)) {
      return { ok: false, reason: "workdir must be a short relative path" };
    }
    const w = (raw.workdir as string).trim();
    if (w.startsWith("/")) {
      return { ok: false, reason: "workdir must be RELATIVE to the session workspace, not an absolute path" };
    }
    if (w.split("/").some((seg) => seg === "..")) {
      return { ok: false, reason: "workdir must not contain '..'" };
    }
    workdir = w === "." || w === "" ? null : w.replace(/\/+$/, "");
  }

  let setup: string[] | null = null;
  if (raw.setup != null) {
    if (!Array.isArray(raw.setup)) return { ok: false, reason: "setup must be an array of shell commands" };
    if (raw.setup.length > PREVIEW_LIMITS.maxSetupSteps) {
      return { ok: false, reason: `setup has at most ${PREVIEW_LIMITS.maxSetupSteps} steps` };
    }
    for (const step of raw.setup) {
      if (badString(step, PREVIEW_LIMITS.maxCommandLen)) {
        return { ok: false, reason: "each setup step must be a non-empty shell command string" };
      }
    }
    setup = (raw.setup as string[]).slice();
  }

  let env: Record<string, string> | null = null;
  if (raw.env != null) {
    if (typeof raw.env !== "object" || Array.isArray(raw.env)) {
      return { ok: false, reason: "env must be an object of name → value" };
    }
    const entries = Object.entries(raw.env as Record<string, unknown>);
    if (entries.length > PREVIEW_LIMITS.maxEnvVars) {
      return { ok: false, reason: `env has at most ${PREVIEW_LIMITS.maxEnvVars} entries` };
    }
    env = {};
    for (const [k, v] of entries) {
      if (!ENV_KEY_RE.test(k) || k.length > PREVIEW_LIMITS.maxEnvKeyLen) {
        return { ok: false, reason: `invalid env variable name: ${k.slice(0, 40)}` };
      }
      if (RESERVED_ENV.has(k)) {
        return { ok: false, reason: `${k} is set by hooop and cannot be overridden in env (use port.env to add an alias)` };
      }
      if (typeof v !== "string" || v.length > PREVIEW_LIMITS.maxEnvValueLen || v.includes("\0")) {
        return { ok: false, reason: `invalid value for env variable ${k}` };
      }
      env[k] = v;
    }
  }

  let port: PreviewPortSpec | null = null;
  if (raw.port != null) {
    if (typeof raw.port !== "object" || Array.isArray(raw.port)) {
      return { ok: false, reason: "port must be an object like { env: \"PORT\" }" };
    }
    const pe = (raw.port as Record<string, unknown>).env;
    if (pe != null) {
      if (typeof pe !== "string" || !ENV_KEY_RE.test(pe) || pe.length > PREVIEW_LIMITS.maxEnvKeyLen) {
        return { ok: false, reason: "port.env must be an environment variable name" };
      }
      port = { env: pe };
    }
    const pf = (raw.port as Record<string, unknown>).fixed;
    if (pf != null) {
      // Unprivileged range only. Below 1024 the app could not bind it as the
      // runner's non-root user anyway, so accepting it would just defer the same
      // failure to a less obvious place.
      if (typeof pf !== "number" || !Number.isInteger(pf) || pf < 1024 || pf > 65535) {
        return { ok: false, reason: "port.fixed must be an integer between 1024 and 65535" };
      }
      port = { ...(port ?? {}), fixed: pf };
    }
  }

  let readyPath: string | null = null;
  if (raw.readyPath != null) {
    if (badString(raw.readyPath, PREVIEW_LIMITS.maxReadyPathLen)) {
      return { ok: false, reason: "readyPath must be a short URL path" };
    }
    const p = raw.readyPath as string;
    if (!p.startsWith("/")) return { ok: false, reason: "readyPath must start with '/'" };
    readyPath = p;
  }

  let readyTimeoutSec: number | null = null;
  if (raw.readyTimeoutSec != null) {
    const n = raw.readyTimeoutSec;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > PREVIEW_LIMITS.maxReadyTimeoutSec) {
      return { ok: false, reason: `readyTimeoutSec must be between 1 and ${PREVIEW_LIMITS.maxReadyTimeoutSec}` };
    }
    readyTimeoutSec = Math.floor(n);
  }

  return {
    ok: true,
    spec: {
      name: (raw.name as string).trim(),
      run: raw.run as string,
      ...(workdir ? { workdir } : {}),
      ...(setup ? { setup } : {}),
      ...(env ? { env } : {}),
      ...(port ? { port } : {}),
      ...(readyPath ? { readyPath } : {}),
      ...(readyTimeoutSec ? { readyTimeoutSec } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime state (shared vocabulary between runner, sandbox and dashboard)
// ---------------------------------------------------------------------------

/**
 * Where a preview is in its lifecycle.
 *
 *   starting — setup steps and/or waiting for readyPath
 *   running  — serving, reachable by the HOST only (local port, no tunnel)
 *   shared   — additionally tunnelled, reachable by this session's participants
 *   failed   — a setup step exited non-zero, or the app never became ready
 *   stopped  — deliberately stopped; the slot is being released
 */
export type PreviewState = "starting" | "running" | "shared" | "failed" | "stopped";

/** Which command is executing right now. `index` is the 0-based setup step. */
export interface PreviewPhase {
  kind: "setup" | "run" | "idle";
  index?: number;
  /** The command itself, so the UI and the model can name it without guessing. */
  command?: string;
}

/** One captured command's output. `step` is -1 for the `run` command. */
export interface PreviewLog {
  step: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
}

/** Runner-side view of a preview, returned by /status. */
export interface PreviewRunnerStatus {
  slot: number;
  leaseId: string | null;
  sessionId: string | null;
  state: PreviewState;
  phase: PreviewPhase;
  appPort: number | null;
  /** Set when state is "failed": the step that broke, -1 for the run command. */
  failedStep: number | null;
  failureReason: string | null;
}
