import { vi, describe, it, expect, beforeEach } from "vitest";

interface VirtualFile {
  content: string;
  mtime: Date;
  size: number;
}

const fs = vi.hoisted(() => ({
  files: new Map<string, VirtualFile>(),
  dirs: new Set<string>(),
  reset() {
    this.files.clear();
    this.dirs.clear();
  },
  putFile(path: string, content: string, mtime = new Date()) {
    this.files.set(path, { content, mtime, size: content.length });
  },
  putDir(path: string) {
    this.dirs.add(path);
  },
  putSession(file: string, body: Record<string, unknown>, mtime = new Date()) {
    this.putFile(file, JSON.stringify(body), mtime);
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("node:fs");
  const existsSync = vi.fn((p: string) => {
    // Kernel liveness, not the virtual session fs: isPidAlive() checks
    // /proc/<pid> on Linux, and that path is real, not one of the fixtures
    // below. Defer /proc to the real filesystem — otherwise every "alive"
    // fixture (pid: process.pid) reads as dead on Linux, its sdk-cli row is
    // pruned, and listSessions() returns nothing. This passed on macOS only
    // because there is no /proc there, so isPidAlive() took its process.kill
    // branch instead. Caught by CI on ubuntu, green locally.
    if (p === "/proc" || p.startsWith("/proc/")) return actual.existsSync(p);
    return fs.files.has(p) || fs.dirs.has(p);
  });
  const statSync = vi.fn((p: string) => {
    const f = fs.files.get(p);
    if (f) return { mtime: f.mtime, size: f.size, isDirectory: () => false } as any;
    if (fs.dirs.has(p)) return { mtime: new Date(), size: 0, isDirectory: () => true } as any;
    throw new Error(`ENOENT: ${p}`);
  });
  const readFileSync = vi.fn((p: string) => {
    const f = fs.files.get(p);
    if (!f) throw new Error(`ENOENT: ${p}`);
    return f.content;
  });
  const readdirSync = vi.fn((p: string) => {
    const out: string[] = [];
    const prefix = p.endsWith("/") ? p : p + "/";
    for (const file of fs.files.keys()) {
      if (file.startsWith(prefix) && !file.slice(prefix.length).includes("/")) {
        out.push(file.slice(prefix.length));
      }
    }
    return out;
  });
  const unlinkSync = vi.fn((p: string) => { fs.files.delete(p); });
  // Shaped like a real FSWatcher, `on` included: fs.watch returns an
  // EventEmitter, and lib/watch-safe.ts attaches an 'error' listener to it so a
  // vanished directory cannot become an uncaught throw. A stub without `on` was
  // claiming an API fs.watch does not have.
  const watch = vi.fn(() => ({ close: vi.fn(), on: vi.fn(), listenerCount: vi.fn(() => 1) }));
  const api = { existsSync, statSync, readFileSync, readdirSync, unlinkSync, watch };
  return { ...api, default: api };
});

vi.mock("./active-sessions", () => ({
  getActiveSession: vi.fn(() => undefined),
  listActiveSessions: vi.fn(() => []),
  bootActiveSessions: vi.fn(),
  aliasesFor: vi.fn(() => []),
  // Default: no resume in flight, so orphan-suppression is inert and the
  // existing dedupe assertions hold. The resume-suppression case overrides
  // this per-test.
  isResumeInFlight: vi.fn(() => false),
}));

vi.mock("./paths", () => ({
  CLAUDE_SESSIONS_DIR: "/mock/sessions",
}));

let mod: typeof import("./sessions");
let active: typeof import("./active-sessions");
let unlinkSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.resetModules();
  fs.reset();
  fs.putDir("/mock/sessions");
  mod = await import("./sessions");
  active = await import("./active-sessions");
  (active.getActiveSession as any).mockReset().mockReturnValue(undefined);
  (active.listActiveSessions as any).mockReset().mockReturnValue([]);
  (active.isResumeInFlight as any).mockReset().mockReturnValue(false);
  const fsMod = await import("node:fs");
  unlinkSpy = (fsMod as any).unlinkSync;
  unlinkSpy.mockClear();
});

describe("isPidAlive", () => {
  // Two implementations, one per platform, so each branch is tested where it
  // actually runs. isPidAlive uses /proc on Linux (the model runs as a different
  // uid than this server, so kill(pid,0) always returns EPERM there and cannot
  // tell alive from dead) and the kill(pid,0) probe elsewhere. Testing the
  // process.kill branch on Linux, or the /proc branch on macOS, exercises code
  // the platform never takes — which is exactly how the first cut passed on macOS
  // and broke on CI.
  it("returns true for the test runner's own pid (definitely alive)", () => {
    expect(mod.isPidAlive(process.pid)).toBe(true);
  });

  it("returns false for an obviously dead pid", () => {
    expect(mod.isPidAlive(2 ** 22)).toBe(false);
  });

  describe.runIf(process.platform === "linux")("Linux (/proc)", () => {
    it("reads liveness from /proc, NOT from process.kill (which is EPERM cross-uid)", () => {
      // If it consulted process.kill, this spy throwing would flip the answer.
      // It must not: the /proc branch never calls process.kill.
      const spy = vi.spyOn(process, "kill").mockImplementation(() => {
        const err: any = new Error("ESRCH"); err.code = "ESRCH"; throw err;
      });
      expect(mod.isPidAlive(process.pid)).toBe(true); // /proc/<self> exists
      expect(mod.isPidAlive(2 ** 22)).toBe(false); // /proc/<dead> does not
      spy.mockRestore();
    });
  });

  describe.runIf(process.platform !== "linux")("non-Linux (kill probe)", () => {
    it("returns true when process.kill throws EPERM (exists, no permission)", () => {
      const spy = vi.spyOn(process, "kill").mockImplementation(() => {
        const err: any = new Error("EPERM"); err.code = "EPERM"; throw err;
      });
      expect(mod.isPidAlive(1)).toBe(true);
      spy.mockRestore();
    });
  });
});

describe("readSessionMeta", () => {
  it("returns parsed metadata for a healthy session file", () => {
    fs.putSession("/mock/sessions/12345.json", {
      sessionId: "sess-abc",
      pid: process.pid,
      cwd: "/work",
      entrypoint: "sdk-cli",
      kind: "interactive",
      version: "2.1.138",
      status: "idle",
      startedAt: 1700000000,
      updatedAt: 1700000100,
    });
    const out = mod.readSessionMeta("/mock/sessions/12345.json");
    expect(out).toMatchObject({
      id: "12345",
      sessionId: "sess-abc",
      pid: process.pid,
      cwd: "/work",
      entrypoint: "sdk-cli",
    });
  });

  it("prunes a stale sdk-cli file when its pid is dead", () => {
    fs.putSession("/mock/sessions/99999.json", {
      sessionId: "sess-stale",
      pid: 2 ** 22,
      cwd: "/work",
      entrypoint: "sdk-cli",
    });
    const out = mod.readSessionMeta("/mock/sessions/99999.json");
    expect(out).toBeNull();
    expect(unlinkSpy).toHaveBeenCalledWith("/mock/sessions/99999.json");
  });

  it("does NOT unlink a stale TUI (cli) file — its pid namespace is foreign", () => {
    fs.putSession("/mock/sessions/77.json", {
      sessionId: "sess-tui",
      pid: 2 ** 22,
      cwd: "/work",
      entrypoint: "cli",
    });
    const out = mod.readSessionMeta("/mock/sessions/77.json");
    expect(out).not.toBeNull();
    expect(out?.entrypoint).toBe("cli");
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("does NOT unlink an sdk-cli file with a live pid", () => {
    fs.putSession("/mock/sessions/live.json", {
      sessionId: "sess-live",
      pid: process.pid,
      cwd: "/work",
      entrypoint: "sdk-cli",
    });
    const out = mod.readSessionMeta("/mock/sessions/live.json");
    expect(out?.sessionId).toBe("sess-live");
    expect(unlinkSpy).not.toHaveBeenCalled();
  });

  it("returns surface fields even when JSON body is corrupt", () => {
    fs.putFile("/mock/sessions/corrupt.json", "{this is not json");
    const out = mod.readSessionMeta("/mock/sessions/corrupt.json");
    expect(out).not.toBeNull();
    expect(out?.id).toBe("corrupt");
    expect(out?.sessionId).toBeUndefined();
  });

  it("returns null when statSync throws (file disappeared mid-read)", () => {
    const out = mod.readSessionMeta("/mock/sessions/never-existed.json");
    expect(out).toBeNull();
  });
});

describe("listSessions", () => {
  beforeEach(() => {
    fs.putSession("/mock/sessions/100.json", {
      sessionId: "sess-100",
      pid: process.pid,
      cwd: "/a",
      entrypoint: "sdk-cli",
    });
    mod.startSessionsWatcher();
  });

  it("returns one row per fresh cached session file", () => {
    const out = mod.listSessions();
    expect(out).toHaveLength(1);
    expect(out[0].sessionId).toBe("sess-100");
  });

  it("decorates with active-sessions lifecycle when registry has a matching entry", () => {
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-100" ? { sessionId: "sess-100", status: "alive", displayName: "n" } : undefined
    );
    const out = mod.listSessions();
    expect(out[0].lifecycle).toBe("alive");
    expect(out[0].controllable).toBe(true);
    expect(out[0].displayName).toBe("n");
  });

  it("surfaces the registry lastSeenAt as updatedAt so `!bash`/`>chat` activity is visible", () => {
    // A model-free bash/chat only bumps the registry's lastSeenAt (via
    // markSessionActive) — it never rewrites claude's <pid>.json, so the file
    // mtime/updatedAt would leave the row looking idle. listSessions must lift
    // lastSeenAt onto updatedAt (ms) so the dashboard's activity cue reacts.
    // Comfortably newer than the beforeEach file mtime so the mtime lockstep
    // branch fires deterministically (no same-ms tie).
    const seen = Date.now() + 3_600_000;
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-100"
        ? { sessionId: "sess-100", status: "alive", displayName: "n", lastSeenAt: seen }
        : undefined,
    );
    const out = mod.listSessions();
    expect(out[0].updatedAt).toBe(seen);
    // mtime is bumped in lockstep when lastSeenAt is newer than the file's.
    expect(Date.parse(out[0].mtime)).toBe(seen);
  });

  it("clamps updatedAt UP (keeps the newer file value when lastSeenAt is older)", () => {
    // Mid-turn, claude's <pid>.json can carry a fresher updatedAt than the
    // registry's turn-start lastSeenAt. The activity clock must not tick
    // backwards — Math.max keeps the newer of the two.
    const fileUpdatedAt = Date.now() + 7_200_000; // clearly newest
    const staleSeen = Date.now() - 60_000;
    fs.putSession("/mock/sessions/200.json", {
      sessionId: "sess-200",
      pid: process.pid,
      cwd: "/b",
      entrypoint: "sdk-cli",
      updatedAt: fileUpdatedAt,
    });
    // The mocked fs.watch never fires, so force a fresh scan to pick up the
    // file added after the describe-level watcher already booted.
    mod.stopSessionsWatcher();
    mod.startSessionsWatcher();
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-200"
        ? { sessionId: "sess-200", status: "alive", displayName: "n", lastSeenAt: staleSeen }
        : undefined,
    );
    const out = mod.listSessions();
    const row = out.find((s) => s.sessionId === "sess-200");
    expect(row?.updatedAt).toBe(fileUpdatedAt);
  });

  it("surfaces the registry lastSeenAt as updatedAt on a dormant registry-only row", () => {
    const seen = Date.now();
    (active.listActiveSessions as any).mockReturnValue([
      { sessionId: "sess-dormant", status: "dormant", cwd: "/elsewhere", startedAt: 1700000000, lastSeenAt: seen, via: "new-conversation" },
    ]);
    const out = mod.listSessions();
    const dormant = out.find((s) => s.sessionId === "sess-dormant");
    expect(dormant?.updatedAt).toBe(seen);
  });

  it("backfills startedAt from the registry when the session file lacks one", () => {
    // The beforeEach cache file for sess-100 has no startedAt in its body.
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-100" ? { sessionId: "sess-100", status: "alive", startedAt: 1699999999 } : undefined
    );
    const out = mod.listSessions();
    expect(out[0].startedAt).toBe(1699999999);
  });

  it("marks expired sessions as not controllable", () => {
    (active.getActiveSession as any).mockReturnValue({ sessionId: "sess-100", status: "expired" });
    const out = mod.listSessions();
    expect(out[0].lifecycle).toBe("expired");
    expect(out[0].controllable).toBe(false);
  });

  it("surfaces a dormant registry entry that has no live session file", () => {
    (active.listActiveSessions as any).mockReturnValue([
      { sessionId: "sess-dormant", status: "dormant", cwd: "/elsewhere", startedAt: 1700000000, lastSeenAt: Date.now(), via: "new-conversation" },
    ]);
    const out = mod.listSessions();
    const dormant = out.find((s) => s.sessionId === "sess-dormant");
    expect(dormant).toBeDefined();
    expect(dormant?.lifecycle).toBe("dormant");
    // Creation date comes from the registry so the rail can sort by it.
    expect(dormant?.startedAt).toBe(1700000000);
  });

  it("surfaces a freshly-created alive session immediately, even when a cache entry shares its cwd", () => {
    // The core of the lifecycle fix: a dashboard session owns its id from spawn
    // (--session-id) and is first-class from creation — no model turn, no
    // <pid>.json file yet. The base cache row (sess-100) shares the /a cwd; the
    // OLD code suppressed this registry row on that cwd match, hiding brand-new
    // sessions in the shared workspace. It must now be visible.
    (active.listActiveSessions as any).mockReturnValue([
      { sessionId: "fresh-real-id", status: "alive", cwd: "/a", lastSeenAt: Date.now(), via: "new-conversation", displayName: "witty-humble-turing" },
    ]);
    const out = mod.listSessions();
    const row = out.find((s) => s.sessionId === "fresh-real-id");
    expect(row).toBeDefined();
    expect(row?.lifecycle).toBe("alive");
    expect(row?.displayName).toBe("witty-humble-turing");
    expect(out).toHaveLength(2);
  });

  it("WAKE: KEEPS a resumed real-id alive entry even when an sdk-cli cache entry shares the cwd", () => {
    // Regression guard for the vanishing-row bug. On a cold wake the slot is
    // alive under its REAL id (e.g. wake-A) while `claude --resume` has written
    // a <pid>.json under the SAME shared workspace cwd. The cwd-based collapse
    // must NOT suppress this real-id entry (only `pending-` new-spawn halves),
    // otherwise the session vanishes from /sessions mid-wake and the header
    // flashes a short-hash id. The named registry row must stay present.
    (active.listActiveSessions as any).mockReturnValue([
      {
        sessionId: "wake-A", status: "alive", cwd: "/a",
        lastSeenAt: Date.now(), via: "resumed", displayName: "calm-nesting-thompson",
      },
    ]);
    const out = mod.listSessions();
    const row = out.find((s) => s.sessionId === "wake-A");
    expect(row).toBeDefined();
    expect(row?.displayName).toBe("calm-nesting-thompson");
  });

  it("DEDUPE wake race: keeps an ENDED / dormant entry even when cache has the same cwd (real history matters)", () => {
    (active.listActiveSessions as any).mockReturnValue([
      { sessionId: "old-A", status: "ended", cwd: "/a", lastSeenAt: Date.now(), via: "resumed" },
    ]);
    const out = mod.listSessions();
    expect(out.find((s) => s.sessionId === "old-A")).toBeDefined();
    expect(out).toHaveLength(2);
  });

  it("DEDUPE within-cache: two <pid>.json files sharing one sessionId surface as a single row (freshest wins)", () => {
    // Same conversation, two PID files: e.g. TUI claude wrote one, the
    // dashboard's --resume spawn wrote another. Both end up in _cache.
    fs.putSession(
      "/mock/sessions/100-old.json",
      { sessionId: "shared-id", pid: process.pid, cwd: "/a", entrypoint: "sdk-cli" },
      new Date(Date.now() - 60_000)
    );
    fs.putSession(
      "/mock/sessions/100-new.json",
      { sessionId: "shared-id", pid: process.pid, cwd: "/a", entrypoint: "sdk-cli" },
      new Date()
    );
    vi.resetModules();
    return import("./sessions").then((fresh) => {
      fresh.startSessionsWatcher();
      const out = fresh.listSessions();
      const rows = out.filter((s) => s.sessionId === "shared-id");
      expect(rows).toHaveLength(1);
      // The fresher mtime should win.
      expect(rows[0].path).toContain("100-new.json");
    });
  });

  it("WAKE: suppresses an undecorated sdk-cli orphan cache row while a resume is in flight for its cwd", () => {
    // The base beforeEach cache row (sess-100, cwd /a, sdk-cli) has NO
    // registry decoration (getActiveSession default → undefined). With a
    // resume in flight for /a, it's the mid-swap orphan → suppressed.
    (active.isResumeInFlight as any).mockImplementation((cwd: string) => cwd === "/a");
    const out = mod.listSessions();
    expect(out.find((s) => s.sessionId === "sess-100")).toBeUndefined();
  });

  it("WAKE: keeps the orphan row once it gains registry decoration (post-swap)", () => {
    (active.isResumeInFlight as any).mockImplementation((cwd: string) => cwd === "/a");
    (active.getActiveSession as any).mockImplementation((id: string) =>
      id === "sess-100" ? { sessionId: "sess-100", status: "alive", displayName: "haiku-name" } : undefined
    );
    const out = mod.listSessions();
    const row = out.find((s) => s.sessionId === "sess-100");
    expect(row).toBeDefined();
    expect(row?.displayName).toBe("haiku-name");
  });

  it("WAKE: does NOT suppress when no resume is in flight (steady state)", () => {
    (active.isResumeInFlight as any).mockReturnValue(false);
    const out = mod.listSessions();
    expect(out.find((s) => s.sessionId === "sess-100")).toBeDefined();
  });

  it("sorts results by mtime descending", async () => {
    fs.putSession("/mock/sessions/200.json", {
      sessionId: "sess-200",
      pid: process.pid,
      cwd: "/b",
      entrypoint: "sdk-cli",
    }, new Date(Date.now() + 60_000));
    // Re-trigger the cache build by re-importing.
    vi.resetModules();
    const fresh = await import("./sessions");
    fresh.startSessionsWatcher();
    const out = fresh.listSessions();
    expect(out[0].sessionId).toBe("sess-200");
    expect(out[1].sessionId).toBe("sess-100");
  });
});
