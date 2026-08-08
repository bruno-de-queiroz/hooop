import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// homedir() drives SESSIONS_ROOT via paths.ts, so it has to be test-controlled
// or every workdir assertion would depend on the machine's real home.
let fakeHome = "";
vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => fakeHome };
});

vi.mock("@shared/logger", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

const ORIGINAL_ENV = { ...process.env };
let tmpRoot: string;
let socketDir: string;
let sessionsRoot: string;

/** A stand-in for one preview-runner container. */
interface StubRunner {
  slot: number;
  server: Server;
  /** Every request the sandbox made, in order. */
  calls: Array<{ method: string; path: string; body: Record<string, unknown> }>;
  /** What /status should answer next. */
  status: Record<string, unknown>;
  /** Force /start to fail, to exercise the lease-cleanup path. */
  failStart: boolean;
  leaseId: string | null;
}

const runners: StubRunner[] = [];

async function startStubRunner(slot: number): Promise<StubRunner> {
  const stub: StubRunner = {
    slot,
    server: null as unknown as Server,
    calls: [],
    status: {},
    failStart: false,
    leaseId: null,
  };

  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      let body: Record<string, unknown> = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* ignore */ }
      const path = (req.url || "").split("?")[0];
      stub.calls.push({ method: req.method ?? "GET", path, body });

      const reply = (status: number, payload: unknown) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };

      switch (path) {
        case "/lease":
          stub.leaseId = String(body.leaseId);
          return reply(200, { ok: true, slot, slotPort: 7850 + slot - 1 });
        case "/start":
          if (stub.failStart) return reply(400, { error: "stub refused to start" });
          // Deliberately does NOT seed stub.status with a leaseId: `status` is
          // an override for the state fields a test wants to drive, and baking
          // the lease in here would shadow stub.leaseId below.
          return reply(200, { ok: true, appPort: 20001, slotPort: 7850 + slot - 1 });
        case "/status":
          return reply(200, { slot, leaseId: stub.leaseId, sessionId: null, state: "starting", phase: { kind: "idle" }, appPort: 20001, failedStep: null, failureReason: null, ...stub.status });
        case "/logs":
          return reply(200, { logs: [{ step: 0, command: "npm ci", stdout: "ok", stderr: "", exitCode: 0, truncated: false }] });
        case "/release":
          stub.leaseId = null;
          return reply(200, { ok: true });
        default:
          return reply(200, { ok: true });
      }
    });
  });

  const sockPath = join(socketDir, `runner-${slot}.sock`);
  await new Promise<void>((res) => server.listen(sockPath, () => res()));
  writeFileSync(join(socketDir, `runner-${slot}.token`), "t".repeat(64));
  stub.server = server;
  runners.push(stub);
  return stub;
}

async function loadPreviews() {
  process.env.HOOOP_PREVIEW_SOCKET_DIR = socketDir;
  vi.resetModules();
  return import("./previews");
}

/** A session workdir that satisfies the policy. */
function makeSessionDir(id: string): string {
  const dir = join(sessionsRoot, id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

const SPEC = { name: "web", run: "npm run dev" } as const;

beforeEach(() => {
  tmpRoot = realpathSync.native(mkdtempSync(join(tmpdir(), "previews-test-")));
  fakeHome = join(tmpRoot, "home");
  socketDir = join(tmpRoot, "run");
  sessionsRoot = join(fakeHome, "workspace", "sessions");
  mkdirSync(socketDir, { recursive: true });
  mkdirSync(sessionsRoot, { recursive: true });
});

afterEach(async () => {
  for (const r of runners.splice(0)) {
    await new Promise<void>((res) => r.server.close(() => res()));
  }
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

describe("workdir policy", () => {
  it("accepts a session's own workdir", async () => {
    const { resolveSessionRoot } = await loadPreviews();
    const cwd = makeSessionDir("sess-a");
    const r = resolveSessionRoot(cwd);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rootRelative).toBe(join("sessions", "sess-a"));
  });

  it("accepts a clone subdirectory's parent session dir", async () => {
    const { resolveSessionRoot } = await loadPreviews();
    const cwd = makeSessionDir("sess-a");
    mkdirSync(join(cwd, "my-repo"), { recursive: true });
    const r = resolveSessionRoot(cwd);
    expect(r.ok).toBe(true);
  });

  it("refuses a `hooop mount` folder, and explains why", async () => {
    const { resolveSessionRoot } = await loadPreviews();
    // A mount lives at WORKSPACE_DIR/<name>, a sibling of sessions/ — and is
    // bind-mounted INSIDE the sandbox only, so the runner cannot see it. The
    // user needs to be told that, not handed an empty preview.
    const mount = join(fakeHome, "workspace", "my-project");
    mkdirSync(mount, { recursive: true });
    const r = resolveSessionRoot(mount);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("hooop mount");
      expect(r.reason).toContain("session's own workspace");
    }
  });

  it("refuses a directory that does not exist", async () => {
    const { resolveSessionRoot } = await loadPreviews();
    const r = resolveSessionRoot(join(sessionsRoot, "nope"));
    expect(r.ok).toBe(false);
  });
});

describe("availability", () => {
  it("reports previews unavailable when no runner socket exists", async () => {
    const { previewsAvailable, startPreview } = await loadPreviews();
    expect(previewsAvailable()).toBe(false);
    await expect(
      startPreview({ sessionId: "s", sessionIds: ["s"], cwd: makeSessionDir("s"), spec: SPEC as never }),
    ).rejects.toThrow(/hooop rebuild/);
  });
});

describe("slot leasing", () => {
  it("leases a slot and records the preview", async () => {
    await startStubRunner(1);
    const { startPreview, listPreviews } = await loadPreviews();
    const rec = await startPreview({
      sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never,
    });
    expect(rec.slot).toBe(1);
    expect(rec.appPort).toBe(20001);
    expect(rec.slotPort).toBe(7850);
    expect(listPreviews()).toHaveLength(1);
    // The runner is told the session root RELATIVE to the workspace, because
    // the two containers spell the same directory differently.
    const start = runners[0].calls.find((c) => c.path === "/start");
    expect(start?.body.rootRelative).toBe(join("sessions", "sess-a"));
  });

  it("refuses a second preview in the same session and names the alternatives", async () => {
    await startStubRunner(1);
    await startStubRunner(2);
    const { startPreview } = await loadPreviews();
    await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    await expect(
      startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never }),
    ).rejects.toThrow(/rebuild_preview|restart_preview|stop_preview/);
  });

  it("refuses a fourth preview and names which sessions hold the slots", async () => {
    for (const s of [1, 2, 3]) await startStubRunner(s);
    const { startPreview } = await loadPreviews();
    for (const id of ["sess-a", "sess-b", "sess-c"]) {
      await startPreview({ sessionId: id, sessionIds: [id], cwd: makeSessionDir(id), spec: SPEC as never });
    }
    await expect(
      startPreview({ sessionId: "sess-d", sessionIds: ["sess-d"], cwd: makeSessionDir("sess-d"), spec: SPEC as never }),
    ).rejects.toThrow(/all 3 preview slots are in use/);
  });

  it("releases the slot when /start fails, so the cap isn't consumed by a no-op", async () => {
    const stub = await startStubRunner(1);
    stub.failStart = true;
    const { startPreview, listPreviews } = await loadPreviews();
    await expect(
      startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never }),
    ).rejects.toThrow(/stub refused to start/);

    expect(listPreviews()).toHaveLength(0);
    // A stranded lease would make every later start report "all slots in use"
    // with nothing actually running.
    expect(stub.calls.some((c) => c.path === "/release")).toBe(true);
  });
});

describe("lifecycle", () => {
  it("stops a preview and releases its slot for reuse", async () => {
    const stub = await startStubRunner(1);
    const { startPreview, stopPreview, listPreviews } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    await stopPreview(rec.previewId);
    expect(listPreviews()).toHaveLength(0);
    expect(stub.calls.some((c) => c.path === "/release")).toBe(true);
  });

  it("reaps by the FULL alias set, so a resumed session's preview still dies", async () => {
    await startStubRunner(1);
    const { startPreview, reapPreviewsForSessions, listPreviews } = await loadPreviews();
    // Minted under the id the session had before `claude --resume` swapped it.
    await startPreview({ sessionId: "old-id", sessionIds: ["old-id"], cwd: makeSessionDir("old-id"), spec: SPEC as never });
    const reaped = await reapPreviewsForSessions(["new-id", "old-id"]);
    expect(reaped).toHaveLength(1);
    expect(listPreviews()).toHaveLength(0);
  });

  it("leaves other sessions' previews alone when reaping one", async () => {
    await startStubRunner(1);
    await startStubRunner(2);
    const { startPreview, reapPreviewsForSessions, listPreviews } = await loadPreviews();
    await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    await startPreview({ sessionId: "sess-b", sessionIds: ["sess-b"], cwd: makeSessionDir("sess-b"), spec: SPEC as never });
    await reapPreviewsForSessions(["sess-a"]);
    expect(listPreviews().map((p) => p.sessionId)).toEqual(["sess-b"]);
  });
});

describe("sharing", () => {
  it("records the tunnel URL and promotes running → shared", async () => {
    const stub = await startStubRunner(1);
    const { startPreview, setPreviewShared, refreshPreview } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });

    stub.status = { state: "running" };
    await refreshPreview(rec.previewId);
    const shared = await setPreviewShared(rec.previewId, "https://x.trycloudflare.com");
    expect(shared.state).toBe("shared");
    expect(shared.publicUrl).toBe("https://x.trycloudflare.com");
  });

  it("a status poll never clears `shared` — that fact is the sandbox's, not the runner's", async () => {
    const stub = await startStubRunner(1);
    const { startPreview, setPreviewShared, refreshPreview } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    stub.status = { state: "running" };
    await refreshPreview(rec.previewId);
    await setPreviewShared(rec.previewId, "https://x.trycloudflare.com");

    // The runner keeps reporting "running"; the share must survive it.
    const after = await refreshPreview(rec.previewId);
    expect(after?.state).toBe("shared");
  });

  it("un-sharing drops back to running", async () => {
    const stub = await startStubRunner(1);
    const { startPreview, setPreviewShared, refreshPreview } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    stub.status = { state: "running" };
    await refreshPreview(rec.previewId);
    await setPreviewShared(rec.previewId, "https://x.trycloudflare.com");
    const back = await setPreviewShared(rec.previewId, null);
    expect(back.state).toBe("running");
    expect(back.publicUrl).toBeNull();
  });
});

describe("status refresh", () => {
  it("detects a runner that cycled under us", async () => {
    const stub = await startStubRunner(1);
    const { startPreview, refreshPreview } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });

    // The container restarted: it no longer holds our lease. Reporting a stale
    // "running" here would leave the UI pointing at a preview that is gone.
    stub.leaseId = "someone-else";
    const after = await refreshPreview(rec.previewId);
    expect(after?.state).toBe("failed");
    expect(after?.failureReason).toContain("restarted");
  });

  it("surfaces a failed setup step with its reason", async () => {
    const stub = await startStubRunner(1);
    const { startPreview, refreshPreview } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    stub.status = { state: "failed", failedStep: 1, failureReason: "setup step 2 exited 1" };
    const after = await refreshPreview(rec.previewId);
    expect(after?.state).toBe("failed");
    expect(after?.failedStep).toBe(1);
  });
});

describe("awaitSettled", () => {
  it("returns as soon as the preview leaves `starting`", async () => {
    const stub = await startStubRunner(1);
    const { startPreview, awaitSettled } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    setTimeout(() => { stub.status = { state: "running" }; }, 300);
    const settled = await awaitSettled(rec.previewId, 10_000);
    expect(settled?.state).toBe("running");
  });

  it("gives up honestly while still starting rather than waiting past the budget", async () => {
    // The gate does ONE 120s long-poll and reads a timeout as DENY, so a slow
    // `npm ci` must come back as "still starting", never as a denial.
    await startStubRunner(1);
    const { startPreview, awaitSettled } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    const settled = await awaitSettled(rec.previewId, 600);
    expect(settled?.state).toBe("starting");
  });
});

describe("logs", () => {
  it("proxies per-step logs from the runner", async () => {
    await startStubRunner(1);
    const { startPreview, previewLogs } = await loadPreviews();
    const rec = await startPreview({ sessionId: "sess-a", sessionIds: ["sess-a"], cwd: makeSessionDir("sess-a"), spec: SPEC as never });
    const logs = await previewLogs(rec.previewId);
    expect(logs[0].command).toBe("npm ci");
  });

  it("404s for an unknown preview", async () => {
    await startStubRunner(1);
    const { previewLogs } = await loadPreviews();
    await expect(previewLogs("nope")).rejects.toThrow(/unknown preview/);
  });
});
