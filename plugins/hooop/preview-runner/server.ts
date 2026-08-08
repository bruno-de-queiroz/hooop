/**
 * Preview runner control API.
 *
 * AUTH MODEL: bearer token in `X-Runner-Token`, reached over a Unix domain
 * socket on a volume shared only with `agent-sandbox`. Exactly the same shape
 * as the dashboard↔sandbox hop, and for the same reason: holding the socket fd
 * is itself the privilege. Do NOT bind this to a TCP port — the container's one
 * TCP listener is the preview forwarder, which serves the app and nothing else.
 *
 * The socket directory is group `hooopctl` (gid 1101), not `hooop` (1100). That
 * mirrors the sandbox's own split and is load-bearing: the model's `agent` uid
 * is in `hooop` and deliberately not in `hooopctl`, so a model that can reach the
 * shared volume still cannot command a runner directly — which would otherwise
 * let it release another session's preview or lease a slot behind the
 * registry's back.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmodSync, chownSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { URL } from "node:url";
import { log } from "@shared/logger";
import { registerShutdown } from "@shared/shutdown";
import { validatePreviewSpec, PREVIEW_LIMITS } from "@shared/preview-spec";
import { Supervisor } from "./lib/supervisor";

const SLOT = parseInt(process.env.HOOOP_PREVIEW_SLOT ?? "1", 10) || 1;
const SOCKET_DIR = process.env.HOOOP_PREVIEW_SOCKET_DIR || "/var/run/hooop-preview";
const SOCKET_PATH = join(SOCKET_DIR, `runner-${SLOT}.sock`);
const TOKEN_FILE = join(SOCKET_DIR, `runner-${SLOT}.token`);
const WORKSPACE_DIR = process.env.HOOOP_WORKSPACE_DIR || "/workspace";
const SLOT_PORT = parseInt(process.env.HOOOP_PREVIEW_PORT ?? "", 10) || 7850 + SLOT - 1;
const SOCKET_GID = parseInt(process.env.HOOOP_PREVIEW_SOCKET_GID ?? "", 10) || 1101;
const CONFINE: "require" | "off" = process.env.HOOOP_PREVIEW_CONFINE === "require" ? "require" : "off";

const RUNNER_TOKEN_HEADER = "x-runner-token";
const MAX_BODY_BYTES = 64 * 1024;
const TOKEN_LEN_BYTES = 32;

const supervisor = new Supervisor({
  slot: SLOT,
  slotPort: SLOT_PORT,
  workspaceDir: WORKSPACE_DIR,
  homeDir: process.env.HOME || homedir(),
  confine: CONFINE,
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

let cachedToken: string | null = null;

function runnerToken(): string {
  if (cachedToken) return cachedToken;
  try {
    if (existsSync(TOKEN_FILE)) {
      const t = readFileSync(TOKEN_FILE, "utf-8").trim();
      if (t.length >= TOKEN_LEN_BYTES * 2) {
        cachedToken = t;
        return t;
      }
    }
  } catch { /* fall through and mint */ }

  const fresh = randomBytes(TOKEN_LEN_BYTES).toString("hex");
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, fresh, { mode: 0o640 });
    chmodSync(TOKEN_FILE, 0o640);
    try { chownSync(TOKEN_FILE, -1, SOCKET_GID); } catch { /* group absent outside Docker */ }
  } catch (err) {
    log.error("preview-runner", "failed to persist runner token", { err: String(err) });
  }
  cachedToken = fresh;
  return fresh;
}

function tokenMatches(presented: string | null): boolean {
  if (!presented) return false;
  const expected = runnerToken();
  if (presented.length !== expected.length) return false;
  try { return timingSafeEqual(Buffer.from(presented), Buffer.from(expected)); }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function fail(res: ServerResponse, status: number, error: string): void {
  json(res, status, { error });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error("payload too large"), { status: 413 });
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf-8");
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw Object.assign(new Error("invalid JSON body"), { status: 400 }); }
}

function header(req: IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === "string" ? v : null;
}

/**
 * Every mutating route is lease-scoped: the caller must present the leaseId
 * this slot is currently held under. Without it a stale request from a previous
 * lease — a retry that raced a release, say — could stop or rebuild the preview
 * that took its place.
 */
function requireLease(body: Record<string, unknown>, res: ServerResponse): string | null {
  const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
  if (!leaseId) { fail(res, 400, "missing required field: leaseId"); return null; }
  if (!supervisor.hasLease(leaseId)) { fail(res, 409, "this slot is not leased to that lease id"); return null; }
  return leaseId;
}

/**
 * Resolve the preview's cwd inside THIS container and refuse anything that
 * escapes the session's own directory.
 *
 * `rootRelative` is the session workdir expressed relative to the workspace
 * root — the sandbox sends it rather than us recomputing it from the session
 * id, because `claude --resume` remaps a session's id while its directory keeps
 * the name it was created under. Deriving the path from the CURRENT id would
 * therefore point at a directory that doesn't exist.
 *
 * We still don't trust it. The two independent rules below are what keep this a
 * real boundary rather than a courtesy: it must live under `sessions/`, and the
 * final path must stay inside it. The sandbox runs the equivalent check against
 * its own view of the filesystem first — `/home/agent/workspace/...` there and
 * `/workspace/...` here are the same bytes on the host but different strings,
 * so neither side can do the other's job.
 */
function resolveWorkdir(
  rootRelative: string,
  workdir: string | null | undefined,
): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (!rootRelative || isAbsolute(rootRelative) || rootRelative.split("/").some((s) => s === "..")) {
    return { ok: false, reason: "invalid session root" };
  }
  // A runner will only ever serve a per-session workdir. Anything else — a
  // `hooop mount` folder, the workspace root itself — is refused here even if
  // the sandbox somehow asked for it.
  if (!rootRelative.startsWith("sessions/")) {
    return { ok: false, reason: "previews only run over a session's own workspace" };
  }
  if (isAbsolute(workdir ?? "")) {
    return { ok: false, reason: "workdir must be relative to the session workspace" };
  }

  const root = resolve(join(WORKSPACE_DIR, rootRelative));
  const cwd = workdir ? resolve(join(root, workdir)) : root;
  if (cwd !== root && !cwd.startsWith(root + sep)) {
    return { ok: false, reason: "workdir escapes the session's workspace" };
  }
  if (!existsSync(cwd)) {
    return {
      ok: false,
      reason: `workdir does not exist in the workspace: ${workdir ?? "."}. If the project was just cloned, pass the clone's directory name as workdir.`,
    };
  }
  return { ok: true, cwd };
}

/** Pick a free loopback port for the app, inside this container's own netns. */
async function pickAppPort(): Promise<number | null> {
  const { appPortMin, appPortMax } = PREVIEW_LIMITS;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = appPortMin + Math.floor(Math.random() * (appPortMax - appPortMin + 1));
    if (await portFree(port)) return port;
  }
  return null;
}

function portFree(port: number): Promise<boolean> {
  return new Promise((res) => {
    const probe = createConnection({ host: "127.0.0.1", port });
    const done = (free: boolean) => { probe.destroy(); res(free); };
    probe.once("connect", () => done(false)); // something is already listening
    probe.once("error", () => done(true));
    probe.setTimeout(500, () => done(true));
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || "/", "http://runner.local");
  const path = url.pathname;
  const method = req.method ?? "GET";

  // Liveness only, unauthenticated — the Docker healthcheck has no token.
  // Leaks nothing beyond "this slot exists and is/isn't in use".
  if (method === "GET" && path === "/health") {
    return json(res, 200, { ok: true, slot: SLOT, leased: supervisor.leased });
  }

  if (!tokenMatches(header(req, RUNNER_TOKEN_HEADER))) {
    return fail(res, 401, "unauthorized");
  }

  if (method === "GET" && path === "/status") {
    return json(res, 200, supervisor.status());
  }

  if (method === "GET" && path === "/logs") {
    const stepParam = url.searchParams.get("step");
    if (stepParam === null) return json(res, 200, { logs: supervisor.allLogs() });
    const step = parseInt(stepParam, 10);
    if (!Number.isFinite(step)) return fail(res, 400, "step must be an integer");
    const entry = supervisor.logFor(step);
    return entry ? json(res, 200, { logs: [entry] }) : fail(res, 404, "no log for that step");
  }

  if (method !== "POST") return fail(res, 404, "not found");

  let body: Record<string, unknown>;
  try { body = await readJson(req); }
  catch (e: unknown) {
    const err = e as { status?: number; message?: string };
    return fail(res, err.status ?? 400, err.message ?? "bad request");
  }

  switch (path) {
    case "/lease": {
      const leaseId = typeof body.leaseId === "string" ? body.leaseId : "";
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!leaseId || !sessionId) return fail(res, 400, "missing required fields: leaseId, sessionId");
      const r = supervisor.acquire(leaseId, sessionId);
      return r.ok ? json(res, 200, { ok: true, slot: SLOT, slotPort: SLOT_PORT }) : fail(res, 409, r.reason);
    }

    case "/start": {
      const leaseId = requireLease(body, res);
      if (!leaseId) return;
      const parsed = validatePreviewSpec(body.spec);
      if (!parsed.ok) return fail(res, 400, parsed.reason);

      const rootRelative = typeof body.rootRelative === "string" ? body.rootRelative : "";
      const wd = resolveWorkdir(rootRelative, parsed.spec.workdir);
      if (!wd.ok) return fail(res, 400, wd.reason);

      const appPort = await pickAppPort();
      if (appPort === null) {
        return fail(res, 503, "could not find a free port for the app inside the runner");
      }

      const started = supervisor.start(parsed.spec, wd.cwd, appPort);
      if (!started.ok) return fail(res, 409, started.reason);
      return json(res, 200, { ok: true, appPort, slotPort: SLOT_PORT, cwd: wd.cwd });
    }

    case "/restart": {
      if (!requireLease(body, res)) return;
      const r = supervisor.restart();
      return r.ok ? json(res, 200, { ok: true }) : fail(res, 409, r.reason);
    }

    case "/rebuild": {
      if (!requireLease(body, res)) return;
      const r = supervisor.rebuild();
      return r.ok ? json(res, 200, { ok: true }) : fail(res, 409, r.reason);
    }

    case "/shared": {
      if (!requireLease(body, res)) return;
      supervisor.markShared(body.shared === true);
      return json(res, 200, { ok: true });
    }

    case "/stop": {
      if (!requireLease(body, res)) return;
      await supervisor.stop();
      return json(res, 200, { ok: true });
    }

    case "/release": {
      if (!requireLease(body, res)) return;
      await supervisor.release();
      json(res, 200, { ok: true });
      // Exit so Docker's `restart: unless-stopped` recreates the process tree
      // and the tmpfs. release() has already wiped the writable scratch, which
      // a restart alone would NOT do — see Supervisor.wipeScratch.
      setTimeout(() => process.exit(0), 50);
      return;
    }

    default:
      return fail(res, 404, "not found");
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * Probe an existing socket file before clobbering it — a live one means a
 * second supervisor is already serving this slot, which we must not race.
 * Same check the sandbox does; see sandbox/server.ts.
 */
function probeSocketAlive(socketPath: string, timeoutMs = 250): Promise<boolean> {
  return new Promise((res) => {
    const sock = createConnection({ path: socketPath });
    const timer = setTimeout(() => { sock.destroy(); res(false); }, timeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.destroy(); res(true); });
    sock.once("error", () => { clearTimeout(timer); res(false); });
  });
}

async function main(): Promise<void> {
  // Group-writable by default: the socket dir is shared with the sandbox.
  process.umask(0o002);

  // FIRST, before anything can be leased. A restart preserves the container's
  // writable layer, so this is what actually guarantees the next session starts
  // clean when the previous lease ended in a crash rather than a release.
  supervisor.wipeScratch();

  runnerToken();

  if (existsSync(SOCKET_PATH)) {
    if (await probeSocketAlive(SOCKET_PATH)) {
      log.fatal("preview-runner", "another supervisor is already serving this slot; refusing to clobber", { socket: SOCKET_PATH });
      process.exit(1);
    }
    try { unlinkSync(SOCKET_PATH); } catch { /* stale */ }
  }
  mkdirSync(dirname(SOCKET_PATH), { recursive: true });

  const server = createServer((req, res) => {
    void dispatch(req, res).catch((err) => {
      log.error("preview-runner", "handler failed", { err: String(err) });
      if (!res.headersSent) fail(res, 500, "handler failed");
      else { try { res.end(); } catch { /* ignore */ } }
    });
  });

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(SOCKET_PATH, () => {
      try {
        chmodSync(SOCKET_PATH, 0o660);
        chownSync(SOCKET_PATH, -1, SOCKET_GID);
      } catch { /* perms may not be settable in dev/test */ }
      log.info("preview-runner", "listening", { socket: SOCKET_PATH, slot: SLOT, slotPort: SLOT_PORT, confine: CONFINE });
      res();
    });
  });

  registerShutdown({
    graceMs: 8_000,
    logger: log,
    drainer: async (signal) => {
      log.info("preview-runner", "shutdown signal", { signal });
      server.closeAllConnections?.();
      await new Promise<void>((res) => server.close(() => res()));
      await supervisor.stop();
      supervisor.wipeScratch();
      log.info("preview-runner", "drained cleanly");
      process.exit(0);
    },
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err) => {
    log.fatal("preview-runner", "main crashed", { err: String(err) });
    process.exit(1);
  });
}
