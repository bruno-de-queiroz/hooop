/**
 * The preview supervisor: one leased session's spec, executed and kept alive.
 *
 * Runs inside the preview-runner container, which is deliberately the least
 * privileged thing in the hooop stack — no claude, no `~/.claude`, no control
 * socket, and no route to `agent-sandbox`. Everything here operates on a single
 * lease at a time, because a slot is leased to exactly one session.
 *
 * Two responsibilities that are easy to conflate:
 *
 *   1. EXECUTING THE SPEC. Setup steps in order, fail-fast, one captured log
 *      each; then the long-lived run command. Commands are passed to a shell
 *      verbatim — hooop never rewrites them (see shared/preview-spec.ts).
 *
 *   2. OWNING THE ONLY 0.0.0.0 SOCKET. The app is free to bind loopback on
 *      whatever port it likes (vite, next dev, flask run and rails s all default
 *      to loopback), and the forwarder bridges the fixed, publishable container
 *      port to it. That is what makes "never rewrite the command" possible: no
 *      `--host` flag to inject, and the externally visible port is decoupled
 *      from the app's.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { request as httpRequest } from "node:http";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { log } from "@shared/logger";
import {
  PREVIEW_LIMITS,
  type PreviewLog,
  type PreviewPhase,
  type PreviewRunnerStatus,
  type PreviewSpec,
  type PreviewState,
} from "@shared/preview-spec";
import { wrapWithLandlock, HOOOP_SANDBOX_EXEC } from "@sandbox/lib/landlock-policy";

/** -1 identifies the long-lived `run` command in the per-step log map. */
export const RUN_STEP = -1;

const STDOUT_CAP = 64 * 1024;
const STDERR_CAP = 16 * 1024;
/** A single setup step that never returns is a hung preview; bound it. */
const SETUP_STEP_TIMEOUT_MS = 15 * 60_000;
const READY_POLL_INTERVAL_MS = 250;

export interface SupervisorOptions {
  slot: number;
  /** Fixed, publishable container port this slot forwards on. */
  slotPort: number;
  /** Absolute path of the bind-mounted workspace root inside this container. */
  workspaceDir: string;
  /** The runner user's home; wiped between leases. */
  homeDir: string;
  /** Scratch dir wiped alongside HOME. Defaults to TMPDIR (a tmpfs in-image). */
  tmpDir?: string;
  /**
   * "require" refuses to run anything when the Landlock wrapper is missing.
   * The container sets this; a local checkout leaves it off so tests can run.
   */
  confine: "require" | "off";
  /** Injectable for tests. */
  now?: () => number;
}

interface Lease {
  leaseId: string;
  sessionId: string;
  spec: PreviewSpec;
  /** Absolute, already-validated cwd for every command. */
  cwd: string;
  appPort: number;
}

export class Supervisor {
  private readonly opts: SupervisorOptions;
  private lease: Lease | null = null;
  private state: PreviewState = "stopped";
  private phase: PreviewPhase = { kind: "idle" };
  private logs = new Map<number, PreviewLog>();
  private child: ChildProcess | null = null;
  private forwarder: Server | null = null;
  private openSockets = new Set<Socket>();
  private failedStep: number | null = null;
  private failureReason: string | null = null;
  /**
   * Bumped on every stop/start/restart/rebuild. An async execution compares it
   * before each transition and bails if it changed, so a Rebuild issued while a
   * previous run is mid-`npm install` cannot have the old sequence resurrect
   * itself and overwrite the new one's state.
   */
  private generation = 0;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
  }

  // -------------------------------------------------------------------------
  // Lease lifecycle
  // -------------------------------------------------------------------------

  /**
   * Claim this slot for a session. Idempotent for the same leaseId so a retried
   * request can't wipe a live preview; a DIFFERENT leaseId is refused rather
   * than silently evicting whoever is already here.
   */
  acquire(leaseId: string, sessionId: string): { ok: true } | { ok: false; reason: string } {
    if (this.lease && this.lease.leaseId !== leaseId) {
      return { ok: false, reason: `slot ${this.opts.slot} is already leased` };
    }
    if (!this.lease) {
      this.lease = { leaseId, sessionId, spec: null as unknown as PreviewSpec, cwd: "", appPort: 0 };
      this.resetState();
    }
    return { ok: true };
  }

  hasLease(leaseId: string): boolean {
    return this.lease?.leaseId === leaseId;
  }

  get leased(): boolean {
    return this.lease !== null;
  }

  /**
   * Tear the lease down and wipe everything this session left behind.
   *
   * The caller then exits the process so Docker's `restart: unless-stopped`
   * brings the container back. That restart alone is NOT enough to guarantee a
   * clean slot — a restart preserves the container's writable layer — which is
   * exactly why the wipe happens here (and again in `wipeScratch` at boot, for
   * the crash that never reached this path).
   */
  async release(): Promise<void> {
    await this.stop();
    this.lease = null;
    this.wipeScratch();
  }

  // -------------------------------------------------------------------------
  // Spec execution
  // -------------------------------------------------------------------------

  /**
   * Begin executing a spec. Returns as soon as the work is SCHEDULED — setup
   * can legitimately take minutes, and the caller (the sandbox) polls `status`.
   */
  start(spec: PreviewSpec, cwd: string, appPort: number): { ok: true } | { ok: false; reason: string } {
    if (!this.lease) return { ok: false, reason: "slot is not leased" };
    const confineError = this.confinementError();
    if (confineError) return { ok: false, reason: confineError };

    // A spec that names the app's REAL port overrides the one we picked. Applied
    // here, at the single place the lease records it, so everything downstream
    // follows without further branching: the exported PORT, the readiness probe,
    // the forwarder's target and the reported status all read lease.appPort.
    //
    // Without this an app that ignores $PORT — a hardcoded listen(3000), a port
    // in a config file, a compiled-in default — binds a port nothing watches,
    // and the preview fails as "the app did not respond on port <assigned>",
    // which looks like a broken app instead of a port mismatch.
    this.lease = { ...this.lease, spec, cwd, appPort: spec.port?.fixed ?? appPort };
    this.ensureForwarder();
    void this.execute("full");
    return { ok: true };
  }

  /** Respawn the run command only. */
  restart(): { ok: true } | { ok: false; reason: string } {
    if (!this.lease?.spec) return { ok: false, reason: "nothing to restart: no preview has been started" };
    const confineError = this.confinementError();
    if (confineError) return { ok: false, reason: confineError };
    void this.execute("run-only");
    return { ok: true };
  }

  /** Re-run every setup step, then respawn the run command. */
  rebuild(): { ok: true } | { ok: false; reason: string } {
    if (!this.lease?.spec) return { ok: false, reason: "nothing to rebuild: no preview has been started" };
    const confineError = this.confinementError();
    if (confineError) return { ok: false, reason: confineError };
    void this.execute("full");
    return { ok: true };
  }

  /** Kill the child and stop serving, keeping the lease. */
  async stop(): Promise<void> {
    this.generation += 1;
    await this.killChild();
    this.closeForwarder();
    this.state = "stopped";
    this.phase = { kind: "idle" };
  }

  private async execute(mode: "full" | "run-only"): Promise<void> {
    const lease = this.lease;
    if (!lease?.spec) return;

    // Flip to "starting" SYNCHRONOUSLY, before the first await. start/restart/
    // rebuild all return as soon as the work is scheduled, so a caller that
    // polls status immediately afterwards would otherwise still read the
    // previous run's "running" and conclude the rebuild had already finished.
    this.generation += 1;
    const gen = this.generation;
    this.state = "starting";
    this.phase = { kind: "idle" };
    this.failedStep = null;
    this.failureReason = null;
    this.logs.clear();

    await this.killChild();
    if (gen !== this.generation) return;

    const steps = mode === "full" ? lease.spec.setup ?? [] : [];
    for (let i = 0; i < steps.length; i += 1) {
      if (gen !== this.generation) return; // superseded
      this.phase = { kind: "setup", index: i, command: steps[i] };
      const result = await this.runToCompletion(i, steps[i], lease);
      if (gen !== this.generation) return;
      if (result.exitCode !== 0) {
        this.state = "failed";
        this.failedStep = i;
        this.failureReason =
          result.timedOut
            ? `setup step ${i + 1} timed out after ${Math.round(SETUP_STEP_TIMEOUT_MS / 60_000)} minutes`
            : `setup step ${i + 1} exited ${result.exitCode}`;
        this.phase = { kind: "idle" };
        return;
      }
    }

    if (gen !== this.generation) return;
    this.spawnRun(lease, gen);

    const readyTimeoutMs =
      (lease.spec.readyTimeoutSec ?? PREVIEW_LIMITS.defaultReadyTimeoutSec) * 1000;
    const ready = await this.waitForReady(lease, gen, readyTimeoutMs);
    if (gen !== this.generation) return;

    if (ready) {
      // Only promote out of "starting" — a share may already have moved this to
      // "shared", and the runner is not the authority on that.
      if (this.state === "starting") this.state = "running";
      return;
    }

    this.state = "failed";
    this.failedStep = RUN_STEP;
    this.failureReason = this.child?.exitCode != null
      ? `the run command exited ${this.child.exitCode} before serving`
      : `the app did not respond on port ${lease.appPort} within ${Math.round(readyTimeoutMs / 1000)}s`;
  }

  /** Run one setup step to completion, capturing its output. */
  private runToCompletion(
    step: number,
    command: string,
    lease: Lease,
  ): Promise<{ exitCode: number | null; timedOut: boolean }> {
    return new Promise((resolveStep) => {
      const entry = this.freshLog(step, command);
      const child = this.spawnCommand(command, lease);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }, SETUP_STEP_TIMEOUT_MS);

      this.pipeInto(child, entry);
      const finish = (code: number | null) => {
        clearTimeout(timer);
        entry.exitCode = timedOut ? null : code;
        resolveStep({ exitCode: timedOut ? 1 : code, timedOut });
      };
      child.once("close", (code) => finish(code));
      child.once("error", (err) => {
        entry.stderr += `\nhooop: could not run this step: ${String(err?.message ?? err)}\n`;
        finish(1);
      });
    });
  }

  private spawnRun(lease: Lease, gen: number): void {
    const entry = this.freshLog(RUN_STEP, lease.spec.run);
    this.phase = { kind: "run", command: lease.spec.run };
    const child = this.spawnCommand(lease.spec.run, lease);
    this.child = child;
    this.pipeInto(child, entry);

    child.once("close", (code) => {
      entry.exitCode = code;
      if (gen !== this.generation) return; // superseded by a restart/stop
      this.child = null;
      // A run command that exits on its own is a failure whenever we thought we
      // were serving. Saying so beats leaving the UI on "running" against a
      // dead process.
      if (this.state === "running" || this.state === "shared" || this.state === "starting") {
        this.state = "failed";
        this.failedStep = RUN_STEP;
        this.failureReason = `the run command exited ${code}`;
        this.phase = { kind: "idle" };
      }
    });
    child.once("error", (err) => {
      entry.stderr += `\nhooop: could not run the run command: ${String(err?.message ?? err)}\n`;
    });
  }

  /**
   * Spawn one shell command inside the Landlock confinement.
   *
   * `bash -lc` because specs are written the way a human would type them, and
   * because a login shell picks up whatever the setup steps installed into the
   * profile (mise shims, corepack, `~/.local/bin`).
   */
  private spawnCommand(command: string, lease: Lease): ChildProcess {
    const wrapped = wrapWithLandlock("preview", lease.cwd, "bash", ["-lc", command]);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...wrapped.env,
      ...(lease.spec.env ?? {}),
      PORT: String(lease.appPort),
      HOOOP_PREVIEW_ID: lease.leaseId,
      HOOOP_PREVIEW_SLOT: String(this.opts.slot),
    };
    // An alias for frameworks that read their own variable name. Applied after
    // the spec's own env so it can't be shadowed into pointing elsewhere.
    const alias = lease.spec.port?.env;
    if (alias) env[alias] = String(lease.appPort);

    return spawn(wrapped.file, wrapped.args, {
      cwd: lease.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      // Its own process group, so killing a dev server takes its children
      // (webpack workers, esbuild, a spawned API) with it rather than orphaning
      // them to hold the port open against the next start.
      detached: true,
    });
  }

  /**
   * Refuse to run anything unconfined when the image says confinement is
   * required. Same fail-closed reasoning as HOOOP_BASH_CONFINE in the sandbox:
   * an unconfined preview looks identical to a confined one from the outside,
   * so the only safe response to a missing wrapper is to stop.
   */
  private confinementError(): string | null {
    if (this.opts.confine !== "require") return null;
    if (existsSync(HOOOP_SANDBOX_EXEC)) return null;
    return `refusing to start: the Landlock wrapper is missing at ${HOOOP_SANDBOX_EXEC}, so this preview could not be confined to its own session's workspace`;
  }

  // -------------------------------------------------------------------------
  // Readiness
  // -------------------------------------------------------------------------

  /**
   * Poll until the app answers. Any HTTP status counts — a 404 on `/` still
   * proves something is listening and speaking HTTP, and demanding a 2xx would
   * fail every app whose root route legitimately redirects or 404s.
   */
  private async waitForReady(lease: Lease, gen: number, timeoutMs: number): Promise<boolean> {
    const deadline = (this.opts.now?.() ?? Date.now()) + timeoutMs;
    const path = lease.spec.readyPath ?? "/";
    while ((this.opts.now?.() ?? Date.now()) < deadline) {
      if (gen !== this.generation) return false;
      // A run command that already exited will never become ready; fail now
      // rather than burning the whole readiness budget.
      if (this.child === null && this.state === "starting") return false;
      if (await probeHttp(lease.appPort, path)) return true;
      await sleep(READY_POLL_INTERVAL_MS);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Port forwarding
  // -------------------------------------------------------------------------

  /**
   * Bind the fixed slot port once and keep it bound for the life of the lease.
   *
   * Resolving the target at CONNECT time (rather than capturing it) means a
   * restart or rebuild doesn't need to re-bind, and a request arriving while
   * the app is down is closed cleanly instead of hitting a refused connection
   * on a port that vanished.
   */
  private ensureForwarder(): void {
    if (this.forwarder) return;
    const server = createServer((client) => {
      this.openSockets.add(client);
      client.once("close", () => this.openSockets.delete(client));

      const target = this.lease?.appPort;
      const serving = this.state === "running" || this.state === "shared";
      if (!target || !serving) {
        client.destroy();
        return;
      }
      const upstream = createConnection({ host: "127.0.0.1", port: target });
      this.openSockets.add(upstream);
      upstream.once("close", () => this.openSockets.delete(upstream));
      // Raw byte piping in both directions: this carries plain HTTP and a
      // WebSocket upgrade identically, so an app that ships a working HMR
      // socket keeps it.
      client.pipe(upstream);
      upstream.pipe(client);
      const drop = () => { client.destroy(); upstream.destroy(); };
      client.once("error", drop);
      upstream.once("error", drop);
    });
    server.on("error", (err) => {
      log.error("preview-runner", "forwarder failed", { slot: this.opts.slot, err: String(err) });
    });
    server.listen(this.opts.slotPort, "0.0.0.0", () => {
      log.info("preview-runner", "forwarding", { slot: this.opts.slot, port: this.opts.slotPort });
    });
    this.forwarder = server;
  }

  private closeForwarder(): void {
    for (const s of this.openSockets) { try { s.destroy(); } catch { /* ignore */ } }
    this.openSockets.clear();
    if (this.forwarder) {
      try { this.forwarder.close(); } catch { /* ignore */ }
      this.forwarder = null;
    }
  }

  // -------------------------------------------------------------------------
  // Scratch
  // -------------------------------------------------------------------------

  /**
   * Empty the runner's HOME and temp dir.
   *
   * Called on lease release AND on boot. The boot pass is the one that actually
   * carries the guarantee: `restart: unless-stopped` preserves the container's
   * writable layer, so a container that crashed — or was restarted for any
   * reason that skipped `release` — would otherwise hand the next session the
   * previous one's downloads, caches and stray files.
   *
   * Never touches the workspace: that is the bind mount, it belongs to the
   * session, and `node_modules`/`.venv`/`target` living there is exactly why a
   * cold lease is cheaper than it sounds.
   */
  wipeScratch(): void {
    const workspace = resolve(this.opts.workspaceDir);
    const targets = [
      resolve(this.opts.homeDir),
      resolve(this.opts.tmpDir ?? process.env.TMPDIR ?? "/tmp"),
    ];

    for (const dir of targets) {
      // Refuse rather than risk it. A scratch dir that IS, or CONTAINS, the
      // workspace would recursively delete the session's project — the one
      // thing in this container that isn't disposable. Checked per target, so
      // a bad TMPDIR can't ride in on a good HOME.
      if (dir === "/" || dir === "" || dir === workspace || workspace.startsWith(dir + sep)) {
        log.error("preview-runner", "refusing to wipe a scratch dir that overlaps the workspace", { dir, workspace });
        continue;
      }
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const name of entries) {
        try { rmSync(join(dir, name), { recursive: true, force: true }); }
        catch (err) { log.debug("preview-runner", "could not remove scratch entry", { path: join(dir, name), err: String(err) }); }
      }
    }
  }

  // -------------------------------------------------------------------------
  // Introspection
  // -------------------------------------------------------------------------

  status(): PreviewRunnerStatus {
    return {
      slot: this.opts.slot,
      leaseId: this.lease?.leaseId ?? null,
      sessionId: this.lease?.sessionId ?? null,
      state: this.state,
      phase: this.phase,
      appPort: this.lease?.appPort || null,
      failedStep: this.failedStep,
      failureReason: this.failureReason,
    };
  }

  /** All captured logs, ordered with the run command last. */
  allLogs(): PreviewLog[] {
    return [...this.logs.values()].sort((a, b) => {
      if (a.step === RUN_STEP) return 1;
      if (b.step === RUN_STEP) return -1;
      return a.step - b.step;
    });
  }

  logFor(step: number): PreviewLog | null {
    return this.logs.get(step) ?? null;
  }

  /** Mark the preview as tunnelled. The sandbox owns this fact; we only echo it. */
  markShared(shared: boolean): void {
    if (shared && this.state === "running") this.state = "shared";
    else if (!shared && this.state === "shared") this.state = "running";
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private resetState(): void {
    this.state = "stopped";
    this.phase = { kind: "idle" };
    this.logs.clear();
    this.failedStep = null;
    this.failureReason = null;
  }

  private freshLog(step: number, command: string): PreviewLog {
    const entry: PreviewLog = { step, command, stdout: "", stderr: "", exitCode: null, truncated: false };
    this.logs.set(step, entry);
    return entry;
  }

  private pipeInto(child: ChildProcess, entry: PreviewLog): void {
    child.stdout?.on("data", (c: Buffer) => {
      const next = entry.stdout + c.toString("utf-8");
      if (next.length > STDOUT_CAP) {
        entry.stdout = next.slice(next.length - STDOUT_CAP);
        entry.truncated = true;
      } else entry.stdout = next;
    });
    child.stderr?.on("data", (c: Buffer) => {
      const next = entry.stderr + c.toString("utf-8");
      if (next.length > STDERR_CAP) {
        entry.stderr = next.slice(next.length - STDERR_CAP);
        entry.truncated = true;
      } else entry.stderr = next;
    });
  }

  /**
   * Kill the run command and everything it spawned.
   *
   * Negative pid targets the process GROUP (the child was spawned detached), so
   * a dev server's workers die with it. Without that, an orphan keeps the app
   * port bound and the next start fails with EADDRINUSE for reasons that look
   * like nothing to do with the restart that caused them.
   */
  private async killChild(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode != null || child.signalCode != null) return;
    const pid = child.pid;
    const signalGroup = (sig: NodeJS.Signals) => {
      try { if (pid) process.kill(-pid, sig); }
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };
    const exited = new Promise<void>((res) => child.once("close", () => res()));
    signalGroup("SIGTERM");
    const escalation = setTimeout(() => signalGroup("SIGKILL"), 5_000);
    await Promise.race([exited, sleep(8_000)]);
    clearTimeout(escalation);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/** True when something answers HTTP on this loopback port. */
function probeHttp(port: number, path: string): Promise<boolean> {
  return new Promise((res) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", timeout: 2_000 },
      (response) => { response.resume(); res(true); },
    );
    req.on("error", () => res(false));
    req.on("timeout", () => { req.destroy(); res(false); });
    req.end();
  });
}
