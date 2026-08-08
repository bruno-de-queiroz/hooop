import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { request as httpRequest } from "node:http";

vi.mock("@shared/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { Supervisor, RUN_STEP } from "./supervisor";

let root: string;
let workspace: string;
let home: string;
let scratch: string;
let sessionDir: string;
const SESSION_ID = "sess-a";
let slotPort: number;
let sup: Supervisor | null = null;

// Each test gets its own slot port so a lingering forwarder from a previous
// test can never make the next one fail with EADDRINUSE.
let nextPort = 21500 + Math.floor(Math.random() * 2000);

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "preview-runner-test-")));
  workspace = join(root, "workspace");
  home = join(root, "home");
  // A scratch dir of our own: wipeScratch empties TMPDIR, and pointing it at
  // the real /tmp would delete this test's own fixtures out from under it.
  scratch = join(root, "scratch");
  sessionDir = join(workspace, "sessions", SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(scratch, { recursive: true });
  slotPort = nextPort++;
});

afterEach(async () => {
  if (sup) { await sup.stop(); sup = null; }
  rmSync(root, { recursive: true, force: true });
});

function makeSupervisor(overrides: Partial<ConstructorParameters<typeof Supervisor>[0]> = {}) {
  sup = new Supervisor({
    slot: 1,
    slotPort,
    workspaceDir: workspace,
    homeDir: home,
    tmpDir: scratch,
    // The Landlock helper isn't present in a local checkout; "off" is what a
    // dev/test environment uses (the image sets "require").
    confine: "off",
    ...overrides,
  });
  return sup;
}

/** Wait until `check` holds, or throw. Keeps the async state machine testable. */
async function until(check: () => boolean, timeoutMs = 15_000, label = "condition"): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** A `run` command that serves HTTP on $PORT until killed. */
const SERVE = `node -e "require('http').createServer((q,s)=>{s.writeHead(200);s.end('hello from preview')}).listen(process.env.PORT,'127.0.0.1')"`;

function startPreview(s: Supervisor, spec: Record<string, unknown>, appPort: number) {
  const acquired = s.acquire("lease-1", SESSION_ID);
  expect(acquired.ok).toBe(true);
  return s.start(spec as never, sessionDir, appPort);
}

describe("lease handling", () => {
  it("is idempotent for the same lease id and refuses a different one", () => {
    const s = makeSupervisor();
    expect(s.acquire("lease-1", SESSION_ID).ok).toBe(true);
    expect(s.acquire("lease-1", SESSION_ID).ok).toBe(true);

    // Evicting a live preview because a second caller asked would lose someone
    // else's running app; refuse instead.
    const other = s.acquire("lease-2", "sess-b");
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.reason).toContain("already leased");
  });

  it("reports the leasing session in status", () => {
    const s = makeSupervisor();
    s.acquire("lease-1", SESSION_ID);
    expect(s.status()).toMatchObject({ slot: 1, leaseId: "lease-1", sessionId: SESSION_ID });
  });
});

describe("spec execution", () => {
  it("runs setup steps in order and captures a log per step", async () => {
    const s = makeSupervisor();
    startPreview(s, {
      name: "t",
      setup: [`echo one > ${join(sessionDir, "a.txt")}`, `echo two > ${join(sessionDir, "b.txt")}`],
      run: SERVE,
      readyTimeoutSec: 20,
    }, nextPort++);

    await until(() => s.status().state === "running", 20_000, "running");

    expect(existsSync(join(sessionDir, "a.txt"))).toBe(true);
    expect(existsSync(join(sessionDir, "b.txt"))).toBe(true);
    const logs = s.allLogs();
    expect(logs.map((l) => l.step)).toEqual([0, 1, RUN_STEP]);
    expect(logs[0].exitCode).toBe(0);
  });

  it("fails fast: a broken step 2 stops the sequence and names it", async () => {
    const s = makeSupervisor();
    const marker = join(sessionDir, "should-not-exist.txt");
    startPreview(s, {
      name: "t",
      setup: ["true", "exit 3", `touch ${marker}`],
      run: SERVE,
    }, nextPort++);

    await until(() => s.status().state === "failed", 15_000, "failed");

    const st = s.status();
    expect(st.failedStep).toBe(1);
    expect(st.failureReason).toContain("exited 3");
    // The third step must NOT have run.
    expect(existsSync(marker)).toBe(false);
    // …and the failing step's log is available for the model to read back.
    expect(s.logFor(1)).not.toBeNull();
  });

  it("captures stderr from a failing step so the reason isn't a mystery", async () => {
    const s = makeSupervisor();
    startPreview(s, { name: "t", setup: ["echo 'boom: no such module' >&2; exit 1"], run: SERVE }, nextPort++);
    await until(() => s.status().state === "failed", 15_000, "failed");
    expect(s.logFor(0)?.stderr).toContain("boom: no such module");
  });

  it("reports failure when the run command never serves", async () => {
    const s = makeSupervisor();
    startPreview(s, { name: "t", run: "sleep 30", readyTimeoutSec: 2 }, nextPort++);
    await until(() => s.status().state === "failed", 20_000, "failed");
    expect(s.status().failedStep).toBe(RUN_STEP);
    expect(s.status().failureReason).toMatch(/did not respond/);
  });

  it("reports failure promptly when the run command exits immediately", async () => {
    const s = makeSupervisor();
    // Without the early-exit check in waitForReady this would burn the whole
    // readiness budget before admitting the process is gone.
    startPreview(s, { name: "t", run: "exit 7", readyTimeoutSec: 60 }, nextPort++);
    await until(() => s.status().state === "failed", 15_000, "failed");
    expect(s.status().failedStep).toBe(RUN_STEP);
  });
});

describe("environment", () => {
  it("exports PORT, the port.env alias, and the spec's own env", async () => {
    const s = makeSupervisor();
    const out = join(sessionDir, "env.txt");
    const appPort = nextPort++;
    startPreview(s, {
      name: "t",
      setup: [`printf '%s|%s|%s' "$PORT" "$VITE_PORT" "$MY_FLAG" > ${out}`],
      run: SERVE,
      port: { env: "VITE_PORT" },
      env: { MY_FLAG: "on" },
      readyTimeoutSec: 20,
    }, appPort);

    await until(() => s.status().state === "running", 20_000, "running");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(out, "utf-8")).toBe(`${appPort}|${appPort}|on`);
  });
});

describe("port forwarding", () => {
  it("serves the app on the fixed slot port while the app binds loopback", async () => {
    const s = makeSupervisor();
    // The app binds 127.0.0.1 only — the case that motivates the forwarder.
    startPreview(s, { name: "t", run: SERVE, readyTimeoutSec: 20 }, nextPort++);
    await until(() => s.status().state === "running", 20_000, "running");

    const body = await new Promise<string>((res, rej) => {
      const req = httpRequest({ host: "127.0.0.1", port: slotPort, path: "/", timeout: 5000 }, (r) => {
        let b = ""; r.setEncoding("utf-8");
        r.on("data", (c) => { b += c; });
        r.on("end", () => res(b));
      });
      req.on("error", rej);
      req.on("timeout", () => { req.destroy(); rej(new Error("timeout")); });
      req.end();
    });
    expect(body).toBe("hello from preview");
  });

  it("closes connections cleanly while the app is not serving", async () => {
    const s = makeSupervisor();
    startPreview(s, { name: "t", setup: ["sleep 5"], run: SERVE }, nextPort++);
    // Still in setup: the port is bound but there is nothing behind it yet.
    await until(() => s.status().phase.kind === "setup", 5_000, "setup phase");

    const closed = await new Promise<boolean>((res) => {
      const c = createConnection({ host: "127.0.0.1", port: slotPort });
      c.once("close", () => res(true));
      c.once("error", () => res(true));
      setTimeout(() => { c.destroy(); res(false); }, 3000);
    });
    expect(closed).toBe(true);
  });
});

describe("restart and rebuild", () => {
  it("restart respawns the run command WITHOUT re-running setup", async () => {
    const s = makeSupervisor();
    const counter = join(sessionDir, "setup-runs");
    startPreview(s, {
      name: "t",
      setup: [`printf x >> ${counter}`],
      run: SERVE,
      readyTimeoutSec: 20,
    }, nextPort++);
    await until(() => s.status().state === "running", 20_000, "running");

    const { readFileSync } = await import("node:fs");
    expect(readFileSync(counter, "utf-8")).toBe("x");

    expect(s.restart().ok).toBe(true);
    await until(() => s.status().state === "running", 20_000, "running again");
    expect(readFileSync(counter, "utf-8")).toBe("x"); // unchanged
  });

  it("rebuild re-runs every setup step", async () => {
    const s = makeSupervisor();
    const counter = join(sessionDir, "setup-runs");
    startPreview(s, {
      name: "t",
      setup: [`printf x >> ${counter}`],
      run: SERVE,
      readyTimeoutSec: 20,
    }, nextPort++);
    await until(() => s.status().state === "running", 20_000, "running");

    expect(s.rebuild().ok).toBe(true);
    await until(() => s.status().state === "running", 20_000, "running again");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(counter, "utf-8")).toBe("xx");
  });

  it("refuses restart before anything has been started", () => {
    const s = makeSupervisor();
    s.acquire("lease-1", SESSION_ID);
    const r = s.restart();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("nothing to restart");
  });

  it("a rebuild issued mid-setup supersedes the in-flight run", async () => {
    const s = makeSupervisor();
    // The generation guard: without it, the first (slow) sequence would finish
    // later and stomp the second one's state.
    startPreview(s, { name: "t", setup: ["sleep 4"], run: SERVE, readyTimeoutSec: 20 }, nextPort++);
    await until(() => s.status().phase.kind === "setup", 5_000, "setup phase");

    expect(s.rebuild().ok).toBe(true);
    await until(() => s.status().state === "running", 30_000, "running");
    expect(s.status().state).toBe("running");
  });
});

describe("scratch wiping", () => {
  it("empties HOME and the temp dir but never touches the workspace", () => {
    const s = makeSupervisor();
    writeFileSync(join(home, "cached-thing"), "from a previous session");
    mkdirSync(join(home, ".npm"), { recursive: true });
    writeFileSync(join(scratch, "stale"), "x");
    writeFileSync(join(sessionDir, "package.json"), "{}");
    mkdirSync(join(sessionDir, "node_modules"), { recursive: true });

    s.wipeScratch();

    expect(readdirSync(home)).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    // node_modules and the project live in the bind mount and MUST survive —
    // that's why a cold lease is cheaper than it sounds.
    expect(existsSync(join(sessionDir, "package.json"))).toBe(true);
    expect(existsSync(join(sessionDir, "node_modules"))).toBe(true);
  });

  it("refuses to wipe a scratch dir that contains the workspace", () => {
    // A misconfigured HOME must not delete the user's project. Fail loudly
    // rather than recursively removing the bind mount.
    const s = makeSupervisor({ homeDir: root, workspaceDir: workspace });
    writeFileSync(join(sessionDir, "keep.txt"), "x");
    s.wipeScratch();
    expect(existsSync(join(sessionDir, "keep.txt"))).toBe(true);
  });

  it("guards the temp dir independently of HOME", () => {
    // A good HOME must not let a bad TMPDIR ride in — the guard is per target.
    const s = makeSupervisor({ homeDir: home, tmpDir: root });
    writeFileSync(join(home, "leftover"), "x");
    writeFileSync(join(sessionDir, "keep.txt"), "x");
    s.wipeScratch();
    expect(existsSync(join(sessionDir, "keep.txt"))).toBe(true);
    // HOME was still a valid target and was cleaned.
    expect(existsSync(join(home, "leftover"))).toBe(false);
  });

  it("release wipes scratch left behind by the previous lease", async () => {
    const s = makeSupervisor();
    s.acquire("lease-1", SESSION_ID);
    writeFileSync(join(home, "leftover"), "x");
    await s.release();
    expect(existsSync(join(home, "leftover"))).toBe(false);
    expect(s.leased).toBe(false);
  });
});

describe("confinement", () => {
  it("refuses to start unconfined when the image requires Landlock", async () => {
    // The fail-closed case: an unconfined preview is indistinguishable from a
    // confined one from the outside, so a missing wrapper must stop the start
    // rather than silently downgrade it.
    //
    // HOOOP_SANDBOX_EXEC is read at module load, and the path may genuinely
    // exist on the machine running these tests, so point it somewhere absent
    // and re-import rather than asserting against ambient state.
    const previous = process.env.HOOOP_SANDBOX_EXEC;
    process.env.HOOOP_SANDBOX_EXEC = join(root, "no-such-wrapper");
    vi.resetModules();
    try {
      const { Supervisor: Fresh } = await import("./supervisor");
      const s = new Fresh({
        slot: 1, slotPort: nextPort++, workspaceDir: workspace,
        homeDir: home, tmpDir: scratch, confine: "require",
      });
      s.acquire("lease-1", SESSION_ID);
      const r = s.start({ name: "t", run: SERVE } as never, sessionDir, nextPort++);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toContain("could not be confined");
    } finally {
      if (previous === undefined) delete process.env.HOOOP_SANDBOX_EXEC;
      else process.env.HOOOP_SANDBOX_EXEC = previous;
      vi.resetModules();
    }
  });
});

describe("shared flag", () => {
  it("promotes running → shared and back without disturbing other states", async () => {
    const s = makeSupervisor();
    startPreview(s, { name: "t", run: SERVE, readyTimeoutSec: 20 }, nextPort++);
    await until(() => s.status().state === "running", 20_000, "running");

    s.markShared(true);
    expect(s.status().state).toBe("shared");
    s.markShared(false);
    expect(s.status().state).toBe("running");

    // A failed preview must not be dragged into "shared" by a stale call.
    await s.stop();
    s.markShared(true);
    expect(s.status().state).toBe("stopped");
  });
});

// An app that cannot be told which port to use (a hardcoded listen, a port in a
// config file) needs the runner to target ITS port instead of the assigned one.
// Otherwise the probe polls a dead socket and the preview reports "the app did
// not respond", which reads as a broken app rather than a port mismatch.
describe("port.fixed", () => {
  it("serves an app that ignores $PORT and listens on its own", async () => {
    const s = makeSupervisor();
    const hardcoded = nextPort++;
    // Deliberately ignores process.env.PORT — the whole point.
    const run = `node -e "require('http').createServer((q,r)=>{r.writeHead(200);r.end('fixed-port-ok')}).listen(${hardcoded},'127.0.0.1')"`;
    startPreview(s, { name: "t", run, port: { fixed: hardcoded }, readyTimeoutSec: 20 }, nextPort++);
    await until(() => s.status().state === "running", 20_000, "running");
    // The lease reports the app's real port, not the one it was handed.
    expect(s.status().appPort).toBe(hardcoded);
  });

  it("still fails an app that ignores $PORT when no fixed port is declared", async () => {
    const s = makeSupervisor();
    const hardcoded = nextPort++;
    const run = `node -e "require('http').createServer((q,r)=>{r.writeHead(200);r.end('nope')}).listen(${hardcoded},'127.0.0.1')"`;
    startPreview(s, { name: "t", run, readyTimeoutSec: 3 }, nextPort++);
    await until(() => s.status().state === "failed", 15_000, "failed");
    expect(s.status().failureReason).toMatch(/did not respond/);
  });
});

