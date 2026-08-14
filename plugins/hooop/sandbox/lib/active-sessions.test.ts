import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Readable as ReadableT, Writable as WritableT } from "node:stream";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SESSIONS_ROOT, sessionWorkdir, WORKSPACE_DIR } from "./paths";

vi.mock("./plugin-paths", () => ({
  discoverInstalledPluginDirs: () => [],
  readInstalledPluginEntries: () => [],
}));

const ingestEventLineMock = vi.fn();
vi.mock("./ingestor", () => ({
  ingestEventLine: (line: string) => ingestEventLineMock(line),
}));

// deleteSession (and so destroySession) purges the search DB on the way out.
// That module opens a real sqlite file by path — mocked here (no test in this
// file exercises the DB itself) so destroySession/burn tests never touch a
// real database, matching how ./previews and ./ingestor are stubbed above.
vi.mock("./db", () => ({
  deleteEventsForSessions: vi.fn(() => ({ deleted: 0 })),
  listEventSessionIds: vi.fn(() => [] as string[]),
}));

// The preview registry talks to runner containers over a UDS. Mocked so the
// gate's own behaviour (card vs no card, which decisions are reachable) can be
// tested without a runner; `previewsMock.records` is the fake registry.
const previewsMock = vi.hoisted(() => ({
  records: [] as Array<Record<string, unknown>>,
  started: [] as Array<Record<string, unknown>>,
  stopped: [] as string[],
  reaped: [] as string[],
  startError: null as Error | null,
  reset() { this.records = []; this.started = []; this.stopped = []; this.reaped = []; this.startError = null; },
}));
vi.mock("./previews", () => {
  class PreviewError extends Error {
    status: number;
    constructor(message: string, status = 400) { super(message); this.name = "PreviewError"; this.status = status; }
  }
  return {
    PreviewError,
    awaitSettled: async (id: string) => previewsMock.records.find((r) => r.previewId === id) ?? null,
    describePreview: async (r: Record<string, unknown>) =>
      `Preview "${(r.spec as { name: string }).name}" is ${r.state} at http://127.0.0.1:${r.slotPort}`,
    emitPreviewEvent: vi.fn(),
    getPreview: (id: string) => previewsMock.records.find((r) => r.previewId === id) ?? null,
    listPreviews: () => previewsMock.records,
    previewForSession: (ids: string[]) =>
      previewsMock.records.find((r) => ids.includes(r.sessionId as string)) ?? null,
    reapPreviewsForSessions: async (ids: readonly string[]) => {
      const doomed = previewsMock.records.filter((r) => ids.includes(r.sessionId as string));
      previewsMock.records = previewsMock.records.filter((r) => !ids.includes(r.sessionId as string));
      previewsMock.reaped.push(...doomed.map((r) => r.previewId as string));
      return doomed.map((r) => r.previewId as string);
    },
    rebuildPreview: async (id: string) => previewsMock.records.find((r) => r.previewId === id),
    refreshAll: async () => previewsMock.records,
    restartPreview: async (id: string) => previewsMock.records.find((r) => r.previewId === id),
    startPreview: async (opts: Record<string, unknown>) => {
      if (previewsMock.startError) throw previewsMock.startError;
      previewsMock.started.push(opts);
      const rec = {
        previewId: "pv-new", sessionId: opts.sessionId, slot: 1, slotPort: 7850,
        spec: opts.spec, state: "running", phase: { kind: "run" },
        failedStep: null, failureReason: null, publicUrl: null,
      };
      previewsMock.records.push(rec);
      return rec;
    },
    stopPreview: async (id: string) => {
      previewsMock.stopped.push(id);
      previewsMock.records = previewsMock.records.filter((r) => r.previewId !== id);
    },
    summarizePreviews: (rs: Array<Record<string, unknown>>) => `${rs.length} previews`,
  };
});

// Shared mutable handles so tests can override fs mock behaviour per-test.
// Also exposes real fs functions that the test file needs for setup (mkdtempSync,
// mkdirSync, rmSync) — these must bypass the mocked node:fs.
const fsMock = vi.hoisted(() => ({
  existsReturnValue: false as boolean | ((p: string) => boolean),
  readFileReturnValue: "{}" as string | ((p: string) => string),
  statImpl: null as null | ((p: string) => { mtimeMs: number }),
  // Populated by the mock factory with the real fs functions so test helpers
  // can create and remove directories without going through the vi.fn() stubs.
  realFs: null as null | {
    mkdtempSync: (prefix: string) => string;
    mkdirSync: (path: string, opts?: { recursive?: boolean }) => void;
    rmSync: (path: string, opts?: { recursive?: boolean; force?: boolean }) => void;
  },
  reset() {
    this.existsReturnValue = false;
    this.readFileReturnValue = "{}";
    this.statImpl = null;
  },
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual: any = await importOriginal();
  // Expose real helpers to test code (captured once; survives resetModules).
  if (!fsMock.realFs) {
    fsMock.realFs = {
      mkdtempSync: actual.mkdtempSync,
      mkdirSync: actual.mkdirSync,
      rmSync: actual.rmSync,
    };
  }
  return {
    ...actual,
    default: actual,
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn((p: string) => {
      const v = fsMock.readFileReturnValue;
      return typeof v === "function" ? v(p) : v;
    }),
    existsSync: vi.fn((p: string) => {
      const v = fsMock.existsReturnValue;
      return typeof v === "function" ? v(p) : v;
    }),
    mkdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    readdirSync: vi.fn(() => [] as string[]),
    statSync: vi.fn((p: string) => {
      const v = fsMock.statImpl;
      if (v) return v(p);
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
  };
});

const shared = vi.hoisted(() => {
  // Defer requires until factory runtime so the hoist doesn't fail.
  return {
    children: [] as any[],
    reset() { this.children = []; },
    make(args: string[] = [], env: NodeJS.ProcessEnv = {}): any {
      const { EventEmitter } = require("node:events");
      const { Readable, Writable } = require("node:stream");
      const stdin = new Writable({ write(_c: any, _e: any, cb: any) { cb(); } });
      const stdout = new Readable({ read() {} });
      (stdout as any).pushLine = (obj: object) => stdout.push(JSON.stringify(obj) + "\n", "utf-8");
      const stderr = new Readable({ read() {} });
      const ee = new EventEmitter();
      const child: any = Object.assign(ee, {
        stdin, stdout, stderr,
        pid: 12345 + this.children.length,
        killed: false,
        kill: vi.fn(),
        spawnArgs: args,
        spawnEnv: env,
      });
      this.children.push(child);
      return child;
    },
  };
});

vi.mock("node:child_process", () => {
  const spawn = (_cmd: string, args: string[] = [], opts: any = {}) => shared.make(args, opts?.env ?? {});
  // execFile is imported (promisified) for git-clone-on-start; no test exercises
  // that path, so a stub is enough to satisfy the module-level promisify().
  const execFile = () => {};
  return { spawn, execFile, default: { spawn, execFile } };
});

async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

let mod: typeof import("./active-sessions");
let sharesMod: typeof import("./shares");
const originalEnv = process.env.HOOOP_CWD_ROOTS;
const originalAsAgent = process.env.HOOOP_AS_AGENT;

beforeEach(async () => {
  vi.resetModules();
  shared.reset();
  fsMock.reset();
  ingestEventLineMock.mockReset();
  previewsMock.reset();
  delete process.env.HOOOP_CWD_ROOTS;
  delete process.env.HOOOP_AUTO_COMPACT_PCT;
  delete process.env.ANTHROPIC_MODEL;
  // These tests assert the DIRECT kill path (`child.kill("SIGTERM")`), which
  // lib/as-agent.ts takes only when HOOOP_AS_AGENT is unset. Left inherited, the
  // suite silently tested a different code path depending on the machine: green
  // on a laptop, and three failures inside a hooop sandbox — where the var IS set
  // — because killAsAgent went through the setuid helper via spawnSync, which
  // this file's node:child_process mock does not provide. Same handling
  // as-agent.test.ts already uses; it sets the var explicitly when it wants the
  // helper path. Deleted BEFORE the import below, since paths.ts reads it once
  // at module load.
  delete process.env.HOOOP_AS_AGENT;
  mod = await import("./active-sessions");
  // Same module instance the sweeps revoke through, so a test can assert on the
  // real registry rather than on a mock of it.
  sharesMod = await import("./shares");
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env.HOOOP_CWD_ROOTS;
  else process.env.HOOOP_CWD_ROOTS = originalEnv;
  if (originalAsAgent === undefined) delete process.env.HOOOP_AS_AGENT;
  else process.env.HOOOP_AS_AGENT = originalAsAgent;
  delete process.env.HOOOP_AUTO_COMPACT_PCT;
  delete process.env.ANTHROPIC_MODEL;
});

describe("repoDirNameFromUrl", () => {
  it.each([
    ["https://github.com/owner/repo.git", "repo"],
    ["https://github.com/owner/repo", "repo"],
    ["git@github.com:owner/repo.git", "repo"],
    ["https://github.com/owner/repo/", "repo"],
    ["ssh://git@host:22/team/My.Repo.git", "My.Repo"],
    ["https://host/foo?ref=main#frag", "foo"],
    ["https://host/weird name!.git", "weird-name-"],
    // "." / ".." / all-dots must not resolve to WORKSPACE_DIR or its parent.
    ["https://x/..", "repo"],
    ["https://x/.", "repo"],
  ])("%s -> %s", (url, want) => {
    expect(mod.repoDirNameFromUrl(url)).toBe(want);
  });
});

describe("startNewConversation", () => {
  it("spawns with an OWNED (real, non-pending) id passed to claude via --session-id", async () => {
    const { sessionId, meta } = await mod.startNewConversation({ cwd: "/workspace" });
    // The id is ours from creation — a real UUID, never a `pending-` placeholder.
    expect(sessionId).not.toMatch(/^pending-/);
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(meta.cwd).toBe("/workspace");
    expect(meta.status).toBe("alive");
    expect(meta.via).toBe("new-conversation");
    expect(mod.isControllable(sessionId)).toBe(true);
    // We force claude to adopt it, so its frames carry our id from frame one.
    const args = shared.children[shared.children.length - 1].spawnArgs as string[];
    const i = args.indexOf("--session-id");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(sessionId);
    // A fresh spawn is NOT a resume.
    expect(args).not.toContain("--resume");
    // Plan-mode steering rides on the session's appended system prompt (invisible
    // to the transcript), not on per-turn text injection.
    const sp = args.indexOf("--append-system-prompt");
    expect(sp).toBeGreaterThanOrEqual(0);
    expect(args[sp + 1]).toMatch(/submit_plan/);
    expect(args[sp + 1]).toMatch(/plan mode/i);
  });
});

describe("stdout parser: session id is owned (no swap for new sessions)", () => {
  it("keeps its owned id when claude's first frame reports the same id — no swap, no alias", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/workspace" });

    // claude adopts our id (--session-id), so its first frame carries it back.
    (shared.children[0].stdout as any).pushLine({ type: "system", subtype: "init", session_id: sessionId });
    await flush();

    // Id is stable; still resolves to itself with no alias remap.
    expect(mod.getActiveSession(sessionId)?.sessionId).toBe(sessionId);
    expect(mod.aliasesFor(sessionId)).toEqual([]);
    // No aliasFrom swap event was emitted.
    expect(events.find((e) => e.aliasFrom)).toBeUndefined();
  });

  it("DEFENSIVE: still swaps + aliases if claude ever reports a DIFFERENT id", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/workspace" });
    (shared.children[0].stdout as any).pushLine({ type: "system", subtype: "init", session_id: "surprise-id" });
    await flush();

    expect(mod.getActiveSession(sessionId)?.sessionId).toBe("surprise-id");
    expect(mod.getActiveSession("surprise-id")?.sessionId).toBe("surprise-id");
    const swap = events.find((e) => e.aliasFrom === sessionId);
    expect(swap).toBeDefined();
    expect(swap.sessionId).toBe("surprise-id");
  });

  it("swaps again if --resume yields a new id (resume case)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "first" });
    await flush();
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "second" });
    await flush();

    expect(mod.getActiveSession("first")?.sessionId).toBe("second");
    expect(mod.getActiveSession("second")?.sessionId).toBe("second");
    expect(mod.getActiveSession(sessionId)?.sessionId).toBe("second");
  });
});

describe("stdout parser: synthetic frame ingestion", () => {
  it("ingests a synthetic /cost-style assistant frame as kind=info", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "subscription active" }] },
      session_id: "synth-1",
    });
    await flush();

    expect(ingestEventLineMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(ingestEventLineMock.mock.calls[0][0]);
    expect(payload.hook).toBe("Stop");
    expect(payload.ctx.kind).toBe("info");
    expect(payload.ctx.last_assistant_message).toBe("subscription active");
    expect(payload.ctx.synthetic).toBe(true);
  });

  it("tags a synthetic '(no content)' frame as kind=cleared with friendly text", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      message: { model: "<synthetic>", content: [{ type: "text", text: "(no content)" }] },
      session_id: "synth-2",
    });
    await flush();

    expect(ingestEventLineMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(ingestEventLineMock.mock.calls[0][0]);
    expect(payload.ctx.kind).toBe("cleared");
    expect(payload.ctx.last_assistant_message).toBe("Conversation cleared.");
  });

  it("ingests a synthetic user frame (/compact) as kind=compaction with the summary text", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    // The boundary always precedes the summary in the real stream, and it is
    // what identifies the summary as one. Verified live: compact_boundary,
    // then the isSynthetic user frame, then result.
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "manual", post_tokens: 2094 },
      session_id: "compact-1",
    });
    (shared.children[0].stdout as any).pushLine({
      type: "user",
      isSynthetic: true,
      isReplay: false,
      message: { content: "This session is being continued..." },
      session_id: "compact-1",
    });
    await flush();

    expect(ingestEventLineMock).toHaveBeenCalledOnce();
    const payload = JSON.parse(ingestEventLineMock.mock.calls[0][0]);
    expect(payload.ctx.kind).toBe("compaction");
    expect(payload.ctx.last_assistant_message).toContain("This session is being continued");
  });

  // The bug this gate exists for. Reading an oversized image makes claude inject
  // a downscale notice as a synthetic USER frame — same isSynthetic marking as a
  // compaction summary, no compaction anywhere near it. One design session read
  // 22 screenshots and collected 10 "Context compacted" markers having never
  // compacted once. Fixture text is verbatim from a captured stream.
  it("does not mistake the image-downscale notice for a compaction", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "user",
      isSynthetic: true,
      message: {
        content: [{
          type: "text",
          text: "[Image: original 2560x2000, displayed at 2000x1563. "
            + "Multiply coordinates by 1.28 to map to original image.]",
        }],
      },
      session_id: "img-1",
    });
    await flush();

    expect(ingestEventLineMock).not.toHaveBeenCalled();
  });

  // One boundary means one summary. An oversized image read later in the SAME
  // auto-compacted turn must not inherit the tag the boundary armed.
  it("arms the compaction tag for exactly one synthetic frame", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[0] as any;
    child.stdout.pushLine({
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { trigger: "auto", post_tokens: 2094 },
      session_id: "compact-2",
    });
    child.stdout.pushLine({
      type: "user",
      isSynthetic: true,
      isReplay: false,
      message: { content: "This session is being continued..." },
      session_id: "compact-2",
    });
    child.stdout.pushLine({
      type: "user",
      isSynthetic: true,
      message: { content: [{ type: "text", text: "[Image: original 2192x1372, displayed at 2000x1252.]" }] },
      session_id: "compact-2",
    });
    await flush();

    expect(ingestEventLineMock).toHaveBeenCalledOnce();
    expect(JSON.parse(ingestEventLineMock.mock.calls[0][0]).ctx.kind).toBe("compaction");
  });

  // Claude runs /compact and /cost WITHOUT emitting a Stop hook, so
  // markTurnFinished (server.ts /ingest) never fires for them. Before the
  // nativeCommandPending flag nothing cleared turnActive and every viewer's
  // "thinking" indicator stayed on indefinitely after the command finished.
  it("clears the thinking indicator when a manual /compact finishes (no Stop hook fires)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: "compact-turn" });
    await flush();
    await mod.writeUserTurn("compact-turn", "/compact");
    expect(mod.getActiveSession("compact-turn")?.turnActive).toBe(true);

    child.stdout.pushLine({
      type: "user",
      isSynthetic: true,
      isReplay: false,
      message: { content: "This session is being continued..." },
      session_id: "compact-turn",
    });
    await flush();
    expect(mod.getActiveSession("compact-turn")?.turnActive).toBe(false);
  });

  // Note the test above ships NO compact_boundary, so its summary produces no
  // row — and the indicator still clears. That is deliberate: the compaction
  // gate decides whether a frame is worth a transcript row, never whether a
  // pending native command has finished. Tying the two together would let a
  // missing boundary strand every viewer on "thinking" forever, which is a far
  // worse failure than the stray marker the gate removes.
  it("ends a native command's turn on a synthetic frame that earns no row", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: "rowless-turn" });
    await flush();
    await mod.writeUserTurn("rowless-turn", "/compact");
    expect(mod.getActiveSession("rowless-turn")?.turnActive).toBe(true);

    child.stdout.pushLine({
      type: "user",
      isSynthetic: true,
      message: { content: [{ type: "text", text: "[Image: original 2560x2000, displayed at 2000x1563.]" }] },
      session_id: "rowless-turn",
    });
    await flush();

    // writeUserTurn ingests the prompt itself, so assert on the transcript row
    // specifically: no Stop was synthesized for that frame.
    const hooks = ingestEventLineMock.mock.calls.map((c: any[]) => JSON.parse(c[0]).hook);
    expect(hooks).toEqual(["UserPromptSubmit"]);
    expect(mod.getActiveSession("rowless-turn")?.turnActive).toBe(false);
  });

  // The counterpart, and the reason the clear is keyed on "we dispatched a
  // native command" rather than on the frame's kind: AUTO-compaction emits an
  // IDENTICAL synthetic summary frame mid-turn, but the turn keeps running —
  // clearing there would drop the indicator while the model is still working.
  it("leaves the thinking indicator on through an AUTO compaction (the turn continues)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: "auto-compact" });
    await flush();
    await mod.writeUserTurn("auto-compact", "do a long thing");
    expect(mod.getActiveSession("auto-compact")?.turnActive).toBe(true);

    child.stdout.pushLine({
      type: "user",
      isSynthetic: true,
      isReplay: false,
      message: { content: "This session is being continued..." },
      session_id: "auto-compact",
    });
    await flush();
    expect(mod.getActiveSession("auto-compact")?.turnActive).toBe(true);
  });

  // After a compaction claude replays the surviving history on stdout, which
  // re-emits historical synthetic assistant frames. Ingesting those duplicates
  // every past /cost output (and resurrects old kind=error notices as fresh
  // "turn failed" cards) right after the compaction row.
  it("ignores REPLAYED synthetic assistant frames (no duplicate /cost output after a compaction)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      isReplay: true,
      message: { model: "<synthetic>", content: [{ type: "text", text: "subscription active" }] },
      session_id: "replay-synth",
    });
    await flush();
    expect(ingestEventLineMock).not.toHaveBeenCalled();
  });

  it("ignores user frames with isReplay=true (the 'Compacted' stdout marker)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "user",
      isReplay: true,
      message: { content: "<local-command-stdout>Compacted </local-command-stdout>" },
      session_id: "replay-1",
    });
    await flush();

    expect(ingestEventLineMock).not.toHaveBeenCalled();
  });

  it("ignores non-synthetic assistant frames (real model replies route through hooks)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      message: { model: "claude-opus-4-7", content: [{ type: "text", text: "hi" }] },
      session_id: "real-1",
    });
    await flush();

    expect(ingestEventLineMock).not.toHaveBeenCalled();
  });
});

describe("windowForModel / autoCompactPct", () => {
  it("maps the 1M-context tier to 1,000,000", () => {
    for (const m of [
      "claude-opus-4-8", "claude-opus-4-8-20260528", "claude-opus-4-7",
      "claude-sonnet-5", "claude-sonnet-4-6", "claude-fable-5", "claude-mythos-5",
    ]) {
      expect(mod.windowForModel(m)).toBe(1_000_000);
    }
  });

  it("maps the 200k-context tier to 200,000", () => {
    for (const m of ["claude-sonnet-4-5", "claude-opus-4-5", "claude-haiku-4-5", "claude-haiku-4-4"]) {
      expect(mod.windowForModel(m)).toBe(200_000);
    }
  });

  it("resolves bare aliases to the family's latest window", () => {
    expect(mod.windowForModel("opus")).toBe(1_000_000);
    expect(mod.windowForModel("sonnet")).toBe(1_000_000);
    expect(mod.windowForModel("haiku")).toBe(200_000);
  });

  it("returns null (no guessed default) when the model is unknown or unset", () => {
    expect(mod.windowForModel(null)).toBeNull();
    expect(mod.windowForModel(undefined)).toBeNull();
    expect(mod.windowForModel("gpt-4o")).toBeNull();
    expect(mod.windowForModel("some-internal-model")).toBeNull();
  });

  it("reads HOOOP_AUTO_COMPACT_PCT (clamped) with an 85 default", () => {
    expect(mod.autoCompactPct()).toBe(85);
    process.env.HOOOP_AUTO_COMPACT_PCT = "70";
    expect(mod.autoCompactPct()).toBe(70);
    process.env.HOOOP_AUTO_COMPACT_PCT = "999";
    expect(mod.autoCompactPct()).toBe(85); // out of range -> default
  });
});

describe("spawn: auto-compaction env", () => {
  it("hands claude a per-model window + trigger pct by default", async () => {
    await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85");
  });

  it("sizes the window to the model (200k for haiku)", async () => {
    await mod.startNewConversation({ cwd: "/x", model: "claude-haiku-4-5" });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
  });

  it("resolves an alias model to its window (opus -> 1M)", async () => {
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: "opus" });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(meta.lastStats?.contextWindow).toBe(1_000_000);
  });

  it("always enables auto-compaction, falling back to the safe floor for an unknown model", async () => {
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: null });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    // Auto-compaction is ALWAYS on: the env is injected even when we can't size
    // the model, using the smallest real window so it still fires safely.
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("200000");
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("85");
    // The nominal model window stays unset (never the floor guess) — it binds
    // from the init frame instead. But autoCompactWindow records the window
    // claude ACTUALLY enforces this incarnation (the floor), and the dashboard
    // meter measures against THAT so the bar + marker stay honest (S1).
    expect(meta.lastStats?.contextWindow).toBeUndefined();
    expect(meta.lastStats?.autoCompactWindow).toBe(200_000);
    expect(meta.lastStats?.autoCompactPct).toBe(85);
  });

  it("honors HOOOP_AUTO_COMPACT_PCT for the trigger (the only knob)", async () => {
    process.env.HOOOP_AUTO_COMPACT_PCT = "70";
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    const env = shared.children[0].spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000");
    expect(env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).toBe("70");
    expect(meta.lastStats?.autoCompactPct).toBe(70);
  });

  it("records the configured window + pct on lastStats", async () => {
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    expect(meta.lastStats?.contextWindow).toBe(1_000_000);
    // The enforced window equals the model window when the model resolves at spawn.
    expect(meta.lastStats?.autoCompactWindow).toBe(1_000_000);
    expect(meta.lastStats?.autoCompactPct).toBe(85);
  });
});

describe("spawn: lastStats.model is seeded before any turn", () => {
  // GET /sessions/:id/model has three sources and, before this seed, ALL of them
  // could be empty for a session that had not produced a turn yet: the transcript
  // is unreadable to the server since the uid split, meta.model is the user's
  // intent (null when unpinned), and lastStats.model was only bound from the
  // init frame. The model handed to claude on --model is known at spawn, so
  // there is no reason for the header to show nothing.
  it("seeds the explicit --model", async () => {
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    expect(meta.lastStats?.model).toBe("claude-opus-4-8");
  });

  it("seeds a bare alias as-is (the init frame later replaces it with the versioned id)", async () => {
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: "opus" });
    expect(meta.lastStats?.model).toBe("opus");
  });

  it("seeds claude's own default for an UNPINNED session, where meta.model is null", async () => {
    // The case the seed exists for: nothing pinned, so meta.model stays null and
    // only the resolved default can be displayed.
    process.env.ANTHROPIC_MODEL = "claude-sonnet-5";
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: null });
    expect(meta.model).toBeNull();
    expect(meta.lastStats?.model).toBe("claude-sonnet-5");
  });

  it("leaves model unset when nothing resolves at spawn (never a guess)", async () => {
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: null });
    expect(meta.lastStats?.model).toBeUndefined();
  });
});

describe("resolveConfiguredModel (claude's default, resolved before spawn)", () => {
  it("prefers ANTHROPIC_MODEL over any settings file", () => {
    process.env.ANTHROPIC_MODEL = "claude-opus-4-8";
    fsMock.existsReturnValue = true;
    fsMock.readFileReturnValue = JSON.stringify({ model: "claude-haiku-4-5" });
    expect(mod.resolveConfiguredModel("/proj")).toBe("claude-opus-4-8");
  });

  it("reads the model from a settings.json when no env is set", () => {
    fsMock.existsReturnValue = (p: string) => p.endsWith("/.claude/settings.json");
    fsMock.readFileReturnValue = (p: string) =>
      p.endsWith("/.claude/settings.json") ? JSON.stringify({ model: "sonnet" }) : "{}";
    expect(mod.resolveConfiguredModel("/proj")).toBe("sonnet");
  });

  it("prefers project settings.local over project settings over user settings", () => {
    fsMock.existsReturnValue = true; // all candidate files "exist"
    fsMock.readFileReturnValue = (p: string) => {
      if (p === "/proj/.claude/settings.local.json") return JSON.stringify({ model: "local-model" });
      if (p === "/proj/.claude/settings.json") return JSON.stringify({ model: "project-model" });
      return JSON.stringify({ model: "user-model" });
    };
    expect(mod.resolveConfiguredModel("/proj")).toBe("local-model");
  });

  it("returns null when nothing is configured anywhere", () => {
    fsMock.existsReturnValue = false;
    expect(mod.resolveConfiguredModel("/proj")).toBeNull();
  });

  it("ignores malformed / model-less settings files", () => {
    fsMock.existsReturnValue = true;
    fsMock.readFileReturnValue = "{ not json";
    expect(mod.resolveConfiguredModel("/proj")).toBeNull();
    fsMock.readFileReturnValue = JSON.stringify({ somethingElse: 1 });
    expect(mod.resolveConfiguredModel("/proj")).toBeNull();
  });

  it("spawn with a null model resolves the default and sizes the window exactly (no floor)", async () => {
    // User's configured default is a 1M model; a null-model spawn must hand
    // claude --model explicitly AND size the auto-compact window to it, so the
    // env window == the meter window (no 200k floor, no later divergence).
    fsMock.existsReturnValue = (p: string) => p.endsWith("/.claude/settings.json");
    fsMock.readFileReturnValue = (p: string) =>
      p.endsWith("/.claude/settings.json") ? JSON.stringify({ model: "claude-opus-4-8" }) : "{}";
    const { meta } = await mod.startNewConversation({ cwd: "/x", model: null });
    const child = shared.children[0];
    expect(child.spawnArgs).toContain("--model");
    expect(child.spawnArgs[child.spawnArgs.indexOf("--model") + 1]).toBe("claude-opus-4-8");
    const env = child.spawnEnv as NodeJS.ProcessEnv;
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("1000000"); // sized, not floored
    expect(meta.lastStats?.contextWindow).toBe(1_000_000);
  });
});

describe("stdout parser: init frame binds the context window to the resolved model", () => {
  it("rebinds contextWindow when the init frame reports a qualified id (alias spawn)", async () => {
    // Spawn with a bare alias whose family is mixed only across versions; the
    // resolved id from the init frame is authoritative.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "sonnet" });
    // Alias "sonnet" -> latest family window (1M) at spawn.
    expect(mod.getActiveSession(sessionId)?.lastStats?.contextWindow).toBe(1_000_000);
    // Init reports an OLDER, 200k sonnet — the window must follow the model.
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "claude-sonnet-4-5",
    });
    await flush();
    expect(mod.getActiveSession(sessionId)?.lastStats?.model).toBe("claude-sonnet-4-5");
    expect(mod.getActiveSession(sessionId)?.lastStats?.contextWindow).toBe(200_000);
  });

  it("binds the window from init when the model was unknown at spawn", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: null });
    expect(mod.getActiveSession(sessionId)?.lastStats?.contextWindow).toBeUndefined();
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "claude-opus-4-8",
    });
    await flush();
    expect(mod.getActiveSession(sessionId)?.lastStats?.contextWindow).toBe(1_000_000);
  });

  it("keeps a known window when the init model is unrecognized (no wipe)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    expect(mod.getActiveSession(sessionId)?.lastStats?.contextWindow).toBe(1_000_000);
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "some-unknown-model",
    });
    await flush();
    // Model updates, but the previously-known window is NOT clobbered to a guess.
    expect(mod.getActiveSession(sessionId)?.lastStats?.model).toBe("some-unknown-model");
    expect(mod.getActiveSession(sessionId)?.lastStats?.contextWindow).toBe(1_000_000);
  });
});

describe("stdout parser: compact_boundary", () => {
  // Claude renders the compacted summary itself as a synthetic USER frame
  // (manual /compact verified; auto documented in claude-code #48740), which
  // the synthetic-frame path already turns into a kind=compaction row. The
  // boundary's only job here is to zero usage so the ctx meter drops promptly
  // WITHOUT synthesizing a second, duplicate row.
  for (const trigger of ["auto", "manual"] as const) {
    it(`${trigger} compaction zeroes usage and emits no boundary row`, async () => {
      const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
      // Prime a non-zero usage via a result frame so we can see it reset.
      (shared.children[0].stdout as any).pushLine({
        type: "result",
        usage: { input_tokens: 10, cache_read_input_tokens: 500_000, output_tokens: 20 },
        session_id: sessionId,
      });
      await flush();
      ingestEventLineMock.mockClear();
      (shared.children[0].stdout as any).pushLine({
        type: "system",
        subtype: "compact_boundary",
        session_id: sessionId,
        compact_metadata: { trigger, pre_tokens: 850_000 },
      });
      await flush();

      const usage = mod.getActiveSession(sessionId)?.lastStats?.usage;
      expect(usage).toEqual({
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0,
      });
      const compactionRows = ingestEventLineMock.mock.calls
        .map((c) => JSON.parse(c[0]))
        .filter((p) => p.ctx.kind === "compaction");
      expect(compactionRows).toHaveLength(0);
    });
  }

  it("auto compaction renders exactly ONE row (boundary resets usage; summary frame renders it)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    (shared.children[0].stdout as any).pushLine({
      type: "result",
      usage: { input_tokens: 10, cache_read_input_tokens: 850_000, output_tokens: 20 },
      session_id: sessionId,
    });
    await flush();
    ingestEventLineMock.mockClear();

    // The real auto-compaction sequence in stream-json output (claude-code
    // #48740): a compact_boundary, THEN the compacted summary as a synthetic
    // user frame. The boundary must NOT emit its own row, so only the summary
    // frame renders — exactly one kind=compaction row, no duplicate.
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger: "auto", pre_tokens: 850_000 },
    });
    (shared.children[0].stdout as any).pushLine({
      type: "user",
      isSynthetic: true,
      isReplay: false,
      message: { content: "This session is being continued from a previous conversation..." },
      session_id: sessionId,
    });
    await flush();

    const compactionRows = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0]))
      .filter((p) => p.ctx.kind === "compaction");
    expect(compactionRows).toHaveLength(1);
    expect(mod.getActiveSession(sessionId)?.lastStats?.usage).toEqual({
      input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("drops the meter to compact_metadata.post_tokens (not a bare 0) on the boundary", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    (shared.children[0].stdout as any).pushLine({
      type: "result",
      usage: { input_tokens: 10, cache_read_input_tokens: 800_000, output_tokens: 20 },
      session_id: sessionId,
    });
    await flush();
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger: "manual", pre_tokens: 800_000, post_tokens: 32_000 },
    });
    await flush();
    // Meter reflects the real post-compaction prompt size, not 0 and not 800k.
    const usage = mod.getActiveSession(sessionId)?.lastStats?.usage;
    expect(usage).toEqual({
      input_tokens: 32_000,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 0,
    });
  });

  it("manual /compact: the trailing result frame does NOT slam the meter back to ~100%", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    // Boundary drops the meter to the post-compaction size.
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger: "manual", pre_tokens: 900_000, post_tokens: 28_000 },
    });
    await flush();
    // The /compact turn's result frame aggregates the summarization read (which
    // scanned the full ~900k pre-compaction context). It must NOT overwrite the
    // post-compaction figure — no assistant message followed the boundary.
    (shared.children[0].stdout as any).pushLine({
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: sessionId,
      usage: { input_tokens: 40, cache_creation_input_tokens: 9_000, cache_read_input_tokens: 900_000, output_tokens: 200 },
    });
    await flush();
    const ls = mod.getActiveSession(sessionId)?.lastStats;
    // ctx stays at the post-compaction size…
    expect(ls?.usage?.input_tokens).toBe(28_000);
    expect(ls?.usage?.cache_read_input_tokens).toBe(0);
    // …while totals still book the summarization's real (billed) cache read.
    expect(ls?.totals?.cache_read_input_tokens).toBe(900_000);
  });

  it("auto-compaction: post-boundary assistant messages win over the baseline", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", model: "claude-opus-4-8" });
    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "compact_boundary",
      session_id: sessionId,
      compact_metadata: { trigger: "auto", pre_tokens: 900_000, post_tokens: 30_000 },
    });
    await flush();
    // The turn continues after auto-compaction: a real assistant call runs
    // against the compacted-plus-new context, which is the true current size.
    (shared.children[0].stdout as any).pushLine({
      type: "assistant",
      session_id: sessionId,
      message: {
        model: "claude-opus-4-8",
        content: [{ type: "text", text: "continuing" }],
        usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 41_000, output_tokens: 80 },
      },
    });
    await flush();
    (shared.children[0].stdout as any).pushLine({
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: sessionId,
      usage: { input_tokens: 50, cache_creation_input_tokens: 9_500, cache_read_input_tokens: 941_000, output_tokens: 300 },
    });
    await flush();
    const ls = mod.getActiveSession(sessionId)?.lastStats;
    // Meter = the post-boundary assistant call (~41.5k), not the 30k baseline
    // and not the result's cumulative ~950k.
    expect(ls?.usage).toEqual({
      input_tokens: 3,
      cache_creation_input_tokens: 500,
      cache_read_input_tokens: 41_000,
      output_tokens: 80,
    });
  });
});

describe("stdout parser: control_request (permission ask)", () => {
  it("records a pending permission request and ingests a PermissionRequest event", async () => {
    const { sessionId: pendingId } = await mod.startNewConversation({ cwd: "/workspace" });
    // First swap to a real session_id so canonical lookups work cleanly.
    (shared.children[0].stdout as any).pushLine({ type: "system", subtype: "init", session_id: "real-A" });
    await flush();
    (shared.children[0].stdout as any).pushLine({
      type: "control_request",
      request_id: "req-1",
      tool_use_id: "tu-1",
      session_id: "real-A",
      request: {
        subtype: "can_use_tool",
        tool_name: "Bash",
        input: { command: "rm -rf /tmp/foo" },
        decision_reason: "writes to /tmp",
      },
    });
    await flush();

    // Pending state holds the request.
    const pending = mod.getPendingRequests("real-A");
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe("req-1");
    expect(pending[0].toolName).toBe("Bash");
    expect(pending[0].toolUseId).toBe("tu-1");
    expect(pending[0].decisionReason).toBe("writes to /tmp");
    expect(pending[0].input).toEqual({ command: "rm -rf /tmp/foo" });

    // An event was ingested with hook=PermissionRequest.
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const permEvent = ingestCalls.find((e) => e.hook === "PermissionRequest");
    expect(permEvent).toBeDefined();
    expect(permEvent.ctx.tool_name).toBe("Bash");
    expect(permEvent.ctx.request_id).toBe("req-1");

    void pendingId;
  });

  it("ignores control_request frames without a can_use_tool subtype", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-B" });
    await flush();
    (shared.children[0].stdout as any).pushLine({
      type: "control_request",
      request_id: "req-X",
      session_id: "sid-B",
      request: { subtype: "something_else", tool_name: "ignored" },
    });
    await flush();

    expect(mod.getPendingRequests("sid-B")).toHaveLength(0);
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionRequest")).toBeUndefined();
  });
});

describe("respondToPermission", () => {
  it("drops the pending entry and ingests a PermissionResponse event (no stdin write)", async () => {
    // Earlier versions also wrote a control_response frame to claude's stdin
    // for forward-compat with a hypothetical stream-json permission protocol.
    // Empirically that frame caused claude in -p mode to exit mid-turn, so
    // we removed the write — the hook's stdout JSON is the sole signal that
    // unblocks the model now.
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[0];
    (child.stdout as any).pushLine({ type: "system", session_id: "sid-C" });
    await flush();
    (child.stdout as any).pushLine({
      type: "control_request",
      request_id: "req-7",
      tool_use_id: "tu-7",
      session_id: "sid-C",
      request: { subtype: "can_use_tool", tool_name: "Edit", input: { path: "a" } },
    });
    await flush();

    const writes: string[] = [];
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origWrite(chunk, ...rest);
    };

    const result = await mod.respondToPermission("sid-C", "req-7", "allow");
    expect(result.ok).toBe(true);

    expect(mod.getPendingRequests("sid-C")).toHaveLength(0);
    expect(writes.find((w) => w.includes("control_response"))).toBeUndefined();

    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionResponse" && e.ctx.decision === "allow"))
      .toBeDefined();
  });

  it("returns ok:false for unknown session", async () => {
    const r = await mod.respondToPermission("no-such-session", "req-9", "deny");
    expect(r.ok).toBe(false);
  });

  it("returns ok:false for unknown request id on a real session", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-D" });
    await flush();
    const r = await mod.respondToPermission("sid-D", "missing-req", "allow");
    expect(r.ok).toBe(false);
  });
});

describe("hook-driven permission flow (createPermissionRequest + awaitPermissionDecision)", () => {
  it("createPermissionRequest registers a pending entry and ingests a PermissionRequest event", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-E" });
    await flush();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-E",
      toolName: "Write",
      input: { path: "/workspace/foo.txt" },
      toolUseId: "tu-E1",
    });
    expect(requestId).toBe("tu-E1");
    expect(mod.getPendingRequests("sid-E")).toHaveLength(1);
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionRequest" && e.ctx.request_id === "tu-E1")).toBeDefined();
  });

  it("awaitPermissionDecision resolves with the decision when respondToPermission lands", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-F" });
    await flush();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-F", toolName: "Write", input: { path: "/workspace/foo.txt" }, toolUseId: "tu-F",
    });
    const waiter = mod.awaitPermissionDecision(requestId, 5000);
    // Simulate the dashboard responding before timeout.
    setImmediate(() => { void mod.respondToPermission("sid-F", requestId, "deny", "user said no"); });
    const result = await waiter;
    expect(result.decision).toBe("deny");
    expect(result.reason).toBe("user said no");
  });

  it("awaitPermissionDecision returns timeout when no decision arrives", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-G" });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-G", toolName: "Read", input: { path: "x" }, toolUseId: "tu-G" });
    const result = await mod.awaitPermissionDecision("tu-G", 1000);
    expect(result.decision).toBe("timeout");
  });

  it("awaitPermissionDecision consumes an early decision (race: dashboard responded before hook polled)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: "sid-H" });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-H", toolName: "Write", input: { p: "x" }, toolUseId: "tu-H" });
    // Dashboard responds BEFORE the hook ever starts long-polling.
    await mod.respondToPermission("sid-H", "tu-H", "allow", "approved early");
    // Now the hook's long-poll starts — should resolve immediately, not wait.
    const start = Date.now();
    const result = await mod.awaitPermissionDecision("tu-H", 5000);
    const elapsed = Date.now() - start;
    expect(result.decision).toBe("allow");
    expect(result.reason).toBe("approved early");
    expect(elapsed).toBeLessThan(100);
  });
});

describe("auto mode (unattended approval)", () => {
  // A REAL directory: isCriticalTool now resolves tool paths against the
  // session cwd, and containment fails closed on a cwd that can't be
  // canonicalized — so a placeholder like "/x" would make every tool critical
  // and mask what these tests are actually about.
  let autoCwd = "";

  async function prime(sid: string) {
    autoCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "auto-mode-"));
    await mod.startNewConversation({ cwd: autoCwd });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
  }

  it("fast-lanes a read inside the workdir with no card, and reports it inline", async () => {
    // Read/Glob/Grep used to be fast-allowed by the hook itself and never
    // reached the sandbox at all. They route here now; the common case must
    // still cost no card and no long-poll, or every file read gets slower.
    await prime("sid-rd1");
    const r = mod.createPermissionRequest({
      sessionId: "sid-rd1", toolName: "Read", input: { file_path: join(autoCwd, "src.ts") }, toolUseId: "rd-in",
    });
    expect(mod.getPendingRequests("sid-rd1")).toHaveLength(0);
    // peek is what /permission-ask returns inline so the hook can skip
    // /permission-wait — and it must NOT consume the decision.
    expect(mod.peekPermissionDecision(r.requestId)?.decision).toBe("allow");
    expect((await mod.awaitPermissionDecision(r.requestId, 500)).decision).toBe("allow");
  });

  it("escalates a read that escapes the workdir to a card", async () => {
    // The hole this closes: Read was an unlogged, unprompted way to pull the
    // sandbox token or ~/.claude/.credentials.json out of a session.
    await prime("sid-rd2");
    mod.createPermissionRequest({
      sessionId: "sid-rd2", toolName: "Read", input: { file_path: "/var/run/hooop/sandbox.token" }, toolUseId: "rd-out",
    });
    expect(mod.getPendingRequests("sid-rd2").some((p) => p.toolUseId === "rd-out")).toBe(true);
    expect((await mod.awaitPermissionDecision("rd-out", 200)).decision).toBe("timeout");
  });

  it("auto-approves routine tools with NO card once enabled", async () => {
    await prime("sid-am1");
    mod.setSessionAutoMode("sid-am1", true, "host");
    const w = mod.createPermissionRequest({
      sessionId: "sid-am1", toolName: "Write", input: { file_path: join(autoCwd, "x.ts"), content: "y" }, toolUseId: "am-w1",
    });
    expect(mod.getPendingRequests("sid-am1")).toHaveLength(0);
    expect((await mod.awaitPermissionDecision(w.requestId, 500)).decision).toBe("allow");
    // An ordinary MCP tool is routine too.
    const m = mod.createPermissionRequest({
      sessionId: "sid-am1", toolName: "mcp__plugin_hooop_tools__something", input: {}, toolUseId: "am-m1",
    });
    expect(mod.getPendingRequests("sid-am1")).toHaveLength(0);
    expect((await mod.awaitPermissionDecision(m.requestId, 500)).decision).toBe("allow");
  });

  it("still prompts for the critical set (git push, destructive bash, secret writes)", async () => {
    await prime("sid-am2");
    mod.setSessionAutoMode("sid-am2", true, "host");
    mod.createPermissionRequest({
      sessionId: "sid-am2", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "am-push",
    });
    expect(mod.getPendingRequests("sid-am2").some((p) => p.toolUseId === "am-push")).toBe(true);
    mod.createPermissionRequest({
      sessionId: "sid-am2", toolName: "Bash", input: { command: "rm -rf /workspace/build" }, toolUseId: "am-rm",
    });
    expect(mod.getPendingRequests("sid-am2").some((p) => p.toolUseId === "am-rm")).toBe(true);
    mod.createPermissionRequest({
      sessionId: "sid-am2", toolName: "Write", input: { file_path: "/home/agent/.ssh/authorized_keys", content: "k" }, toolUseId: "am-ssh",
    });
    expect(mod.getPendingRequests("sid-am2").some((p) => p.toolUseId === "am-ssh")).toBe(true);
    // All three must still be waiting on a real decision, not auto-allowed.
    expect((await mod.awaitPermissionDecision("am-push", 200)).decision).toBe("timeout");
  });

  it("STAMPS `critical` on the escalated ask, which is what makes it host-only", async () => {
    // Load-bearing, and quietly so. The permission route reads this flag to keep a
    // critical ask away from a full-capability peer — so if it ever stopped being
    // set, the ask would still escalate to a prompt (visible, reassuring) while
    // becoming answerable by the very participant the critical set exists to
    // contain (invisible). A fail-open with no symptom, which is why it is pinned
    // here next to the escalation itself rather than only at the route.
    await prime("sid-crit");
    const cases: Array<[string, string, unknown]> = [
      ["c-git", "Bash", { command: "git push origin main" }],
      ["c-rm", "Bash", { command: "rm -rf /workspace/build" }],
      ["c-ssh", "Write", { file_path: "/home/agent/.ssh/authorized_keys", content: "k" }],
      ["c-escape", "Write", { file_path: "/etc/hosts", content: "x" }],
    ];
    for (const [toolUseId, toolName, input] of cases) {
      mod.createPermissionRequest({ sessionId: "sid-crit", toolName, input, toolUseId });
    }
    const pending = mod.getPendingRequests("sid-crit");
    for (const [toolUseId] of cases) {
      const row = pending.find((p) => p.toolUseId === toolUseId);
      expect(row, toolUseId).toBeTruthy();
      expect(row!.critical, toolUseId).toBe(true);
    }
  });

  it("leaves `critical` falsy on a routine ask, so a peer keeps deciding those", async () => {
    // The other half: making everything critical would take co-driving away
    // instead of fixing the dangerous case.
    await prime("sid-routine");
    // INSIDE the session's own workdir: a path outside it is critical by
    // containment, which is the rule working rather than a routine ask.
    mod.createPermissionRequest({
      sessionId: "sid-routine", toolName: "Write",
      input: { file_path: join(autoCwd, "notes.md"), content: "hi" }, toolUseId: "r-write",
    });
    const row = mod.getPendingRequests("sid-routine").find((p) => p.toolUseId === "r-write");
    expect(row?.critical ?? false).toBe(false);
  });

  it("never auto-approves AskUserQuestion — it needs a real answer", async () => {
    await prime("sid-am3");
    mod.setSessionAutoMode("sid-am3", true, "host");
    mod.createPermissionRequest({
      sessionId: "sid-am3", toolName: "AskUserQuestion", input: { questions: [] }, toolUseId: "am-q",
    });
    expect(mod.getPendingRequests("sid-am3").some((p) => p.toolName === "AskUserQuestion")).toBe(true);
  });

  it("never auto-approves the BUNDLED MCP ask either — the alias is the name the model actually calls", async () => {
    // The regression this pins. The auto-mode guard compared the RAW tool name
    // against the native "AskUserQuestion", so the bundled alias sailed straight
    // through and was auto-approved: the gate allowed dispatch, the
    // declaration-only MCP handler acked, and the operator was never asked — the
    // model just saw a question-shaped success and carried on.
    //
    // The test above passes with the buggy guard (native name matches the
    // literal) and the MCP normalization test in the plan-mode block passes too
    // (auto mode is off there, so the branch is never reached). Only the
    // CROSSING — auto mode ON plus the alias — reproduces it, which is exactly
    // the case that shipped. Headless claude has no native AskUserQuestion, so
    // this alias is the only ask path a real dashboard session ever takes.
    await prime("sid-am-mcp");
    mod.setSessionAutoMode("sid-am-mcp", true, "host");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-am-mcp",
      toolName: "mcp__plugin_hooop_tools__ask_user_question",
      input: { questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] },
      toolUseId: "am-mcp-q",
    });
    // A real card surfaces, normalized to the native name for the AskQuestion UI…
    const q = mod.getPendingRequests("sid-am-mcp").find((p) => p.requestId === requestId);
    expect(q?.toolName).toBe("AskUserQuestion");
    // …and NO early decision is stashed, so the hook long-polls for a human
    // instead of being handed an allow.
    expect(mod.peekPermissionDecision(requestId)).toBeFalsy();
    expect((await mod.awaitPermissionDecision(requestId, 200)).decision).toBe("timeout");
  });

  // Auto mode covers TOOL CALLS. It is not a proxy for the two decisions that
  // are definitionally a human's: answering a question (above) and approving a
  // plan (below). Planning is never auto-approved, full stop.
  //
  // Both plan tests below pass today, but only because the plan-lifecycle block
  // sits ABOVE the unattended-approval branches in createPermissionRequest —
  // an ordering invariant that nothing else pins. Reorder those branches, or add
  // a new unattended branch above the plan block, and plans start getting
  // auto-approved with no card and no test failure. That is precisely how the
  // ask regression shipped, so pin the crossing here rather than trusting
  // statement order to hold under future edits.
  it("never auto-approves a NATIVE plan submission — planning always needs a human", async () => {
    await prime("sid-am-plan1");
    mod.setSessionAutoMode("sid-am-plan1", true, "host");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-am-plan1", toolName: "ExitPlanMode", input: { plan: "1. do X\n2. do Y" }, toolUseId: "am-plan-native",
    });
    // Denied, so the turn holds for approval — never auto-allowed…
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/submitted for review/i);
    // …and a review card surfaces for a human to actually decide on.
    expect(mod.getPendingRequests("sid-am-plan1").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });

  it("never auto-approves the BUNDLED MCP plan submission either", async () => {
    await prime("sid-am-plan2");
    mod.setSessionAutoMode("sid-am-plan2", true, "host");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-am-plan2",
      toolName: "mcp__plugin_hooop_tools__submit_plan",
      input: { plan: "1. do A\n2. do B" },
      toolUseId: "am-plan-mcp",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/submitted for review/i);
    expect(mod.getPendingRequests("sid-am-plan2").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });

  it("never auto-approves ENTERING plan mode", async () => {
    await prime("sid-am-plan3");
    mod.setSessionAutoMode("sid-am-plan3", true, "host");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-am-plan3",
      toolName: "mcp__plugin_hooop_tools__enter_plan_mode",
      input: {},
      toolUseId: "am-enter-plan",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/plan mode/i);
  });

  it("plan mode still wins over auto mode (a /plan turn stays read-only)", async () => {
    await prime("sid-am4");
    mod.setSessionAutoMode("sid-am4", true, "host");
    await mod.writeUserTurn("sid-am4", "/plan build the widget");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-am4", toolName: "Write", input: { file_path: "/x", content: "y" }, toolUseId: "am-plan-w",
    });
    expect(mod.getPendingRequests("sid-am4")).toHaveLength(0); // denied read-only, not auto-allowed
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/read-only|plan/i);
  });

  it("turning auto mode off re-gates routine tools", async () => {
    await prime("sid-am5");
    mod.setSessionAutoMode("sid-am5", true, "host");
    mod.setSessionAutoMode("sid-am5", false, "host");
    mod.createPermissionRequest({
      sessionId: "sid-am5", toolName: "Write", input: { file_path: "/x", content: "y" }, toolUseId: "am-off",
    });
    expect(mod.getPendingRequests("sid-am5").some((p) => p.toolUseId === "am-off")).toBe(true);
  });

  it("echoes the toggle as a command AND a paired Stop (clears the thinking indicator)", async () => {
    await prime("sid-am6");
    ingestEventLineMock.mockClear();
    mod.setSessionAutoMode("sid-am6", true, "host");
    const calls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const echo = calls.find((e) => e.hook === "UserPromptSubmit" && e.ctx.kind === "command");
    expect(echo).toBeDefined();
    expect(echo.ctx.prompt).toBe("/auto-mode on");
    // Without a paired Stop the client's isWaiting (set by the UserPromptSubmit
    // echo) never clears and the "thinking" spinner sticks forever.
    const stop = calls.find((e) => e.hook === "Stop");
    expect(stop).toBeDefined();
    expect(stop.ctx.session_id).toBe(echo.ctx.session_id);
  });
});

describe("/plan turn (plan-mode trigger)", () => {
  async function primeSession(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    const writes: string[] = [];
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origWrite(chunk, ...rest);
    };
    return { writes };
  }
  const frames = (writes: string[]) =>
    writes.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

  it("flips permission mode to plan and strips the /plan prefix, control frame first", async () => {
    const { writes } = await primeSession("sid-plan");
    await mod.writeUserTurn("sid-plan", "/plan implement the widget");
    const fs = frames(writes);
    const control = fs.find((f) => f.type === "control_request");
    expect(control?.request?.subtype).toBe("set_permission_mode");
    expect(control?.request?.mode).toBe("plan");
    const user = fs.find((f) => f.type === "user");
    // The task is forwarded VERBATIM with the /plan prefix stripped — no
    // per-turn planning brief lands in the conversation. Plan mode is engaged
    // via the set_permission_mode flip; the model is steered to submit_plan by
    // the session's appended system prompt (asserted in the spawn test), not by
    // text injected into this turn.
    expect(user?.message?.content?.[0]?.text).toContain("implement the widget");
    expect(user?.message?.content?.[0]?.text).not.toContain("/plan");
    expect(user?.message?.content?.[0]?.text).not.toMatch(/ExitPlanMode/);
    // The steering must never leak into the visible turn text.
    expect(user?.message?.content?.[0]?.text).not.toMatch(/submit_plan/);
    const joined = writes.join("");
    expect(joined.indexOf("set_permission_mode")).toBeLessThan(joined.indexOf("implement the widget"));
  });

  it("falls back to a minimal neutral nudge when /plan has no task", async () => {
    const { writes } = await primeSession("sid-plan2");
    await mod.writeUserTurn("sid-plan2", "/plan");
    const fs = frames(writes);
    expect(fs.find((f) => f.type === "control_request")?.request?.mode).toBe("plan");
    const text = fs.find((f) => f.type === "user")?.message?.content?.[0]?.text;
    // Bare `/plan` can't forward an empty turn, so it gets a minimal neutral
    // nudge — still no planning brief / ExitPlanMode instructions in the turn.
    expect(text).toMatch(/task we've been discussing/i);
    expect(text).not.toMatch(/ExitPlanMode/);
    expect(text).not.toMatch(/submit_plan/);
  });

  it("leaves a normal turn untouched (no mode change, verbatim text)", async () => {
    const { writes } = await primeSession("sid-normal");
    await mod.writeUserTurn("sid-normal", "just do the thing");
    expect(writes.join("")).not.toContain("set_permission_mode");
    expect(frames(writes).find((f) => f.type === "user")?.message?.content?.[0]?.text).toContain("just do the thing");
  });

  it("tags a /plan turn kind=command and preserves the original typed text for the transcript", async () => {
    await primeSession("sid-plan-attr");
    await mod.writeUserTurn("sid-plan-attr", "/plan implement the widget");
    // The model got the stripped task (asserted above), but the transcript must
    // reconcile with the optimistic "/plan …" row and show what was typed.
    const meta = mod.popPendingAuthor("sid-plan-attr");
    expect(meta.kind).toBe("command");
    expect(meta.promptOverride).toBe("/plan implement the widget");
  });

  it("does not tag a plain-text turn as a command, but overrides the prompt so the attribution prefix stays out of the transcript", async () => {
    await primeSession("sid-plain-attr");
    await mod.writeUserTurn("sid-plain-attr", "just do the thing");
    const meta = mod.popPendingAuthor("sid-plain-attr");
    expect(meta.kind).toBeNull();
    // The model-facing text carries the "[Session context: …]" prefix, so the
    // transcript-facing promptOverride restores exactly what the user typed.
    expect(meta.promptOverride).toBe("just do the thing");
  });

  it("rewrites #file mentions to claude's @ syntax for the model, keeping # in the transcript", async () => {
    // "@path" is claude's own sigil: the CLI expands it into an attachment
    // before the model sees the turn, and ignores "#path" entirely. So the
    // mention has to be translated on the way to stdin — but ONLY there, or the
    // "@" leaks back into everyone's transcript.
    const { writes } = await primeSession("sid-mention");
    await mod.writeUserTurn("sid-mention", "please read #src/index.ts:42 and #README.md");
    const text = frames(writes).find((f) => f.type === "user")?.message?.content?.[0]?.text;
    expect(text).toContain("please read @src/index.ts:42 and @README.md");
    expect(text).not.toContain("#src/index.ts");
    expect(mod.popPendingAuthor("sid-mention").promptOverride).toBe(
      "please read #src/index.ts:42 and #README.md",
    );
  });

  it("does not rewrite a '#' inside a pasted code block", async () => {
    // A pasted shell script's comments are not file references. This is the
    // regression the "@" sigil never had, so it has to be covered at the seam
    // and not only in the shared unit test.
    const { writes } = await primeSession("sid-mention-code");
    await mod.writeUserTurn("sid-mention-code", "run:\n```bash\n#!/bin/sh\n#setup\n```\nthen #a.ts");
    const text = frames(writes).find((f) => f.type === "user")?.message?.content?.[0]?.text;
    expect(text).toContain("#setup");
    expect(text).not.toContain("@setup");
    expect(text).toContain("then @a.ts");
  });

  it("does not tag a message that merely starts with a slash but isn't a command", async () => {
    await primeSession("sid-slashy");
    await mod.writeUserTurn("sid-slashy", "/etc/hosts got clobbered, please check");
    const meta = mod.popPendingAuthor("sid-slashy");
    expect(meta.kind).toBeNull();
    expect(meta.promptOverride).toBe("/etc/hosts got clobbered, please check");
  });

  it("attaches image blocks (image first, then text) to a turn", async () => {
    const { writes } = await primeSession("sid-img");
    await mod.writeUserTurn("sid-img", "what is this?", "host", null, {
      images: [{ media_type: "image/png", data: "QUJD" }],
    });
    const content = frames(writes).find((f) => f.type === "user")?.message?.content;
    expect(content[0]).toMatchObject({ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } });
    // Every turn carries an authoritative-author attribution prefix in the
    // model-facing text (the transcript still shows the raw typed text).
    expect(content[1].type).toBe("text");
    expect(content[1].text).toContain("what is this?");
    expect(content[1].text).toContain("from the host");
  });

  it("attributes an image-only turn with an author text block", async () => {
    const { writes } = await primeSession("sid-img2");
    await mod.writeUserTurn("sid-img2", "", "host", null, {
      images: [{ media_type: "image/jpeg", data: "Zm9v" }],
    });
    const content = frames(writes).find((f) => f.type === "user")?.message?.content;
    expect(content[0].type).toBe("image");
    // Even with no typed text, the attribution line is sent so the model knows
    // who shared the image.
    expect(content[1]).toMatchObject({ type: "text" });
    expect(content[1].text).toContain("from the host");
  });
});

describe("native passthrough commands (/compact, /cost) are forwarded bare", () => {
  async function primeSession(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    const writes: string[] = [];
    const origWrite = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return origWrite(chunk, ...rest);
    };
    return { writes };
  }
  const frames = (writes: string[]) =>
    writes.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const commandEchoes = () =>
    ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((e) => e.hook === "UserPromptSubmit" && e.ctx?.kind === "command");

  it("sends /compact to the subprocess BARE — slash at byte 0, no attribution prefix", async () => {
    const { writes } = await primeSession("sid-compact");
    ingestEventLineMock.mockClear();
    await mod.writeUserTurn("sid-compact", "/compact");
    const user = frames(writes).find((f) => f.type === "user");
    const text = user?.message?.content?.[0]?.text;
    // The whole point: claude only dispatches the command when the input begins
    // with the slash. The per-turn "[Session context: …]" prefix must be absent.
    expect(text).toBe("/compact");
    expect(text).not.toContain("Session context");
    // No permission-mode control frame (that's /plan-only).
    expect(writes.join("")).not.toContain("set_permission_mode");
  });

  it("forwards /compact arguments verbatim, still bare", async () => {
    const { writes } = await primeSession("sid-compact-args");
    await mod.writeUserTurn("sid-compact-args", "/compact focus on the auth refactor");
    const text = frames(writes).find((f) => f.type === "user")?.message?.content?.[0]?.text;
    expect(text).toBe("/compact focus on the auth refactor");
  });

  it("sends /cost bare too", async () => {
    const { writes } = await primeSession("sid-cost");
    await mod.writeUserTurn("sid-cost", "/cost");
    const text = frames(writes).find((f) => f.type === "user")?.message?.content?.[0]?.text;
    expect(text).toBe("/cost");
    expect(text).not.toContain("Session context");
  });

  it("does NOT enqueue a pending author (claude emits no UserPromptSubmit for these)", async () => {
    await primeSession("sid-compact-attr");
    await mod.writeUserTurn("sid-compact-attr", "/compact");
    // A queued author would be popped by — and mis-attribute — the NEXT real
    // turn, since the command produces no UserPromptSubmit to consume it.
    const meta = mod.popPendingAuthor("sid-compact-attr");
    expect(meta.author).toBeNull();
    expect(meta.kind).toBeNull();
    expect(meta.promptOverride).toBeNull();
  });

  it("synthesizes the command echo (kind=command) so the request persists in the transcript", async () => {
    await primeSession("sid-compact-echo");
    ingestEventLineMock.mockClear();
    await mod.writeUserTurn("sid-compact-echo", "/compact", "riley");
    const echoes = commandEchoes();
    expect(echoes).toHaveLength(1);
    expect(echoes[0].ctx.prompt).toBe("/compact");
    // Attribution rides on the echo (not the model-facing text).
    expect(echoes[0].ctx.author).toBe("riley");
  });

  it("does NOT bare-dispatch a command that arrives with an image (falls back to prefixed turn)", async () => {
    const { writes } = await primeSession("sid-compact-img");
    await mod.writeUserTurn("sid-compact-img", "/compact", "host", null, {
      images: [{ media_type: "image/png", data: "QUJD" }],
    });
    const content = frames(writes).find((f) => f.type === "user")?.message?.content;
    // Image first, then a prefixed text block — the command was NOT sent bare
    // (which would have neutralised it anyway, since the slash isn't at byte 0).
    expect(content[0].type).toBe("image");
    expect(content[1].text).toContain("Session context");
    expect(content[1].text).toContain("/compact");
  });

  it("still wraps an ordinary turn in the attribution prefix (regression guard)", async () => {
    const { writes } = await primeSession("sid-plain-prefix");
    await mod.writeUserTurn("sid-plain-prefix", "just do the thing");
    const text = frames(writes).find((f) => f.type === "user")?.message?.content?.[0]?.text;
    expect(text).toContain("Session context");
    expect(text).toContain("just do the thing");
  });
});

describe("control commands (/model, /stop) echo once as kind=command", () => {
  async function prime(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    return child;
  }
  const ingested = () => ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
  const commandEvents = () =>
    ingested().filter((e) => e.hook === "UserPromptSubmit" && e.ctx?.kind === "command");
  const stopEvents = () => ingested().filter((e) => e.hook === "Stop");

  it("setSessionModel echoes `/model <alias>` once, then a Stop confirmation", async () => {
    await prime("sid-model");
    mod.setSessionModel("sid-model", "opus", "host");
    const cmds = commandEvents();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].ctx.prompt).toBe("/model opus");
    expect(cmds[0].ctx.author).toBe("host");
    // The switch confirmation follows as the result — never a message to the model.
    expect(stopEvents().some((e) => /Model set to opus/.test(e.ctx.last_assistant_message))).toBe(true);
  });

  it("interruptSession echoes `/stop` once, then a Stop confirmation", async () => {
    await prime("sid-stop");
    await mod.interruptSession("sid-stop", "host");
    const cmds = commandEvents();
    expect(cmds).toHaveLength(1);
    expect(cmds[0].ctx.prompt).toBe("/stop");
    expect(cmds[0].ctx.author).toBe("host");
    expect(stopEvents().some((e) => /Turn stopped/.test(e.ctx.last_assistant_message))).toBe(true);
  });

  it("does not fake a /stop command for a stop nobody typed", async () => {
    // The dashboard stops the turn when the last viewer takes control of a
    // preview the agent was driving. Recording that as `/stop` put a command in
    // the transcript with a person's name on it, for something they did not do —
    // and in a shared session that person is whoever the request authenticated
    // as, not whoever reached into the page.
    await prime("sid-stop-why");
    await mod.interruptSession("sid-stop-why", "host", "a viewer took control of the preview");
    expect(commandEvents().some((e) => e.ctx.prompt === "/stop")).toBe(false);
  });

  it("tells the model why the turn stopped, not just that it did", async () => {
    // An unexplained stop is a state a model narrates or retries — it will
    // describe actions it never completed. The reason has to reach it, which
    // means the transcript, not just a log line.
    await prime("sid-stop-why2");
    await mod.interruptSession("sid-stop-why2", "host", "a viewer took control of the preview");

    const notices = ingested().filter(
      (e) => e.hook === "UserPromptSubmit" && e.ctx?.kind === "preview-taken-over");
    expect(notices).toHaveLength(1);
    expect(notices[0].ctx.prompt).toContain("took control of the preview");
    expect(stopEvents().some((e) => /took control of the preview/.test(e.ctx.last_assistant_message)))
      .toBe(true);
  });

  it("still echoes the command when a human really did type it", async () => {
    await prime("sid-stop-typed");
    await mod.interruptSession("sid-stop-typed", "host");
    expect(commandEvents().filter((e) => e.ctx.prompt === "/stop")).toHaveLength(1);
  });

  it("interruptSession is a silent no-op when nothing is running (no echo)", async () => {
    await prime("sid-idle");
    // Kill the child so there's nothing to interrupt.
    const slotChild = shared.children[shared.children.length - 1];
    slotChild.killed = true;
    await mod.interruptSession("sid-idle", "host");
    expect(commandEvents()).toHaveLength(0);
  });
});

describe("plan-mode enforcement (permission policy)", () => {
  // Real dir — see the note on the auto-mode prime(): tool paths are now
  // resolved against the session cwd.
  let planCwd = "";

  async function prime(sid: string) {
    planCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "plan-mode-"));
    await mod.startNewConversation({ cwd: planCwd });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
  }

  it("hard-denies mutating tools while a /plan turn is active (no dashboard card)", async () => {
    await prime("sid-pm1");
    await mod.writeUserTurn("sid-pm1", "/plan build the widget");
    for (const tool of ["Write", "Edit", "MultiEdit", "Bash", "Task"]) {
      const { requestId } = mod.createPermissionRequest({
        sessionId: "sid-pm1", toolName: tool, input: { command: "touch x" }, toolUseId: `t-${tool}`,
      });
      expect(mod.getPendingRequests("sid-pm1")).toHaveLength(0); // no card — answered immediately
      const r = await mod.awaitPermissionDecision(requestId, 500);
      expect(r.decision).toBe("deny");
      expect(r.reason).toMatch(/read-only|plan/i);
    }
  });

  it("allows read-only tools while planning", async () => {
    await prime("sid-pm2");
    await mod.writeUserTurn("sid-pm2", "/plan build X");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm2", toolName: "Read", input: { path: join(planCwd, "x") }, toolUseId: "r1",
    });
    expect((await mod.awaitPermissionDecision(requestId, 500)).decision).toBe("allow");
  });

  it("denies a read that escapes the workdir even while planning", async () => {
    // Plan mode is read-only, but "read-only" isn't "harmless" — plan mode was
    // otherwise a wide-open read surface over the whole container, including
    // the credentials and tokens that grant control-plane access.
    await prime("sid-pm2b");
    await mod.writeUserTurn("sid-pm2b", "/plan build X");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm2b", toolName: "Read", input: { file_path: "/home/agent/.claude/.credentials.json" }, toolUseId: "r-esc",
    });
    expect((await mod.awaitPermissionDecision(requestId, 500)).decision).toBe("deny");
  });

  it("captures the plan for review and denies ExitPlanMode (turn holds for approval)", async () => {
    await prime("sid-pm3");
    await mod.writeUserTurn("sid-pm3", "/plan build X");
    ingestEventLineMock.mockClear();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm3", toolName: "ExitPlanMode", input: { plan: "1. do X\n2. do Y" }, toolUseId: "e1",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/review/i);
    // The plan review (the annotatable card the dashboard renders) was created.
    const calls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const review = calls.find((e) => e.hook === "PermissionRequest" && e.ctx.tool_name === "ExitPlanMode");
    expect(review).toBeDefined();
    expect(String(review.ctx.tool_input)).toContain("do X");
    expect(mod.getPendingRequests("sid-pm3").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });

  it("non-plan Bash auto-allows without a card; git push escalates to a dashboard decision", async () => {
    await prime("sid-pm4"); // no /plan → not plan mode
    const ok = mod.createPermissionRequest({
      sessionId: "sid-pm4", toolName: "Bash", input: { command: "ls -la" }, toolUseId: "b1",
    });
    expect(mod.getPendingRequests("sid-pm4")).toHaveLength(0);
    expect((await mod.awaitPermissionDecision(ok.requestId, 500)).decision).toBe("allow");
    // git push must NOT auto-allow — it creates a dashboard-pending ask.
    mod.createPermissionRequest({
      sessionId: "sid-pm4", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "b2",
    });
    expect(mod.getPendingRequests("sid-pm4").some((p) => p.toolUseId === "b2")).toBe(true);
    expect((await mod.awaitPermissionDecision("b2", 300)).decision).toBe("timeout");
  });

  it("auto-allows an approved plan's routine tool calls, then re-gates after the next turn", async () => {
    await prime("sid-pm-ap");
    // The approval "proceed" turn (what respondToPermission injects on approve).
    await mod.writeUserTurn("sid-pm-ap", "The plan is approved — proceed with implementing it.", "host", null, {
      mode: "bypassPermissions",
      autoAllowRun: true,
    });
    // A mutating Write inside the workdir auto-allows with NO card.
    const w = mod.createPermissionRequest({
      sessionId: "sid-pm-ap", toolName: "Write", input: { file_path: join(planCwd, "x.ts"), content: "y" }, toolUseId: "w1",
    });
    expect(mod.getPendingRequests("sid-pm-ap")).toHaveLength(0);
    expect((await mod.awaitPermissionDecision(w.requestId, 500)).decision).toBe("allow");
    // The window is one turn: an ordinary next turn clears auto-allow, so a Write
    // escalates to a dashboard card again.
    await mod.writeUserTurn("sid-pm-ap", "now do something else", "host");
    mod.createPermissionRequest({
      sessionId: "sid-pm-ap", toolName: "Write", input: { file_path: join(planCwd, "z.ts"), content: "q" }, toolUseId: "w2",
    });
    expect(mod.getPendingRequests("sid-pm-ap").some((p) => p.toolUseId === "w2")).toBe(true);
    expect((await mod.awaitPermissionDecision("w2", 300)).decision).toBe("timeout");
  });

  it("an approved plan does NOT auto-allow an ask — the operator still gets the question", async () => {
    // Approving a plan authorizes its routine tool calls; it cannot pre-answer a
    // question the execution hasn't asked yet. This branch had no ask carve-out,
    // so an ask raised during an approved plan's execution turn — precisely when
    // the model is most likely to hit an unresolved decision — was auto-approved
    // and silently discarded.
    await prime("sid-pm-ask");
    await mod.writeUserTurn("sid-pm-ask", "The plan is approved — proceed with implementing it.", "host", null, {
      mode: "bypassPermissions",
      autoAllowRun: true,
    });
    // Both spellings: the native name and the bundled alias the model really calls.
    for (const [toolName, toolUseId] of [["AskUserQuestion", "ap-ask-native"], [MCP_ASK, "ap-ask-mcp"]] as const) {
      const { requestId } = mod.createPermissionRequest({
        sessionId: "sid-pm-ask",
        toolName,
        input: { questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }] },
        toolUseId,
      });
      expect(mod.getPendingRequests("sid-pm-ask").some((p) => p.requestId === requestId)).toBe(true);
      expect(mod.peekPermissionDecision(requestId)).toBeFalsy();
      expect((await mod.awaitPermissionDecision(requestId, 200)).decision).toBe("timeout");
    }
  });

  it("answering an ask during an approved plan keeps the auto-allow window open", async () => {
    // Regression guard for the fix that made asks prompt during an approved plan.
    // That made this path reachable for the first time, and the answer relay
    // rewrites slot.autoAllowPlanRun from its opts — so without carrying the flag
    // across, ONE clarifying question silently revoked the plan approval and
    // every remaining write in the run started re-prompting. Answering a question
    // continues the approved execution; it is not new work.
    await prime("sid-pm-askwin");
    await mod.writeUserTurn("sid-pm-askwin", "The plan is approved — proceed with implementing it.", "host", null, {
      mode: "bypassPermissions",
      autoAllowRun: true,
    });
    // Mid-execution the model asks a question — it must surface a card…
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm-askwin",
      toolName: MCP_ASK,
      input: { questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }] },
      toolUseId: "askwin-q",
    });
    expect(mod.getPendingRequests("sid-pm-askwin").some((p) => p.requestId === requestId)).toBe(true);
    // …the operator answers it. An answered ask is delivered as a DENY (that
    // unblocks the tool); the selection itself arrives as the follow-up turn.
    const res = await mod.respondToPermission("sid-pm-askwin", requestId, "deny", "A", false, "host");
    expect(res.ok).toBe(true);
    await flush();
    // …and the approved plan's window survives, so routine work still runs
    // unattended instead of stopping at a card for every file.
    const w = mod.createPermissionRequest({
      sessionId: "sid-pm-askwin", toolName: "Write", input: { file_path: join(planCwd, "after.ts"), content: "y" }, toolUseId: "after-ask",
    });
    expect(mod.getPendingRequests("sid-pm-askwin").some((p) => p.toolUseId === "after-ask")).toBe(false);
    expect((await mod.awaitPermissionDecision(w.requestId, 500)).decision).toBe("allow");
  });

  it("an approved plan's execution turn cannot auto-approve a NEW plan submission", async () => {
    // The sharpest version of "a plan is never auto-approved": the model is mid
    // execution of an already-approved plan (so slot.autoAllowPlanRun is set) and
    // submits a REVISED plan. Approval of plan A must not silently confer
    // approval on plan B — it goes back to the host for review like any other.
    await prime("sid-pm-replan");
    await mod.writeUserTurn("sid-pm-replan", "The plan is approved — proceed with implementing it.", "host", null, {
      mode: "bypassPermissions",
      autoAllowRun: true,
    });
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm-replan", toolName: MCP_SUBMIT, input: { plan: "a revised plan" }, toolUseId: "replan",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/submitted for review/i);
    expect(mod.getPendingRequests("sid-pm-replan").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });

  it("an approved plan does NOT auto-allow the critical set (git push, escapes from the workdir)", async () => {
    // This is a deliberate change. Approving a plan used to auto-allow
    // everything for that turn with no carve-out at all, which made it
    // strictly more permissive than auto mode — the thing a host has to opt
    // into explicitly. Approving a plan's TEXT is not approving whatever its
    // execution later decides to touch, and execution is exactly where
    // injected instructions would land.
    await prime("sid-pm-ap2");
    await mod.writeUserTurn("sid-pm-ap2", "The plan is approved — proceed with implementing it.", "host", null, {
      mode: "bypassPermissions",
      autoAllowRun: true,
    });

    mod.createPermissionRequest({
      sessionId: "sid-pm-ap2", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "ap-push",
    });
    expect(mod.getPendingRequests("sid-pm-ap2").some((p) => p.toolUseId === "ap-push")).toBe(true);
    expect((await mod.awaitPermissionDecision("ap-push", 200)).decision).toBe("timeout");

    mod.createPermissionRequest({
      sessionId: "sid-pm-ap2", toolName: "Write", input: { file_path: "/home/agent/.ssh/authorized_keys", content: "k" }, toolUseId: "ap-ssh",
    });
    expect(mod.getPendingRequests("sid-pm-ap2").some((p) => p.toolUseId === "ap-ssh")).toBe(true);
    expect((await mod.awaitPermissionDecision("ap-ssh", 200)).decision).toBe("timeout");
  });

  const MCP_SUBMIT = "mcp__plugin_hooop_tools__submit_plan";
  const MCP_ENTER = "mcp__plugin_hooop_tools__enter_plan_mode";
  const MCP_ASK = "mcp__plugin_hooop_tools__ask_user_question";

  it("bundled MCP submit_plan captures the plan for review and denies the call", async () => {
    await prime("sid-pm5");
    await mod.writeUserTurn("sid-pm5", "/plan build X");
    ingestEventLineMock.mockClear();
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm5", toolName: MCP_SUBMIT, input: { plan: "1. do A\n2. do B" }, toolUseId: "s1",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).toMatch(/review/i);
    const calls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const review = calls.find((e) => e.hook === "PermissionRequest" && e.ctx.tool_name === "ExitPlanMode");
    expect(review).toBeDefined();
    expect(String(review.ctx.tool_input)).toContain("do A");
    expect(mod.getPendingRequests("sid-pm5").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });

  it("submit_plan captures even OUTSIDE a plan turn (no stray dashboard card)", async () => {
    await prime("sid-pm6"); // no /plan
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pm6", toolName: MCP_SUBMIT, input: { plan: "the plan" }, toolUseId: "s2",
    });
    expect((await mod.awaitPermissionDecision(requestId, 500)).decision).toBe("deny");
    // The only pending is the plan review, not a permission card for the tool.
    const pending = mod.getPendingRequests("sid-pm6");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("ExitPlanMode");
    expect((pending[0].input as any).plan).toBe("the plan");
  });

  it("enter_plan_mode engages read-only mode (subsequent mutations denied)", async () => {
    await prime("sid-pm7"); // no /plan yet
    const enter = mod.createPermissionRequest({
      sessionId: "sid-pm7", toolName: MCP_ENTER, input: {}, toolUseId: "e1",
    });
    const er = await mod.awaitPermissionDecision(enter.requestId, 500);
    expect(er.decision).toBe("deny");
    expect(er.reason).toMatch(/plan mode|read-only/i);
    // Now a mutating tool is hard-denied (plan mode is engaged for the turn).
    const w = mod.createPermissionRequest({
      sessionId: "sid-pm7", toolName: "Write", input: { file_path: "/x" }, toolUseId: "w1",
    });
    expect((await mod.awaitPermissionDecision(w.requestId, 500)).decision).toBe("deny");
    // ...but reads inside the workdir still pass.
    const rd = mod.createPermissionRequest({
      sessionId: "sid-pm7", toolName: "Read", input: { file_path: join(planCwd, "x") }, toolUseId: "rd1",
    });
    expect((await mod.awaitPermissionDecision(rd.requestId, 500)).decision).toBe("allow");
  });

  it("bundled MCP ask_user_question normalizes to AskUserQuestion + surfaces a pending question (not auto-decided)", async () => {
    await prime("sid-ask1");
    const input = { questions: [{ question: "Pick one", options: [{ label: "A" }, { label: "B" }] }] };
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask1", toolName: MCP_ASK, input, toolUseId: "q1",
    });
    // It surfaces as a native-shaped AskUserQuestion pending request (routed to
    // the AskQuestion UI), carrying the questions — NOT auto-allowed/denied.
    const pending = mod.getPendingRequests("sid-ask1");
    const q = pending.find((p) => p.requestId === requestId);
    expect(q).toBeDefined();
    expect(q!.toolName).toBe("AskUserQuestion");
    expect((q!.input as any).questions[0].options).toHaveLength(2);
    // No early decision — it waits for the operator to answer.
    expect((await mod.awaitPermissionDecision(requestId, 200)).decision).toBe("timeout");
  });

  it("answering an MCP ask_user_question relays the answer as a follow-up turn", async () => {
    await prime("sid-ask2");
    const child = shared.children[shared.children.length - 1];
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask2", toolName: MCP_ASK,
      input: { questions: [{ question: "Which?", options: [{ label: "X" }, { label: "Y" }] }] }, toolUseId: "q2",
    });
    // Capture stdin writes to prove the answer is delivered as a follow-up turn.
    const writes: string[] = [];
    const orig = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => { writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8")); return orig(chunk, ...rest); };
    // The operator answers via a deny carrying the answer text (the native path).
    ingestEventLineMock.mockClear();
    const res = await mod.respondToPermission("sid-ask2", requestId, "deny", "Go with X");
    expect(res.ok).toBe(true);
    await flush();
    const joined = writes.join("");
    expect(joined).toContain("Go with X");
    expect(joined.toLowerCase()).toContain("answer to the question");
    // A deterministic "question-answer" lifecycle notice is ingested (so the
    // transcript can show "Question answered by X" instead of a peer bubble),
    // carrying the answer text.
    const ingested = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const notice = ingested.find((e) => e.hook === "UserPromptSubmit" && e.ctx.kind === "question-answer");
    expect(notice).toBeDefined();
    expect(notice.ctx.prompt).toContain("Go with X");
  });

  it("surfaces an AskUserQuestion DURING a /plan turn instead of hard-denying it", async () => {
    await prime("sid-ask-plan");
    await mod.writeUserTurn("sid-ask-plan", "/plan build the widget");
    const input = { questions: [{ question: "Which source?", options: [{ label: "A" }, { label: "B" }] }] };
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask-plan", toolName: MCP_ASK, input, toolUseId: "qp1",
    });
    // A clarifying question is read-only, so it surfaces as a pending card
    // rather than getting the plan-mode hard-deny that mutating tools receive.
    const q = mod.getPendingRequests("sid-ask-plan").find((p) => p.requestId === requestId);
    expect(q).toBeDefined();
    expect(q!.toolName).toBe("AskUserQuestion");
    expect(q!.planMode).toBe(true);
    expect((await mod.awaitPermissionDecision(requestId, 200)).decision).toBe("timeout");
    // A mutating tool in the same plan turn is still hard-denied — the carve-out
    // is scoped to AskUserQuestion only.
    const w = mod.createPermissionRequest({
      sessionId: "sid-ask-plan", toolName: "Write", input: { file_path: "/x" }, toolUseId: "wp1",
    });
    const wr = await mod.awaitPermissionDecision(w.requestId, 500);
    expect(wr.decision).toBe("deny");
    expect(wr.reason).toMatch(/read-only|plan/i);
  });

  it("stays in plan mode after answering a question asked during planning", async () => {
    await prime("sid-ask-plan2");
    await mod.writeUserTurn("sid-ask-plan2", "/plan build X");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-ask-plan2", toolName: MCP_ASK,
      input: { questions: [{ question: "Which?", options: [{ label: "X" }, { label: "Y" }] }] }, toolUseId: "qp2",
    });
    // Operator answers (deny + answer text = the native ask relay path).
    await mod.respondToPermission("sid-ask-plan2", requestId, "deny", "Go with X");
    await flush();
    // Regression guard: the answer turn must NOT silently drop plan enforcement.
    // A mutation is still hard-denied (no dashboard card), so the model keeps
    // planning until it submits a plan for approval.
    const w = mod.createPermissionRequest({
      sessionId: "sid-ask-plan2", toolName: "Write", input: { file_path: "/x" }, toolUseId: "wp2",
    });
    const wr = await mod.awaitPermissionDecision(w.requestId, 500);
    expect(wr.decision).toBe("deny");
    expect(wr.reason).toMatch(/read-only|plan/i);
    expect(mod.getPendingRequests("sid-ask-plan2").some((p) => p.toolUseId === "wp2")).toBe(false);
  });
});

describe("shared plan-review comments", () => {
  it("adds comments, lists them, and threads replies", () => {
    const c = mod.addPlanReviewComment({ requestId: "pr-1", author: "alice", quote: "step 1", offset: 5, length: 6, body: "too vague" });
    const list = mod.listPlanReviewComments("pr-1");
    expect(list).toHaveLength(1);
    expect(list[0].author).toBe("alice");
    expect(list[0].body).toBe("too vague");
    expect(mod.addPlanReviewReply({ requestId: "pr-1", commentId: c.id, author: "bob", body: "agree" })).toBe(true);
    expect(mod.listPlanReviewComments("pr-1")[0].replies[0]).toMatchObject({ author: "bob", body: "agree" });
  });

  it("only the author can edit or remove their comment", () => {
    const c = mod.addPlanReviewComment({ requestId: "pr-2", author: "alice", quote: "x", offset: 0, length: 1, body: "a" });
    expect(mod.editPlanReviewComment("pr-2", c.id, "bob", "hacked")).toBe("forbidden");
    expect(mod.editPlanReviewComment("pr-2", c.id, "alice", "edited")).toBe("ok");
    expect(mod.listPlanReviewComments("pr-2")[0].body).toBe("edited");
    expect(mod.removePlanReviewComment("pr-2", c.id, "bob")).toBe("forbidden");
    expect(mod.removePlanReviewComment("pr-2", c.id, "alice")).toBe("ok");
    expect(mod.listPlanReviewComments("pr-2")).toHaveLength(0);
  });

  it("clears a plan's comments once it is decided", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    (shared.children[shared.children.length - 1].stdout as any).pushLine({ type: "system", session_id: "sid-cc" });
    await flush();
    // A /plan turn makes ExitPlanMode capture into a review; the review carries
    // its own requestId (what the dashboard renders + attaches comments to).
    await mod.writeUserTurn("sid-cc", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-cc", toolName: "ExitPlanMode", input: { plan: "p" }, toolUseId: "tu-cc" });
    const requestId = mod.getPendingRequests("sid-cc").find((p) => p.toolName === "ExitPlanMode")!.requestId;
    mod.addPlanReviewComment({ requestId, author: "host", quote: "q", offset: 0, length: 1, body: "note" });
    expect(mod.listPlanReviewComments(requestId)).toHaveLength(1);
    await mod.respondToPermission("sid-cc", requestId, "allow");
    expect(mod.listPlanReviewComments(requestId)).toHaveLength(0);
  });
});

describe("robust plan capture (synthetic plan review)", () => {
  async function primePlanSession(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    return child;
  }
  const captureWrites = (child: any) => {
    const writes: string[] = [];
    const orig = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => { writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8")); return orig(chunk, ...rest); };
    return writes;
  };

  const SUBMIT_PLAN = "mcp__plugin_hooop_tools__submit_plan";

  it("surfaces a review when the model calls submit_plan (deterministic capture)", async () => {
    await primePlanSession("sid-pr1");
    await mod.writeUserTurn("sid-pr1", "/plan build a widget");
    mod.createPermissionRequest({ sessionId: "sid-pr1", toolName: SUBMIT_PLAN, input: { plan: "## Plan\n1. do a\n2. do b" }, toolUseId: "tu-pr1" });
    const pending = mod.getPendingRequests("sid-pr1");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("ExitPlanMode"); // surfaced under the native name the PlanPanel renders
    expect(pending[0].synthetic).toBe(true);
    expect((pending[0].input as any).plan).toContain("do a");
  });

  // The core regression (session d992864e): a plan-mode turn that ends with
  // PROSE and never calls submit_plan must NOT surface a review. Previously the
  // result frame synthesized a plan from the final message, turning declines,
  // clarifying questions, and acknowledgments into spurious Plan cards.
  it("does NOT surface a review when a /plan turn ends with prose but no submit_plan call", async () => {
    const child = await primePlanSession("sid-noprose");
    await mod.writeUserTurn("sid-noprose", "/plan build a widget");
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-noprose", message: { role: "assistant", content: [{ type: "text", text: "## Plan\n1. do a\n2. do b" }] } });
    (child.stdout as any).pushLine({ type: "result", session_id: "sid-noprose", result: "## Plan\n1. do a\n2. do b", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    expect(mod.getPendingRequests("sid-noprose")).toHaveLength(0);
  });

  // The exact reported case: reject a plan (re-enters plan mode), the model
  // replies conversationally instead of re-planning. That acknowledgment must
  // NOT become a new Plan card.
  it("does NOT surface a review for a conversational reply on a rejection-revise turn", async () => {
    const child = await primePlanSession("sid-revise");
    // Original plan submitted + rejected → the internal revise turn re-enters plan mode.
    await mod.writeUserTurn("sid-revise", "The plan was rejected. Revise it based on this feedback:\n\nnevermind, no script needed", "host", null, { mode: "plan", kind: "plan-rejection" });
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-revise", message: { role: "assistant", content: [{ type: "text", text: "Understood — no script needed. Let me know if you'd like anything else." }] } });
    (child.stdout as any).pushLine({ type: "result", session_id: "sid-revise", result: "Understood — no script needed. Let me know if you'd like anything else.", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    expect(mod.getPendingRequests("sid-revise")).toHaveLength(0);
  });

  it("falls back to the turn's assistant prose when submit_plan carries an empty plan arg", async () => {
    const child = await primePlanSession("sid-pr3");
    await mod.writeUserTurn("sid-pr3", "/plan build");
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-pr3", message: { role: "assistant", content: [{ type: "text", text: "Here is the plan prose." }] } });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-pr3", toolName: SUBMIT_PLAN, input: {}, toolUseId: "tu-pr3" });
    const review = mod.getPendingRequests("sid-pr3").find((p) => p.toolName === "ExitPlanMode");
    expect((review!.input as any).plan).toBe("Here is the plan prose.");
  });

  it("says NOTHING was captured when the plan arg AND the prose fallback are both empty", async () => {
    // With no plan text anywhere there is no review to open, so the deny must not
    // claim one was. It used to say "submitted for review" unconditionally, which
    // stopped the model to wait on an approval that could never arrive — the same
    // report-a-human-step-as-done failure as an auto-approved ask, and the reason
    // the ask MCP stub now reports non-delivery too. This one is recoverable, so
    // the message has to name the retry.
    await primePlanSession("sid-pr-empty");
    await mod.writeUserTurn("sid-pr-empty", "/plan build");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-pr-empty", toolName: SUBMIT_PLAN, input: {}, toolUseId: "tu-pr-empty",
    });
    expect(mod.getPendingRequests("sid-pr-empty").some((p) => p.toolName === "ExitPlanMode")).toBe(false);
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(r.reason).not.toMatch(/submitted for review/i);
    expect(r.reason).toMatch(/no plan was captured/i);
    expect(r.reason).toMatch(/submit_plan again/i);
  });

  // A `<synthetic>` notice (usage limit, "(no content)") is not the model
  // talking, so it must never pollute the empty-arg prose fallback.
  it("a synthetic notice does not become the empty-arg fallback plan", async () => {
    const child = await primePlanSession("sid-syn");
    await mod.writeUserTurn("sid-syn", "/plan build");
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-syn", message: { role: "assistant", content: [{ type: "text", text: "the real plan prose" }] } });
    (child.stdout as any).pushLine({ type: "assistant", session_id: "sid-syn", message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] } });
    await flush();
    mod.createPermissionRequest({ sessionId: "sid-syn", toolName: SUBMIT_PLAN, input: {}, toolUseId: "tu-syn" });
    const review = mod.getPendingRequests("sid-syn").find((p) => p.toolName === "ExitPlanMode");
    expect((review!.input as any).plan).toBe("the real plan prose");
  });

  it("submit_plan capture creates exactly one review (the result frame adds none)", async () => {
    const child = await primePlanSession("sid-pr2");
    await mod.writeUserTurn("sid-pr2", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-pr2", toolName: SUBMIT_PLAN, input: { plan: "explicit plan" }, toolUseId: "tu-pr2" });
    // The result frame must NOT create a second review — synthesis is gone.
    (child.stdout as any).pushLine({ type: "result", session_id: "sid-pr2", result: "done", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    const pending = mod.getPendingRequests("sid-pr2");
    expect(pending.filter((p) => p.toolName === "ExitPlanMode")).toHaveLength(1);
    expect((pending[0].input as any).plan).toBe("explicit plan");
  });

  it("approving a submitted plan review exits plan mode and sends a proceed turn", async () => {
    const child = await primePlanSession("sid-pr4");
    await mod.writeUserTurn("sid-pr4", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-pr4", toolName: SUBMIT_PLAN, input: { plan: "the plan" }, toolUseId: "tu-pr4" });
    const reqId = mod.getPendingRequests("sid-pr4")[0].requestId;
    const writes = captureWrites(child);
    ingestEventLineMock.mockClear();
    const res = await mod.respondToPermission("sid-pr4", reqId, "allow");
    expect(res.ok).toBe(true);
    await flush();
    const joined = writes.join("");
    expect(joined).toContain("set_permission_mode");
    expect(joined).toContain("bypassPermissions");
    expect(joined.toLowerCase()).toContain("proceed");
    expect(mod.getPendingRequests("sid-pr4")).toHaveLength(0);
    // The plan-approval notice is ingested deterministically (not carried on the
    // hidden "proceed" steering turn, which can be buffered/coalesced).
    const ingested = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingested.some((e) => e.hook === "UserPromptSubmit" && e.ctx.kind === "plan-approval")).toBe(true);
  });

  it("rejecting a submitted plan review sends the feedback and stays in plan mode", async () => {
    const child = await primePlanSession("sid-pr5");
    await mod.writeUserTurn("sid-pr5", "/plan build");
    mod.createPermissionRequest({ sessionId: "sid-pr5", toolName: SUBMIT_PLAN, input: { plan: "the plan" }, toolUseId: "tu-pr5" });
    const reqId = mod.getPendingRequests("sid-pr5")[0].requestId;
    const writes = captureWrites(child);
    ingestEventLineMock.mockClear();
    const res = await mod.respondToPermission("sid-pr5", reqId, "deny", "make it shorter");
    expect(res.ok).toBe(true);
    await flush();
    const joined = writes.join("");
    expect(joined).toContain("set_permission_mode");
    expect(joined).toContain("plan");
    expect(joined).toContain("make it shorter");
    expect(mod.getPendingRequests("sid-pr5")).toHaveLength(0);
    // A plan-rejection notice is ingested with the feedback for the transcript.
    const ingested = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    const notice = ingested.find((e) => e.hook === "UserPromptSubmit" && e.ctx.kind === "plan-rejection");
    expect(notice).toBeDefined();
    expect(notice.ctx.prompt).toContain("make it shorter");
  });
});

describe("permission asks with no live slot (session ended or remapped mid-flight)", () => {
  // NOT skill runs: since 27054af those are first-class sessions with their own
  // slot, tagged `via: "skill"` — the old detached spawn.ts path is gone. This
  // covers an ask whose slot is already gone by the time the gate asks: the
  // session ended, was purged, or had its id remapped between the tool call and
  // the ask. createPermissionRequest must still keep the request visible +
  // answerable even though getSlot() finds nothing, or the dashboard shows an
  // event with no card and the call times out to a deny.
  it("tracks a pending ask for a session with no slot and ingests the event", () => {
    const { requestId } = mod.createPermissionRequest({
      sessionId: "skill-sid-1",
      toolName: "Write",
      input: { path: "/workspace/report.md" },
      toolUseId: "tu-skill-1",
    });
    expect(requestId).toBe("tu-skill-1");
    const pending = mod.getPendingRequests("skill-sid-1");
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("Write");
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionRequest" && e.ctx.request_id === "tu-skill-1")).toBeDefined();
  });

  it("respondToPermission resolves a slot-less ask, clears it, and unblocks the waiter", async () => {
    const { requestId } = mod.createPermissionRequest({
      sessionId: "skill-sid-2",
      toolName: "Write",
      input: { path: "/workspace/x" },
      toolUseId: "tu-skill-2",
    });
    // The gate long-polls awaitPermissionDecision; confirm the decision reaches it.
    const decisionP = mod.awaitPermissionDecision(requestId, 5000);
    const result = await mod.respondToPermission("skill-sid-2", requestId, "allow");
    expect(result.ok).toBe(true);
    expect(mod.getPendingRequests("skill-sid-2")).toHaveLength(0);
    await expect(decisionP).resolves.toMatchObject({ decision: "allow" });
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionResponse" && e.ctx.request_id === "tu-skill-2" && e.ctx.decision === "allow")).toBeDefined();
  });

  it("returns ok:false for an unknown request on a slot-less session", async () => {
    mod.createPermissionRequest({ sessionId: "skill-sid-3", toolName: "Write", input: {}, toolUseId: "tu-skill-3" });
    const r = await mod.respondToPermission("skill-sid-3", "nope", "deny");
    expect(r.ok).toBe(false);
  });
});

describe("allow-all-from-peer (session-scoped auto-approve)", () => {
  // Drive a turn as a peer so the slot's currentTurn carries their shareId,
  // which is what createPermissionRequest attributes the ask to.
  // Real dir — see the note on the auto-mode prime(): tool paths are now
  // resolved against the session cwd.
  let peerCwd = "";

  async function primePeerTurn(sid: string, shareId: string) {
    peerCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "peer-turn-"));
    await mod.startNewConversation({ cwd: peerCwd });
    (shared.children[0].stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    await mod.writeUserTurn(sid, "do the thing", "Alice", shareId);
    // Simulate the server attributing the UserPromptSubmit → sets currentTurn.
    mod.popPendingAuthor(sid);
  }

  it("auto-approves a trusted peer's ask: no pending card, immediate allow, auto flag", async () => {
    await primePeerTurn("sid-T1", "share-1");
    mod.trustPeerForSession("sid-T1", "share-1");

    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-T1", toolName: "Write", input: { path: join(peerCwd, "x") }, toolUseId: "tu-T1",
    });
    // No card surfaces for an auto-approved ask.
    expect(mod.getPendingRequests("sid-T1")).toHaveLength(0);
    // The hook's long-poll resolves allow immediately (early decision stashed).
    const result = await mod.awaitPermissionDecision(requestId, 5000);
    expect(result.decision).toBe("allow");
    // Transcript records it as an auto-approval.
    const ingestCalls = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0] as string));
    expect(ingestCalls.find((e) => e.hook === "PermissionResponse" && e.ctx.request_id === "tu-T1" && e.ctx.auto === true)).toBeDefined();
  });

  it("escalates a trusted peer's write that escapes the session workdir", async () => {
    // Trusted-peer used to check ONLY git push, so a peer with "allow all"
    // could write anywhere on the filesystem unprompted — weaker than auto
    // mode, which at least consulted the secret-path denylist.
    await primePeerTurn("sid-T3", "share-3");
    mod.trustPeerForSession("sid-T3", "share-3");

    mod.createPermissionRequest({
      sessionId: "sid-T3", toolName: "Write", input: { file_path: "/home/agent/.ssh/authorized_keys" }, toolUseId: "tu-T3",
    });
    expect(mod.getPendingRequests("sid-T3").some((p) => p.toolUseId === "tu-T3")).toBe(true);
    expect((await mod.awaitPermissionDecision("tu-T3", 200)).decision).toBe("timeout");
  });

  it("still escalates git push from a trusted peer (the one guardrail)", async () => {
    await primePeerTurn("sid-T2", "share-2");
    mod.trustPeerForSession("sid-T2", "share-2");

    mod.createPermissionRequest({
      sessionId: "sid-T2", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "tu-T2",
    });
    // Push is NOT auto-approved — a card surfaces for the host.
    expect(mod.getPendingRequests("sid-T2")).toHaveLength(1);
  });

  it("does not auto-approve an untrusted peer's ask", async () => {
    await primePeerTurn("sid-T3", "share-3");
    // No trustPeerForSession call.
    mod.createPermissionRequest({
      sessionId: "sid-T3", toolName: "Write", input: { path: "/workspace/y" }, toolUseId: "tu-T3",
    });
    expect(mod.getPendingRequests("sid-T3")).toHaveLength(1);
    const pending = mod.getPendingRequests("sid-T3")[0];
    expect(pending.author).toBe("Alice");
  });

  it("does not auto-approve a trusted peer's ask — a question still needs a human", async () => {
    // "Allow all from Alice" is consent to run Alice's tool calls unattended, not
    // consent to answer questions on her behalf. This branch had no ask carve-out
    // at all, so a trusted peer's ask was swallowed the same way auto mode
    // swallowed it — for the native name as well as the alias.
    await primePeerTurn("sid-T-ask", "share-ask");
    mod.trustPeerForSession("sid-T-ask", "share-ask");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-T-ask",
      toolName: "mcp__plugin_hooop_tools__ask_user_question",
      input: { questions: [{ question: "Which approach?", options: [{ label: "A" }, { label: "B" }] }] },
      toolUseId: "tu-T-ask",
    });
    expect(mod.getPendingRequests("sid-T-ask").some((p) => p.requestId === requestId)).toBe(true);
    expect(mod.peekPermissionDecision(requestId)).toBeFalsy();
    expect((await mod.awaitPermissionDecision(requestId, 200)).decision).toBe("timeout");
  });

  it("does not auto-approve a trusted peer's plan — a plan is never auto-approved", async () => {
    // "Allow all from Alice" covers her tool calls. It cannot approve her plan:
    // plan approval is the host's review decision, not a permission grant.
    await primePeerTurn("sid-T-plan", "share-plan");
    mod.trustPeerForSession("sid-T-plan", "share-plan");
    const { requestId } = mod.createPermissionRequest({
      sessionId: "sid-T-plan",
      toolName: "mcp__plugin_hooop_tools__submit_plan",
      input: { plan: "1. ship it" },
      toolUseId: "tu-T-plan",
    });
    const r = await mod.awaitPermissionDecision(requestId, 500);
    expect(r.decision).toBe("deny");
    expect(mod.getPendingRequests("sid-T-plan").some((p) => p.toolName === "ExitPlanMode")).toBe(true);
  });
});

describe("isControllable", () => {
  it("returns true for a freshly-spawned (alive) session", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    expect(mod.isControllable(sessionId)).toBe(true);
  });

  it("returns false for an unknown sessionId", () => {
    expect(mod.isControllable("does-not-exist")).toBe(false);
  });
});

describe("listActiveSessions", () => {
  it("surfaces both freshly-spawned sessions, with the newer one first", async () => {
    const a = await mod.startNewConversation({ cwd: "/a" });
    await new Promise((r) => setTimeout(r, 5));
    const b = await mod.startNewConversation({ cwd: "/b" });

    const list = mod.listActiveSessions();
    const aEntry = list.find((s) => s.sessionId === a.sessionId);
    const bEntry = list.find((s) => s.sessionId === b.sessionId);
    expect(aEntry).toBeDefined();
    expect(bEntry).toBeDefined();
    const aIdx = list.findIndex((s) => s.sessionId === a.sessionId);
    const bIdx = list.findIndex((s) => s.sessionId === b.sessionId);
    expect(bIdx).toBeLessThan(aIdx);
  });
});

describe("API-failure frames (rate limit)", () => {
  // Shapes verified against a live rate-limited stream: the synthetic assistant
  // frame carries the error CLASS at the frame's top level (`error:"rate_limit"`)
  // — NOT isApiErrorMessage/apiErrorStatus, which exist only in the session
  // .jsonl. The result frame reports subtype:"success" with is_error:true.
  it("tags a synthetic API-error frame as kind=error (not the info catch-all)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: "real-rl" });
    await flush();
    ingestEventLineMock.mockClear();
    child.stdout.pushLine({
      type: "assistant",
      session_id: "real-rl",
      error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit · resets 11:10pm (UTC)" }] },
    });
    await flush();
    const ev = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => e.hook === "Stop");
    expect(ev).toBeDefined();
    expect(ev.ctx.kind).toBe("error");
    expect(ev.ctx.error).toBe("rate_limit");
    expect(ev.ctx.last_assistant_message).toMatch(/session limit/);
  });

  it("clears the thinking indicator at the result frame (no Stop hook fires on a failed turn)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: "real-rl2" });
    await flush();
    await mod.writeUserTurn("real-rl2", "do a thing");
    expect(mod.getActiveSession("real-rl2")?.turnActive).toBe(true);
    // A rate-limited turn: synthetic notice, then a result frame. No Stop HOOK
    // ever arrives (the model never ran), so the result frame must clear it or
    // every viewer's indicator spins forever.
    child.stdout.pushLine({
      type: "assistant",
      session_id: "real-rl2",
      error: "rate_limit",
      message: { role: "assistant", model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] },
    });
    child.stdout.pushLine({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "real-rl2",
      result: "You've hit your session limit",
      usage: {},
    });
    await flush();
    expect(mod.getActiveSession("real-rl2")?.turnActive).toBe(false);
    void sessionId;
  });
});

describe("markSessionActive (side-channel activity: !bash / chat)", () => {
  it("bumps lastSeenAt and broadcasts a change, without flipping turnActive", async () => {
    const events: any[] = [];
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[shared.children.length - 1].stdout.pushLine({ type: "system", session_id: "real-act" });
    await flush();
    const before = mod.getActiveSession("real-act")?.lastSeenAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));
    mod.activeSessionsBus.on("change", (p) => events.push(p));
    mod.markSessionActive("real-act");
    const after = mod.getActiveSession("real-act");
    expect(after?.lastSeenAt ?? 0).toBeGreaterThan(before);
    expect(after?.turnActive ?? false).toBe(false); // active, NOT "thinking"
    expect(events.some((e) => e.sessionId === "real-act")).toBe(true);
  });

  it("promotes a dormant session to alive (Active group) WITHOUT spawning claude", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.emit("close", 0); // → dormant
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");

    const spawnCountBefore = shared.children.length;
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    mod.markSessionActive(sessionId);

    const after = mod.getActiveSession(sessionId);
    expect(after?.status).toBe("alive");        // now surfaces in the Active group
    expect(after?.turnActive ?? false).toBe(false); // active, NOT "thinking"
    // No new subprocess: the promotion is lifecycle-only (no dormant→alive→ended flicker).
    expect(shared.children.length).toBe(spawnCountBefore);
    expect(events.some((e) => e.sessionId === sessionId && e.status === "alive")).toBe(true);
  });

  it("is a no-op for an unknown session (never throws)", () => {
    expect(() => mod.markSessionActive("no-such-session")).not.toThrow();
  });
});

describe("sweepIdleSessions (idle-TTL dormancy)", () => {
  const TTL = 30 * 60 * 1000; // default HOOOP_SESSION_IDLE_TTL_MS

  it("reaps an idle alive session → dormant (revivable), killing its child", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    // Just under the TTL: not reaped yet.
    expect(mod.sweepIdleSessions(lastSeen + TTL - 1000)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();

    // Past the TTL: reaped.
    expect(mod.sweepIdleSessions(lastSeen + TTL + 1000)).toContain(sessionId);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    // The kill's close (claude exits non-zero on SIGTERM) still lands "dormant"
    // because the reap flag forces it — and the slot stays registered (revivable).
    child.emit("close", 1);
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");
    expect(mod.isControllable(sessionId)).toBe(true);
  });

  it("does NOT reap a session with a turn in flight, even if idle past the TTL", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: sessionId });
    await flush();
    await mod.writeUserTurn(sessionId, "do a long thing"); // sets turnActive
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(mod.sweepIdleSessions(lastSeen + TTL * 10)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("demotes a childless 'alive' slot (marked-active via !bash/>chat) back to dormant after the TTL", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.emit("close", 0); // → dormant, child gone
    await flush();
    // A side-channel message marks it active with NO running child.
    mod.markSessionActive(sessionId);
    expect(mod.getActiveSession(sessionId)?.status).toBe("alive");
    (child.kill as any).mockClear();
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    // Under the TTL: still active, not touched.
    expect(mod.sweepIdleSessions(lastSeen + TTL - 1000)).not.toContain(sessionId);
    expect(mod.getActiveSession(sessionId)?.status).toBe("alive");

    // Past the TTL: demoted directly (no child to kill) and still revivable.
    expect(mod.sweepIdleSessions(lastSeen + TTL + 1000)).toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");
    expect(mod.isControllable(sessionId)).toBe(true);
  });

  it("does not reap a dormant session (nothing to kill)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.emit("close", 0); // → dormant
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");
    (child.kill as any).mockClear();
    expect(mod.sweepIdleSessions(Date.now() + TTL * 10)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("reaps a session whose plan review is still awaiting a decision", async () => {
    // The old guard skipped these, so such a session held a live subprocess
    // forever. Reviews are durable now: the card has to survive dormancy, which
    // is the whole point of persisting it.
    const sid = "idle-with-plan";
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    await mod.writeUserTurn(sid, "/plan build a widget");
    mod.createPermissionRequest({
      sessionId: sid,
      toolName: "mcp__plugin_hooop_tools__submit_plan",
      input: { plan: "## Plan\n1. do a" },
      toolUseId: "tu-idle-plan",
    });
    (child.stdout as any).pushLine({ type: "result", session_id: sid, result: "Plan submitted for review." });
    await flush();
    expect(mod.getPendingRequests(sid).some((p) => p.synthetic)).toBe(true);

    const lastSeen = mod.getActiveSession(sid)!.lastSeenAt;
    expect(mod.sweepIdleSessions(lastSeen + TTL + 1000)).toContain(sid);
    child.emit("close", 1);
    await flush();

    expect(mod.getActiveSession(sid)?.status).toBe("dormant");
    // The review is still there — losing a plan the user was about to approve is
    // the failure the old guard existed to prevent, and it must not come back.
    expect(mod.getPendingRequests(sid).some((p) => p.synthetic)).toBe(true);
    expect(mod.isControllable(sid)).toBe(true);
  });

  it("a per-session idleTtlMs SHORTER than the install default reaps earlier", async () => {
    const shortTtl = 5 * 60 * 1000; // well under the 30-minute default
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", idleTtlMs: shortTtl });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    // Under the session's OWN window: not reaped.
    expect(mod.sweepIdleSessions(lastSeen + shortTtl - 1000)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();

    // Past it (but still nowhere near the 30-minute install default): reaped.
    expect(mod.sweepIdleSessions(lastSeen + shortTtl + 1000)).toContain(sessionId);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("a per-session idleTtlMs LONGER than the install default reaps later", async () => {
    const longTtl = TTL * 3;
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", idleTtlMs: longTtl });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    // Past the INSTALL default, but this session's own window is much longer.
    expect(mod.sweepIdleSessions(lastSeen + TTL + 1000)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();

    // Past its own (longer) window: reaped.
    expect(mod.sweepIdleSessions(lastSeen + longTtl + 1000)).toContain(sessionId);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("idleTtlMs: 0 means this session never goes dormant, no matter how idle", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", idleTtlMs: 0 });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    expect(mod.sweepIdleSessions(lastSeen + TTL * 1000)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();
    expect(mod.getActiveSession(sessionId)?.status).toBe("alive");
  });
});

describe("effective idle TTL: a per-session override still works when the install default is disabled", () => {
  afterEach(() => {
    delete process.env.HOOOP_SESSION_IDLE_TTL_MS;
  });

  it("reaps a session on its OWN idleTtlMs even with HOOOP_SESSION_IDLE_TTL_MS=0", async () => {
    // IDLE_TTL_MS is read once at module load, so disabling the install
    // default requires a fresh import — mirrors how the "narrowing
    // HOOOP_CWD_ROOTS" test re-imports for a changed env var.
    process.env.HOOOP_SESSION_IDLE_TTL_MS = "0";
    vi.resetModules();
    shared.reset();
    fsMock.reset();
    mod = await import("./active-sessions");

    const shortTtl = 60 * 1000;
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", idleTtlMs: shortTtl });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    expect(mod.sweepIdleSessions(lastSeen + shortTtl + 1000)).toContain(sessionId);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("a session with no override still never reaps while the install default is 0", async () => {
    process.env.HOOOP_SESSION_IDLE_TTL_MS = "0";
    vi.resetModules();
    shared.reset();
    fsMock.reset();
    mod = await import("./active-sessions");

    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    expect(mod.sweepIdleSessions(lastSeen + 365 * 24 * 60 * 60 * 1000)).not.toContain(sessionId);
    expect(child.kill).not.toHaveBeenCalled();
  });
});

describe("sweepIdlePreviews (idle sessions release their preview)", () => {
  const TTL = 30 * 60 * 1000;

  /** Put a running preview in the fake registry for this session. */
  function givePreview(sessionId: string, name = "web") {
    previewsMock.records.push({
      previewId: "pv-idle", sessionId, slot: 1, slotPort: 7850,
      spec: { name, run: "npm run dev" }, state: "running",
      phase: { kind: "run" }, failedStep: null, failureReason: null, publicUrl: null,
    });
  }

  it("releases the preview of a session that has gone quiet, and remembers its spec", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    givePreview(sessionId);
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    expect(await mod.sweepIdlePreviews(lastSeen + TTL + 1000)).toContain("pv-idle");
    expect(previewsMock.records).toHaveLength(0);
    // Remembered so the panel can offer a one-click restart instead of asking
    // for the whole spec again.
    const meta = mod.getActiveSession(sessionId)!;
    expect(meta.lastPreviewSpec?.run).toBe("npm run dev");
    expect(meta.lastPreviewStoppedReason).toBe("idle");
  });

  it("leaves a preview alone until the session is actually idle", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    givePreview(sessionId);
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(await mod.sweepIdlePreviews(lastSeen + TTL - 1000)).toHaveLength(0);
    expect(previewsMock.records).toHaveLength(1);
  });

  it("releases the preview of a DORMANT session, not just an alive one", async () => {
    // The common case by far: claude exits after every turn, so a session spends
    // its idle time dormant. Keying this on the dormancy transition instead of on
    // idleness would have missed almost every session it is meant to catch.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.emit("close", 0);
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");
    givePreview(sessionId);

    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(await mod.sweepIdlePreviews(lastSeen + TTL + 1000)).toContain("pv-idle");
  });

  it("does not release while a turn is in flight", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: sessionId });
    await flush();
    await mod.writeUserTurn(sessionId, "keep working");
    givePreview(sessionId);
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(await mod.sweepIdlePreviews(lastSeen + TTL * 10)).toHaveLength(0);
    expect(previewsMock.records).toHaveLength(1);
  });

  it("measures idleness from the LAST touch, so activity spares the preview", async () => {
    // The half of the live bug that lives here. Caught in the browser, not by a
    // test: every case in this file builds a fresh session, so lastSeenAt was
    // always young — while in reality you start a preview on a session whose last
    // TURN was hours ago, and the next tick reaped it a minute later. The sweep
    // was right; nothing was touching the clock. The other half — that the start
    // and restart ROUTES call markSessionActive — has no unit test: this file
    // mocks previews wholesale and server.test.ts has no preview coverage to hang
    // it on. It is verified end-to-end instead.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.emit("close", 0);
    await flush();
    givePreview(sessionId);

    mod.markSessionActive(sessionId);
    const touched = mod.getActiveSession(sessionId)!.lastSeenAt;

    expect(await mod.sweepIdlePreviews(touched + TTL - 1000)).toHaveLength(0);
    expect(previewsMock.records).toHaveLength(1);
    expect(await mod.sweepIdlePreviews(touched + TTL + 1000)).toContain("pv-idle");
  });

  it("is a no-op for an idle session with no preview", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(await mod.sweepIdlePreviews(lastSeen + TTL * 10)).toHaveLength(0);
    expect(mod.getActiveSession(sessionId)?.lastPreviewStoppedReason).toBeUndefined();
  });

  // sweepIdleSessions and sweepIdlePreviews both claim to go through
  // effectiveIdleTtl(slot), not the install constant directly (see the shared
  // comment on effectiveIdleTtl). Only sweepIdleSessions had coverage for a
  // per-session override; a sweepIdlePreviews call site hard-wired back to
  // IDLE_TTL_MS would keep every other test in this describe green (they never
  // set idleTtlMs) while silently no longer respecting a session's own window.
  it("a per-session idleTtlMs SHORTER than the install default releases the preview EARLY", async () => {
    const shortTtl = 5 * 60 * 1000; // well under the 30-minute default
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", idleTtlMs: shortTtl });
    givePreview(sessionId);
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    // Under the session's OWN window: left alone.
    expect(await mod.sweepIdlePreviews(lastSeen + shortTtl - 1000)).toHaveLength(0);
    expect(previewsMock.records).toHaveLength(1);

    // Past it — nowhere near the 30-minute install default: released.
    expect(await mod.sweepIdlePreviews(lastSeen + shortTtl + 1000)).toContain("pv-idle");
    expect(previewsMock.records).toHaveLength(0);
  });

  it("idleTtlMs: 0 means the preview is never released, no matter how idle", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", idleTtlMs: 0 });
    givePreview(sessionId);
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    expect(await mod.sweepIdlePreviews(lastSeen + TTL * 1000)).toHaveLength(0);
    expect(previewsMock.records).toHaveLength(1);
  });
});

describe("sweepIdleShares (long-idle sessions lose their shares)", () => {
  const TTL = 30 * 60 * 1000;          // preview release
  const GRACE = 4 * 60 * 60 * 1000;    // default HOOOP_SESSION_SHARE_GRACE_MS

  it("keeps a share through the preview window and revokes it only past the grace", async () => {
    // The asymmetry IS the design: a released preview costs one click to bring
    // back, a revoked share costs a fresh invite. Cutting a pairing at the
    // 30-minute mark would punish someone for stepping out.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const share = sharesMod.createShare({ sessionId, publicHost: "x.trycloudflare.com" });
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    expect(mod.sweepIdleShares(lastSeen + TTL + 1000)).toHaveLength(0);
    expect(sharesMod.getShare(share.shareId)).toBeTruthy();

    expect(mod.sweepIdleShares(lastSeen + GRACE + 1000)).toContain(share.shareId);
    expect(sharesMod.getShare(share.shareId)).toBeFalsy();
  });

  it("leaves an old share on an ACTIVE session alone", async () => {
    // Session idleness, not share age — an ancient share on a session someone is
    // driving right now is none of the sweeper's business.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const share = sharesMod.createShare({ sessionId, publicHost: "x.trycloudflare.com" });
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(mod.sweepIdleShares(lastSeen + GRACE - 1000)).toHaveLength(0);
    expect(sharesMod.getShare(share.shareId)).toBeTruthy();
  });

  it("does not revoke while a turn is in flight", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    child.stdout.pushLine({ type: "system", session_id: sessionId });
    await flush();
    await mod.writeUserTurn(sessionId, "still working");
    const share = sharesMod.createShare({ sessionId, publicHost: "x.trycloudflare.com" });
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;
    expect(mod.sweepIdleShares(lastSeen + GRACE * 10)).toHaveLength(0);
    expect(sharesMod.getShare(share.shareId)).toBeTruthy();
  });
});

describe("stdout parser: result frames", () => {
  it("emits a 'turn' event and bumps lastSeenAt when a result frame arrives", async () => {
    const turns: any[] = [];
    mod.activeSessionsBus.on("turn", (p) => turns.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const before = mod.getActiveSession(sessionId)?.lastSeenAt ?? 0;
    await new Promise((r) => setTimeout(r, 5));

    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-r" });
    await flush();
    shared.children[0].stdout.pushLine({ type: "result", subtype: "success", result: "ok", session_id: "real-r" });
    await flush();

    expect(turns).toHaveLength(1);
    expect(turns[0].result).toBe("ok");
    const after = mod.getActiveSession("real-r")?.lastSeenAt ?? 0;
    expect(after).toBeGreaterThan(before);
  });

  it("captures per-turn usage + accumulates totals from a real result frame", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-u" });
    await flush();
    shared.children[0].stdout.pushLine({
      type: "result",
      subtype: "success",
      result: "ok",
      session_id: "real-u",
      usage: { input_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 900, output_tokens: 20 },
    });
    await flush();
    const ls = mod.getActiveSession("real-u")?.lastStats;
    expect(ls?.usage).toEqual({
      input_tokens: 5,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 900,
      output_tokens: 20,
    });
    expect(ls?.totals?.turns).toBe(1);
  });

  it("does NOT let a zero-usage (synthetic) result frame clobber real per-turn usage", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-z" });
    await flush();
    // Real turn.
    shared.children[0].stdout.pushLine({
      type: "result", subtype: "success", result: "ok", session_id: "real-z",
      usage: { input_tokens: 3, cache_creation_input_tokens: 50, cache_read_input_tokens: 70_000, output_tokens: 6 },
    });
    await flush();
    // Synthetic/no-op turn reports all-zero usage — must be ignored.
    shared.children[0].stdout.pushLine({
      type: "result", subtype: "success", result: "noop", session_id: "real-z",
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    });
    await flush();

    const ls = mod.getActiveSession("real-z")?.lastStats;
    // Usage still reflects the real turn (drives the dashboard's ctx %).
    expect(ls?.usage?.cache_read_input_tokens).toBe(70_000);
    // Turn counter not inflated by the synthetic frame.
    expect(ls?.totals?.turns).toBe(1);
  });

  it("ctx usage tracks the LAST assistant message, not the result frame's cumulative usage", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const out = shared.children[0].stdout;
    out.pushLine({ type: "system", session_id: "real-ctx" });
    await flush();
    // Two real API round-trips this turn (agentic: a tool call in between).
    // Each re-reads the ~54k prompt from cache; the LAST one is the true size.
    out.pushLine({
      type: "assistant", session_id: "real-ctx",
      message: { model: "claude-sonnet-5", content: [{ type: "text", text: "step 1" }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 397, cache_read_input_tokens: 53_720, output_tokens: 150 } },
    });
    await flush();
    out.pushLine({
      type: "assistant", session_id: "real-ctx",
      message: { model: "claude-sonnet-5", content: [{ type: "text", text: "step 2" }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 158, cache_read_input_tokens: 54_117, output_tokens: 132 } },
    });
    await flush();
    // Result frame reports usage CUMULATIVELY across the turn — cache_read balloons.
    out.pushLine({
      type: "result", subtype: "success", result: "ok", session_id: "real-ctx",
      usage: { input_tokens: 40, cache_creation_input_tokens: 9_455, cache_read_input_tokens: 990_241, output_tokens: 4_341 },
    });
    await flush();
    const ls = mod.getActiveSession("real-ctx")?.lastStats;
    // ctx usage = last assistant message (~54k), NOT the result frame's ~990k.
    expect(ls?.usage).toEqual({
      input_tokens: 2, cache_creation_input_tokens: 158, cache_read_input_tokens: 54_117, output_tokens: 132,
    });
    // totals still carry the result frame's cumulative (billing) figures.
    expect(ls?.totals?.cache_read_input_tokens).toBe(990_241);
  });

  it("ignores <synthetic> assistant frames when snapshotting ctx usage", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const out = shared.children[0].stdout;
    out.pushLine({ type: "system", session_id: "real-syn" });
    await flush();
    out.pushLine({
      type: "assistant", session_id: "real-syn",
      message: { model: "claude-sonnet-5", content: [{ type: "text", text: "real" }],
        usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 40_000, output_tokens: 10 } },
    });
    await flush();
    // Synthetic notice (usage limit / "(no content)") — must NOT overwrite ctx usage.
    out.pushLine({
      type: "assistant", session_id: "real-syn",
      message: { model: "<synthetic>", content: [{ type: "text", text: "Approaching usage limit" }],
        usage: { input_tokens: 0, cache_read_input_tokens: 999_999, output_tokens: 0 } },
    });
    await flush();
    out.pushLine({
      type: "result", subtype: "success", result: "ok", session_id: "real-syn",
      usage: { input_tokens: 20, cache_read_input_tokens: 500_000, output_tokens: 30 },
    });
    await flush();
    const ls = mod.getActiveSession("real-syn")?.lastStats;
    expect(ls?.usage?.cache_read_input_tokens).toBe(40_000);
  });

  it("recomputes ctx usage per turn (does not leak the previous turn's assistant usage)", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    const out = shared.children[0].stdout;
    out.pushLine({ type: "system", session_id: "real-rst" });
    await flush();
    // Turn 1.
    out.pushLine({
      type: "assistant", session_id: "real-rst",
      message: { model: "claude-sonnet-5", content: [{ type: "text", text: "t1" }],
        usage: { input_tokens: 1, cache_read_input_tokens: 10_000, output_tokens: 5 } },
    });
    await flush();
    out.pushLine({
      type: "result", subtype: "success", result: "ok", session_id: "real-rst",
      usage: { input_tokens: 1, cache_read_input_tokens: 10_000, output_tokens: 5 },
    });
    await flush();
    expect(mod.getActiveSession("real-rst")?.lastStats?.usage?.cache_read_input_tokens).toBe(10_000);
    // Turn 2 — different assistant usage; the result frame's inflated cache_read
    // must NOT win, and turn 1's snapshot must NOT leak via the fallback.
    out.pushLine({
      type: "assistant", session_id: "real-rst",
      message: { model: "claude-sonnet-5", content: [{ type: "text", text: "t2" }],
        usage: { input_tokens: 1, cache_read_input_tokens: 25_000, output_tokens: 5 } },
    });
    await flush();
    out.pushLine({
      type: "result", subtype: "success", result: "ok", session_id: "real-rst",
      usage: { input_tokens: 500, cache_read_input_tokens: 800_000, output_tokens: 50 },
    });
    await flush();
    expect(mod.getActiveSession("real-rst")?.lastStats?.usage?.cache_read_input_tokens).toBe(25_000);
  });
});

describe("wake resumes the transcript-bearing id (not the volatile canonical)", () => {
  it("re-keys the slot and resumes the alias whose .jsonl exists on disk", async () => {
    delete process.env.HOOOP_CWD_ROOTS;
    const fsReal = await import("node:fs");
    const readdir = fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>;
    // Real, resolvable cwd so the wake-time cwd policy passes cleanly.
    const realCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "wake-rekey-"));

    // Build a session that swapped ids twice: orig-has-transcript → then a
    // later (empty) resume minted canon-no-transcript. Mirrors the real bug
    // where only the earliest id has a transcript on disk.
    await mod.startNewConversation({ cwd: realCwd });
    const child = shared.children[0];
    child.stdout.pushLine({ type: "system", session_id: "orig-has-transcript" });
    await flush();
    child.stdout.pushLine({ type: "system", session_id: "canon-no-transcript" });
    await flush();
    expect(mod.getActiveSession("canon-no-transcript")?.sessionId).toBe("canon-no-transcript");
    const name = mod.getActiveSession("canon-no-transcript")?.displayName;

    // Subprocess exits cleanly → dormant (per the close-handler fix).
    child.emit("close", 0);
    await flush();
    expect(mod.getActiveSession("canon-no-transcript")?.status).toBe("dormant");

    // Only the ORIGINAL id has a transcript on disk.
    fsMock.existsReturnValue = (p: string) => p.endsWith("/projects");
    readdir.mockReturnValue(["-x"] as any);
    fsMock.statImpl = (p: string) => {
      if (p.endsWith("orig-has-transcript.jsonl")) return { mtimeMs: 1000 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    await mod.wakeSession("canon-no-transcript");

    // Re-keyed: the transcript-bearing id is the new canonical; the old
    // canonical still resolves to it; displayName preserved.
    expect(mod.getActiveSession("orig-has-transcript")?.sessionId).toBe("orig-has-transcript");
    expect(mod.getActiveSession("canon-no-transcript")?.sessionId).toBe("orig-has-transcript");
    expect(mod.getActiveSession("orig-has-transcript")?.displayName).toBe(name);

    readdir.mockReturnValue([] as any);
  });
});

describe("wake with no transcript on disk (session created without a Claude turn)", () => {
  // Regression (session 84170c83): a session can be created via the dashboard
  // and go dormant across a sandbox restart before it ever runs a turn, so it
  // has NO transcript. Earlier builds blindly `--resume`d it; `claude --resume`
  // exits 1 ("No conversation found with session ID"), the queued turn was
  // written into a dying stdin, and the session flickered dormant→alive→ended
  // with no answer. The fix: start a FRESH session under the SAME id so the
  // dashboard's URL stays valid and the turn is delivered. It must NOT prune.
  it("starts a FRESH session under the SAME id (--session-id, not --resume)", async () => {
    delete process.env.HOOOP_CWD_ROOTS;
    // Real, resolvable cwd so the wake-time cwd policy passes cleanly.
    const realCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "wake-fresh-"));

    const { sessionId } = await mod.startNewConversation({ cwd: realCwd });
    const child = shared.children[0];
    child.stdout.pushLine({ type: "system", session_id: sessionId });
    await flush();
    const name = mod.getActiveSession(sessionId)?.displayName;

    // Clean exit → dormant. The session never wrote a transcript.
    child.emit("close", 0);
    await flush();
    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");

    // No transcript anywhere on disk (default fs mock: existsSync=false).
    const meta = await mod.wakeSession(sessionId);

    // Not pruned; revived ALIVE under the SAME id, displayName preserved.
    expect(meta.status).toBe("alive");
    expect(meta.sessionId).toBe(sessionId);
    expect(mod.getActiveSession(sessionId)?.sessionId).toBe(sessionId);
    expect(mod.getActiveSession(sessionId)?.displayName).toBe(name);

    // The revived child was told to START that id (--session-id), NOT --resume it.
    const args = shared.children[shared.children.length - 1].spawnArgs as string[];
    const si = args.indexOf("--session-id");
    expect(si).toBeGreaterThanOrEqual(0);
    expect(args[si + 1]).toBe(sessionId);
    expect(args).not.toContain("--resume");
  });
});

describe("runtime resume-failure recovery (transcript exists but --resume dies)", () => {
  // Set up a dormant session that HAS a transcript on disk, so wakeSession takes
  // the `--resume` path (resumeSpawn=true). Returns the canonical id.
  async function primeDormantWithTranscript(
    opts: { idleTtlMs?: number | null; burnAfterUse?: boolean } = {},
  ): Promise<{ id: string; realCwd: string }> {
    delete process.env.HOOOP_CWD_ROOTS;
    const fsReal = await import("node:fs");
    const readdir = fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>;
    const realCwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "resume-fail-"));

    await mod.startNewConversation({ cwd: realCwd, ...opts });
    const child = shared.children[0];
    child.stdout.pushLine({ type: "system", session_id: "resumable-id" });
    await flush();
    child.emit("close", 0); // clean exit → dormant
    await flush();
    expect(mod.getActiveSession("resumable-id")?.status).toBe("dormant");

    // A transcript exists for the canonical id (so --resume is attempted).
    fsMock.existsReturnValue = (p: string) => p.endsWith("/projects");
    readdir.mockReturnValue(["-x"] as any);
    fsMock.statImpl = (p: string) => {
      if (p.endsWith("resumable-id.jsonl")) return { mtimeMs: 1000 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };
    return { id: "resumable-id", realCwd };
  }

  afterEach(async () => {
    const fsReal = await import("node:fs");
    (fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>).mockReturnValue([] as any);
  });

  it("a frame-less early exit on a resume spawn → fresh session (new id), old id aliased, turn replayed", async () => {
    const { id } = await primeDormantWithTranscript();
    const name = mod.getActiveSession(id)?.displayName;

    // Fire the turn but don't await yet — we need to drive the resumed child's
    // failure while writeUserTurn is parked watching the resume outcome.
    const p = mod.writeUserTurn(id, "please continue");
    await flush();

    // The resume spawn happened (child #2), told to --resume the canonical id.
    expect(shared.children).toHaveLength(2);
    const resumed = shared.children[1];
    expect(resumed.spawnArgs).toContain("--resume");
    expect(resumed.spawnArgs).toContain(id);

    // Simulate a corrupt/unreadable transcript: claude exits WITHOUT ever
    // emitting a frame (the turn we wrote is swallowed).
    resumed.emit("close", 1);

    const res = await p;

    // Recovery spawned a fresh child (#3) under a BRAND-NEW id via --session-id,
    // never --resume, and never reusing the old (transcript-claimed) id.
    expect(shared.children.length).toBeGreaterThanOrEqual(3);
    const fresh = shared.children[shared.children.length - 1];
    const args = fresh.spawnArgs as string[];
    const si = args.indexOf("--session-id");
    expect(si).toBeGreaterThanOrEqual(0);
    const newId = args[si + 1];
    expect(args).not.toContain("--resume");
    expect(newId).not.toBe(id);
    expect(newId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);

    // The returned id is the fresh one; the OLD id resolves to it via alias
    // (dashboard ?session=<oldId> stays valid); displayName carried over.
    expect(res.sessionId).toBe(newId);
    expect(mod.getActiveSession(id)?.sessionId).toBe(newId);
    expect(mod.getActiveSession(newId)?.status).toBe("alive");
    expect(mod.getActiveSession(newId)?.displayName).toBe(name);

    // A user-facing notice was recorded so the lost history isn't silent.
    const notice = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => typeof e?.ctx?.last_assistant_message === "string"
        && e.ctx.last_assistant_message.includes("Couldn't resume"));
    expect(notice).toBeDefined();
    expect(notice.ctx.session_id).toBe(newId);
  });

  it("a HEALTHY resume (child emits a frame) does NOT trigger recovery", async () => {
    const { id } = await primeDormantWithTranscript();

    const p = mod.writeUserTurn(id, "carry on");
    await flush();
    expect(shared.children).toHaveLength(2);
    const resumed = shared.children[1];

    // The resume takes: claude emits a frame. Use a swapped id so the post-write
    // waitForSwap resolves promptly instead of waiting out its timeout.
    resumed.stdout.pushLine({ type: "system", session_id: "resumed-live-id" });
    const res = await p;

    // No recovery spawn — still just the original + resumed child.
    expect(shared.children).toHaveLength(2);
    expect(res.sessionId).toBe("resumed-live-id");
    expect(mod.getActiveSession(id)?.sessionId).toBe("resumed-live-id");
    // No "couldn't resume" notice was emitted.
    const notice = ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .find((e) => typeof e?.ctx?.last_assistant_message === "string"
        && e.ctx.last_assistant_message.includes("Couldn't resume"));
    expect(notice).toBeUndefined();
  });

  // recoverWithFreshSession rebuilds the slot under a BRAND-NEW id (spawnControllable
  // builds fresh meta from scratch), so idleTtlMs/burnAfterUse are not there for free
  // the way they are on an ordinary field copy — each has to be threaded through
  // explicitly, same as wakeSession's carry-over (see the "wakeSession carries
  // idleTtlMs and burnAfterUse" test above). Losing burnAfterUse here would mean a
  // burn session that hits a corrupt-transcript resume failure silently becomes a
  // normal, permanent session instead of still self-destructing.
  //
  // Built directly off a checkpoint (like the idleTtlMs/burnAfterUse
  // round-trip tests elsewhere in this file) rather than off
  // primeDormantWithTranscript: that helper reaches "dormant" via a LIVE clean
  // exit, which for a burn-flagged session takes the self-destruct branch
  // instead of ever landing dormant — loadCheckpoint sets status="dormant"
  // directly, without going through that close-handler burn logic, and
  // burnRestoredSessions (the thing that WOULD destroy it) is a separate,
  // explicitly-invoked step this test never calls.
  it("recoverWithFreshSession carries idleTtlMs and burnAfterUse into the fresh (new-id) slot", async () => {
    const sid = "resumable-burn";
    const fsReal = await import("node:fs");
    const readdir = fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>;

    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json") || p.endsWith("/projects");
    fsMock.readFileReturnValue = makeCheckpoint(sid, tmpdir(), { idleTtlMs: 9_000, burnAfterUse: true });
    readdir.mockReturnValue(["-x"] as any);
    fsMock.statImpl = (p: string) => {
      if (p.endsWith(`${sid}.jsonl`)) return { mtimeMs: 1000 };
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    };

    mod.bootActiveSessions();
    expect(mod.getActiveSession(sid)?.status).toBe("dormant");

    const p = mod.writeUserTurn(sid, "please continue");
    await flush();
    expect(shared.children).toHaveLength(1);
    const resumed = shared.children[0];
    expect(resumed.spawnArgs).toContain("--resume");

    // Frame-less early exit on the resume spawn — the exact trigger for
    // recoverWithFreshSession, per the tests above.
    resumed.emit("close", 1);
    const res = await p;

    expect(res.sessionId).not.toBe(sid); // genuinely a new id, not the old one
    const meta = mod.getActiveSession(res.sessionId);
    expect(meta?.idleTtlMs).toBe(9_000);
    expect(meta?.burnAfterUse).toBe(true);

    readdir.mockReturnValue([] as any); // matches this describe's own afterEach cleanup
  });
});

describe("close handler: lifecycle on subprocess exit", () => {
  it("marks a clean (code 0) exit as dormant — a between-turns idle session, not ended", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-exit0" });
    await flush();
    shared.children[0].emit("close", 0);
    await flush();
    expect(mod.getActiveSession("real-exit0")?.status).toBe("dormant");
    expect(events.find((e) => e.sessionId === "real-exit0" && e.status === "dormant")).toBeDefined();
  });

  it("marks a non-zero exit as ended", async () => {
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-exit1" });
    await flush();
    shared.children[0].emit("close", 1);
    await flush();
    expect(mod.getActiveSession("real-exit1")?.status).toBe("ended");
  });
});

describe("burn-after-use", () => {
  const TTL = 30 * 60 * 1000; // default HOOOP_SESSION_IDLE_TTL_MS

  it("sweepIdleSessions destroys (not demotes) a burn-after-use session past its TTL", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    const child = shared.children[shared.children.length - 1];
    const lastSeen = mod.getActiveSession(sessionId)!.lastSeenAt;

    // destroySession's internal endSession() waits (up to 5s) for the child to
    // exit gracefully before force-killing it. Mark it already gone — same
    // trick the "endSession" suite above uses — so the teardown this triggers
    // resolves on its own instead of stalling the test on a real timer.
    child.killed = true;

    expect(mod.sweepIdleSessions(lastSeen + TTL + 1000)).toContain(sessionId);
    await flush();

    // Destroyed outright, not left dormant — there is no "revive this later"
    // for a burn session, so reapToDormant is never even set for it.
    expect(mod.getActiveSession(sessionId)).toBeUndefined();
    expect(mod.isControllable(sessionId)).toBe(false);
  });

  it("a burn-after-use session's clean exit (code 0) destroys it instead of going dormant", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    const child = shared.children[shared.children.length - 1];
    child.killed = true; // see above — lets the teardown skip its graceful-exit wait
    child.emit("close", 0); // the ordinary between-turns print-mode exit
    await flush();

    expect(mod.getActiveSession(sessionId)).toBeUndefined();
  });

  it("a burn-after-use session's abnormal (non-zero) exit is NOT burned — stays 'ended'", async () => {
    // A crash is exactly the moment a burn session's workspace/transcript are
    // most worth keeping around to inspect, so it must NOT be destroyed here.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    const child = shared.children[shared.children.length - 1];
    child.emit("close", 1); // never went through the idle sweep — a genuine crash
    await flush();

    expect(mod.getActiveSession(sessionId)?.status).toBe("ended");
    expect(mod.getActiveSession(sessionId)).toBeDefined();
  });
});

describe("setSessionBurnAfterUse", () => {
  it("flips the flag, persists it, and echoes a command + Stop pair", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    ingestEventLineMock.mockClear();

    const result = mod.setSessionBurnAfterUse(sessionId, true, "host");
    expect(result.burnAfterUse).toBe(true);
    expect(mod.getActiveSession(sessionId)?.burnAfterUse).toBe(true);

    const lines = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0]));
    const prompt = lines.find((l) => l.hook === "UserPromptSubmit");
    const stop = lines.find((l) => l.hook === "Stop");
    expect(prompt?.ctx.kind).toBe("command");
    expect(stop?.ctx.last_assistant_message).toMatch(/Burn after use enabled/);
  });

  it("is a no-op (no transcript echo) when already in the requested state", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    ingestEventLineMock.mockClear();

    const result = mod.setSessionBurnAfterUse(sessionId, true, "host");
    expect(result.burnAfterUse).toBe(true);
    expect(ingestEventLineMock).not.toHaveBeenCalled();
  });

  it("can be turned back off", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    ingestEventLineMock.mockClear();

    const result = mod.setSessionBurnAfterUse(sessionId, false, "host");
    expect(result.burnAfterUse).toBe(false);
    expect(mod.getActiveSession(sessionId)?.burnAfterUse).toBe(false);
    const lines = ingestEventLineMock.mock.calls.map((c) => JSON.parse(c[0]));
    expect(lines.find((l) => l.hook === "Stop")?.ctx.last_assistant_message).toMatch(/Burn after use disabled/);
  });

  it("throws for an unknown session", () => {
    expect(() => mod.setSessionBurnAfterUse("nope", true)).toThrow(/unknown session/);
  });
});

describe("destroySession", () => {
  // destroySession's doc comment is explicit that expandSessionIds MUST be
  // captured BEFORE deleteSession runs, because deleteSession -> endSession
  // clears the alias map, and a share/preview minted under a session's PRIOR id
  // (claude --resume re-keys mid-life) still belongs to this conversation. Swap
  // the two lines and this test fails: expandSessionIds(current-id), taken AFTER
  // the alias map is gone, no longer resolves the old id, so the old-id share
  // and preview are silently left behind instead of being cleaned up.
  it("revokes a share and reaps a preview registered under a PRIOR id (re-keyed session)", async () => {
    const { sessionId: startId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];

    // Re-key the session twice via the stdout parser's defensive id-swap (the
    // same mechanism the "swaps again if --resume yields a new id" test above
    // exercises), so `startId` is now a historical alias of "current-id" and
    // "old-id" sits in between.
    child.stdout.pushLine({ type: "system", session_id: "old-id" });
    await flush();
    child.stdout.pushLine({ type: "system", session_id: "current-id" });
    await flush();
    expect(mod.expandSessionIds("current-id").sort()).toEqual(["current-id", "old-id", startId].sort());

    // A share and a preview minted while the session was still known as "old-id".
    const share = sharesMod.createShare({ sessionId: "old-id", publicHost: "x.trycloudflare.com" });
    previewsMock.records.push({
      previewId: "pv-old-id", sessionId: "old-id", slot: 1, slotPort: 7850,
      spec: { name: "web", run: "npm run dev" }, state: "running",
      phase: { kind: "run" }, failedStep: null, failureReason: null, publicUrl: null,
    });

    child.killed = true; // skip the graceful-exit wait — not what this test is about
    const result = await mod.destroySession("current-id");

    expect(result.sharesRevoked).toBe(1);
    expect(result.previewsStopped).toBe(1);
    expect(sharesMod.getShare(share.shareId)).toBeFalsy();
    expect(previewsMock.reaped).toContain("pv-old-id");
    expect(previewsMock.records.find((r) => r.previewId === "pv-old-id")).toBeUndefined();
  });

  // The re-entrancy guard (slot.destroying, set before anything else runs) is
  // what stops deleteSession -> endSession's child-close from looping a
  // burn-after-use teardown back into destroySession forever, and stops two
  // racing callers from tearing the same session down twice. Keep the child
  // "alive" (not killed) so endSession's graceful-exit wait holds the slot open
  // long enough for a second, concurrent call to actually race the first.
  it("a second concurrent destroySession() call on the same id no-ops instead of tearing down twice", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    const share = sharesMod.createShare({ sessionId, publicHost: "x.trycloudflare.com" });
    previewsMock.records.push({
      previewId: "pv-reentrant", sessionId, slot: 1, slotPort: 7850,
      spec: { name: "web", run: "npm run dev" }, state: "running",
      phase: { kind: "run" }, failedStep: null, failureReason: null, publicUrl: null,
    });

    const first = mod.destroySession(sessionId);
    const second = await mod.destroySession(sessionId);

    // The guard's exact no-op shape. Not merely "nothing left to revoke" — the
    // share and preview above are still live at this point, waiting for the
    // FIRST call to claim them once it actually runs its teardown.
    expect(second).toEqual({ deleted: false, workspaceRemoved: false, sharesRevoked: 0, previewsStopped: 0 });

    // Let the real teardown (still in flight on `first`) finish.
    child.emit("close", 0);
    const result = await first;

    expect(result.sharesRevoked).toBe(1);
    expect(result.previewsStopped).toBe(1);
    expect(sharesMod.getShare(share.shareId)).toBeFalsy();
    await flush();
  });
});

describe("slot.destroying guards (mid burn-after-use teardown)", () => {
  it("writeUserTurn refuses a session mid-teardown instead of writing into a closing stdin", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    // Don't mark killed — destroySession's own graceful-exit wait keeps the
    // slot (and slot.destroying) around long enough to observe the guard.
    const destroyPromise = mod.destroySession(sessionId);

    await expect(mod.writeUserTurn(sessionId, "hello")).rejects.toThrow(/being deleted/);

    child.emit("close", 0);
    await destroyPromise;
    await flush();
  });

  it("setSessionBurnAfterUse refuses to 'cancel' a burn whose teardown already started", async () => {
    // The cancel path is the one place a false success is worse than an error:
    // the host clicks ✕ during the seconds a teardown takes, and without this
    // guard got a 200 plus a "🔥 Burn after use disabled." transcript line while
    // the workspace, transcript, events and shares were deleted anyway. Being
    // told you saved the data beats losing it only if it is true.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    const child = shared.children[shared.children.length - 1];
    const destroyPromise = mod.destroySession(sessionId);

    expect(() => mod.setSessionBurnAfterUse(sessionId, false)).toThrow(/being deleted/);
    // And the flag it refused to change is still armed, not half-applied.
    expect(mod.getActiveSession(sessionId)?.burnAfterUse).toBe(true);

    child.emit("close", 0);
    await destroyPromise;
    await flush();
  });

  it("markSessionActive no-ops on a session mid-teardown (does not resurrect it)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    const lastSeenBefore = mod.getActiveSession(sessionId)!.lastSeenAt;

    const destroyPromise = mod.destroySession(sessionId);
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    await new Promise((r) => setTimeout(r, 5)); // let the clock move
    mod.markSessionActive(sessionId);

    // No-op: lastSeenAt untouched and no "change" broadcast. Without the
    // destroying guard, markSessionActive always bumps lastSeenAt and emits a
    // change even for an already-"alive" session (see the markSessionActive
    // describe block above) — the guard is what stops a side-channel
    // `!bash`/`>chat` from putting this row back in the dashboard's Active
    // group on top of a workspace/transcript destroySession is deleting.
    expect(mod.getActiveSession(sessionId)?.lastSeenAt).toBe(lastSeenBefore);
    expect(events).toHaveLength(0);

    child.emit("close", 0);
    await destroyPromise;
    await flush();
  });
});

describe("shutdownActiveSessions vs burn-after-use", () => {
  it("a burn session whose child closes during a shutdown drain lands on dormant, not destroyed", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    const child = shared.children[shared.children.length - 1];

    const shutdown = mod.shutdownActiveSessions();
    // The drain's own kill produces a close that looks EXACTLY like the
    // ordinary idle/clean exit a burn session is supposed to self-destruct on
    // — _draining is what tells the close handler these are different, so it
    // must land on "dormant" here instead of racing process.exit with an
    // async teardown that would strand a half-deleted session.
    child.emit("close", 0);
    await shutdown;
    await flush();

    expect(mod.getActiveSession(sessionId)?.status).toBe("dormant");
    expect(mod.getActiveSession(sessionId)?.burnAfterUse).toBe(true);
  });
});

describe("close handler: burn-after-use status ordering", () => {
  it("emits status='ended' (with the exit code) synchronously, before the async burn teardown starts", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", burnAfterUse: true });
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));
    const child = shared.children[shared.children.length - 1];
    child.killed = true; // skip destroySession's own graceful-exit wait/timer

    child.emit("close", 0);

    // A clean (code 0) exit on a burn session is exactly the case the ordering
    // fix targets. An "ended" change event carrying this exit code can only come
    // from the close handler's OWN write, made before it kicks off destroySession
    // — a regression that goes back to returning early without it would either
    // never fire this event or fire a stale "alive" one instead.
    const endedEvent = events.find((e) => e.sessionId === sessionId && e.status === "ended");
    expect(endedEvent).toBeDefined();
    expect(endedEvent.exitCode).toBe(0);

    await flush();
  });
});

describe("displayName seeding", () => {
  it("seeds a haiku-style displayName on create when no name is given", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const name = mod.getActiveSession(sessionId)?.displayName;
    expect(name).toBeTruthy();
    // adjective-gerund-surname, all lowercase, dash-separated, three parts.
    expect(name).toMatch(/^[a-z]+-[a-z]+-[a-z]+$/);
  });

  it("uses the user-provided name verbatim when given", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x", name: "my-thing" });
    expect(mod.getActiveSession(sessionId)?.displayName).toBe("my-thing");
  });

  it("does NOT overwrite displayName from the first user prompt", async () => {
    // The previous build auto-renamed sessions from their first prompt's
    // text. That made names jump around on revive and turned every session
    // into a slug of its opening message. Now the haiku-name set at create
    // time survives until the user explicitly renames.
    await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-name" });
    await flush();

    const before = mod.getActiveSession("real-name")?.displayName;
    expect(before).toBeTruthy();

    await mod.writeUserTurn(
      "real-name",
      "Reorganise the project tree to use module-per-feature layout",
    );

    expect(mod.getActiveSession("real-name")?.displayName).toBe(before);
  });
});

describe("workspace transcript migration", () => {
  it("moves *.jsonl from the legacy -workspace project dir into -home-agent-workspace at boot", async () => {
    const fsReal = await import("node:fs");
    const renameSync = fsReal.renameSync as unknown as ReturnType<typeof vi.fn>;
    const readdirSync = fsReal.readdirSync as unknown as ReturnType<typeof vi.fn>;
    renameSync.mockClear();

    // Checkpoint exists; the legacy project dir exists; destination jsonls
    // don't (so they get moved). Everything else: not found.
    fsMock.existsReturnValue = (p: string) => {
      if (p.endsWith("active-sessions.json")) return true;
      if (p.endsWith("/-workspace")) return true;     // old project dir
      if (p.endsWith(".jsonl")) return false;          // dst not present yet
      return false;
    };
    fsMock.readFileReturnValue = makeCheckpoint("sess-mig", "/workspace");
    // Old project dir holds one transcript + one non-jsonl that must be skipped.
    readdirSync.mockReturnValue(["sess-mig.jsonl", "notes.txt"] as any);

    mod.bootActiveSessions();

    const calls = renameSync.mock.calls.map((c) => [String(c[0]), String(c[1])]);
    const moved = calls.find(([src]) => src.endsWith("/-workspace/sess-mig.jsonl"));
    expect(moved).toBeDefined();
    expect(moved![1]).toContain("/-home-agent-workspace/sess-mig.jsonl");
    // The non-jsonl file is never moved.
    expect(calls.some(([src]) => src.endsWith("notes.txt"))).toBe(false);

    readdirSync.mockReturnValue([] as any);
  });
});

describe("endSession", () => {
  it("removes the slot from the registry and emits a status=ended change event", async () => {
    const events: any[] = [];
    mod.activeSessionsBus.on("change", (p) => events.push(p));

    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    shared.children[0].stdout.pushLine({ type: "system", session_id: "real-end" });
    await flush();
    expect(mod.getActiveSession("real-end")).toBeDefined();

    // Fake a graceful close (no real child kill in tests).
    const child = shared.children[0];
    child.killed = true;
    const endPromise = mod.endSession("real-end");
    child.emit("close", 0);
    await endPromise;

    expect(mod.getActiveSession("real-end")).toBeUndefined();
    expect(mod.getActiveSession(sessionId)).toBeUndefined();
    const endEvt = events.find((e) => e.status === "ended" && e.sessionId === "real-end");
    expect(endEvt).toBeDefined();
  });

  it("is a no-op for an unknown sessionId", async () => {
    await expect(mod.endSession("never-spawned")).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// dormant session revival + cwd policy re-application
// ---------------------------------------------------------------------------

/**
 * Build a minimal checkpoint JSON string for a single dormant session.
 */
function makeCheckpoint(
  sessionId: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    sessions: [
      {
        sessionId,
        runId: null,
        label: "test session",
        displayName: null,
        cwd,
        via: "new-conversation",
        startedAt: Date.now() - 1000,
        lastSeenAt: Date.now() - 500,
        ...extra,
      },
    ],
  });
}

/**
 * Configure the fs mock so bootActiveSessions will load the given checkpoint.
 * Must be called BEFORE importing the module (i.e. before bootActiveSessions runs).
 */
function stubCheckpoint(sessionId: string, cwd: string) {
  const payload = makeCheckpoint(sessionId, cwd);
  fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
  fsMock.readFileReturnValue = payload;
}

describe("dormant session revival: cwd policy re-application", () => {
  let tmpAllowedRoot: string;
  let tmpOtherRoot: string;

  beforeEach(() => {
    // Use the real fs functions (captured before the mock overrides them) so
    // that directories we create actually exist on disk. The mocked mkdirSync
    // is a vi.fn() no-op and would prevent realpathSync.native from resolving
    // the paths, causing isCwdAllowed to incorrectly reject them.
    const real = fsMock.realFs!;
    tmpAllowedRoot = real.mkdtempSync(join(tmpdir(), "revival-allowed-"));
    tmpOtherRoot = real.mkdtempSync(join(tmpdir(), "revival-other-"));
  });

  afterEach(() => {
    const real = fsMock.realFs!;
    try { real.rmSync(tmpAllowedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    try { real.rmSync(tmpOtherRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("prunes a dormant session whose stored cwd no longer satisfies current policy", async () => {
    // Session cwd is under tmpOtherRoot; allowed roots are set to tmpAllowedRoot only.
    const sessionCwd = join(tmpOtherRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-bad-cwd", sessionCwd);
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    // bootActiveSessions hasn't been called yet (outer beforeEach only imports the module).
    mod.bootActiveSessions();

    // Session should have been pruned at boot.
    expect(mod.getActiveSession("dormant-bad-cwd")).toBeUndefined();
    expect(mod.listActiveSessions()).toHaveLength(0);
  });

  it("loads a dormant session whose cwd still satisfies current policy", async () => {
    // Session cwd is under tmpAllowedRoot.
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-good-cwd", sessionCwd);
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    const entry = mod.getActiveSession("dormant-good-cwd");
    expect(entry).toBeDefined();
    expect(entry?.status).toBe("dormant");
    expect(entry?.cwd).toBe(sessionCwd);
  });

  it("wakeSession rejects a dormant session whose cwd is outside current policy", async () => {
    // Load the session without any env restriction so it passes loadCheckpoint.
    const sessionCwd = join(tmpOtherRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-wake-bad", sessionCwd);
    // No restriction at boot → session loads as dormant.
    mod.bootActiveSessions();

    expect(mod.getActiveSession("dormant-wake-bad")?.status).toBe("dormant");

    // Now tighten the policy AFTER boot (simulates HOOOP_CWD_ROOTS being set later).
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    // wakeSession should refuse to revive and prune the entry.
    await expect(mod.wakeSession("dormant-wake-bad")).rejects.toThrow(/cwd no longer allowed/);
    expect(mod.getActiveSession("dormant-wake-bad")).toBeUndefined();
  });

  it("wakeSession succeeds for a dormant session whose cwd is still within policy", async () => {
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-wake-good", sessionCwd);
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    expect(mod.getActiveSession("dormant-wake-good")?.status).toBe("dormant");

    // wakeSession should succeed (spawns a child process).
    const meta = await mod.wakeSession("dormant-wake-good");
    expect(meta.status).toBe("alive");
    expect(meta.cwd).toBe(sessionCwd);
  });

  it("wakeSession carries cumulative totals from the dormant slot's lastStats into the new alive meta", async () => {
    // Regression: reactivation used to reset turn / token counters
    // because spawnControllable's meta started with no lastStats.
    // The fix threads lastStats through SpawnOpts.carryStats so the
    // dashboard's StatsStrip keeps its running totals across the
    // dormant→awake transition instead of ratcheting back to zero.
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    const seedStats = {
      v: 1,
      model: "claude-sonnet-4-6",
      mode: "default",
      usage: {
        input_tokens: 12,
        cache_creation_input_tokens: 287,
        cache_read_input_tokens: 19586,
        output_tokens: 84,
      },
      turnDurationMs: 3624,
      turnEndedAt: 1779277948396,
      totals: {
        input_tokens: 100,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 20000,
        output_tokens: 50,
        turns: 3,
      },
    };
    const payload = makeCheckpoint("dormant-carry", sessionCwd, {
      lastStats: seedStats,
    });
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = payload;
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    // Dormant slot has the seed totals.
    const dormant = mod.getActiveSession("dormant-carry");
    expect(dormant?.lastStats?.totals?.turns).toBe(3);

    // Waking it: the new alive slot must keep them, not reset.
    const meta = await mod.wakeSession("dormant-carry");
    expect(meta.status).toBe("alive");
    expect(meta.lastStats?.totals).toEqual(seedStats.totals);
    expect(meta.lastStats?.model).toBe("claude-sonnet-4-6");
  });

  it("idleTtlMs and burnAfterUse survive a checkpoint save/restore round-trip", async () => {
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    const payload = makeCheckpoint("dormant-burn-idle", sessionCwd, {
      idleTtlMs: 12345,
      burnAfterUse: true,
    });
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = payload;
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    const dormant = mod.getActiveSession("dormant-burn-idle");
    expect(dormant?.status).toBe("dormant");
    expect(dormant?.idleTtlMs).toBe(12345);
    expect(dormant?.burnAfterUse).toBe(true);
  });

  it("a checkpoint entry with idleTtlMs: 0 restores as 0, not the install default", async () => {
    // 0 is a meaningful, distinct value from "absent" — a naive `entry.idleTtlMs
    // || ...` restore would silently turn it into undefined.
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    const payload = makeCheckpoint("dormant-idle-zero", sessionCwd, { idleTtlMs: 0 });
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = payload;
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();

    expect(mod.getActiveSession("dormant-idle-zero")?.idleTtlMs).toBe(0);
  });

  it("wakeSession carries idleTtlMs and burnAfterUse into the revived alive slot", async () => {
    // Mirrors the lastStats carry-over test above, for the two new settings —
    // a woken slot builds fresh meta, so without carry-over both would
    // silently revert (idleTtlMs to the install default, burnAfterUse to off).
    const sessionCwd = join(tmpAllowedRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    const payload = makeCheckpoint("dormant-wake-burn", sessionCwd, {
      idleTtlMs: 7000,
      burnAfterUse: true,
    });
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = payload;
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    mod.bootActiveSessions();
    expect(mod.getActiveSession("dormant-wake-burn")?.status).toBe("dormant");

    const meta = await mod.wakeSession("dormant-wake-burn");
    expect(meta.status).toBe("alive");
    expect(meta.idleTtlMs).toBe(7000);
    expect(meta.burnAfterUse).toBe(true);
  });

  it("burnRestoredSessions destroys a restored burn slot and leaves a normal one alone", async () => {
    const burnCwd = join(tmpAllowedRoot, "burn-project");
    const normalCwd = join(tmpAllowedRoot, "normal-project");
    fsMock.realFs!.mkdirSync(burnCwd, { recursive: true });
    fsMock.realFs!.mkdirSync(normalCwd, { recursive: true });

    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      sessions: [
        {
          sessionId: "restored-burn", runId: null, label: "burn session", displayName: null,
          cwd: burnCwd, via: "new-conversation",
          startedAt: Date.now() - 1000, lastSeenAt: Date.now() - 500,
          burnAfterUse: true,
        },
        {
          sessionId: "restored-normal", runId: null, label: "normal session", displayName: null,
          cwd: normalCwd, via: "new-conversation",
          startedAt: Date.now() - 1000, lastSeenAt: Date.now() - 500,
        },
      ],
    });
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = payload;
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;

    // burnRestoredSessions must NEVER be called from inside bootActiveSessions
    // itself (see its doc comment) — this call sequence is exactly why: booting
    // is what every test in this file already does, and only the explicit call
    // below performs any destruction.
    mod.bootActiveSessions();
    expect(mod.getActiveSession("restored-burn")?.burnAfterUse).toBe(true);
    expect(mod.getActiveSession("restored-normal")).toBeDefined();

    const destroyed = await mod.burnRestoredSessions();

    expect(destroyed).toEqual(["restored-burn"]);
    expect(mod.getActiveSession("restored-burn")).toBeUndefined();
    // The untouched session survives, still dormant and resumable.
    expect(mod.getActiveSession("restored-normal")?.status).toBe("dormant");
  });

  it("narrowing HOOOP_CWD_ROOTS between boot cycles prunes previously-valid sessions", async () => {
    // First cycle: no restriction → session with tmpOtherRoot cwd loads fine.
    const sessionCwd = join(tmpOtherRoot, "project");
    fsMock.realFs!.mkdirSync(sessionCwd, { recursive: true });

    stubCheckpoint("dormant-narrow", sessionCwd);
    // No restriction at first boot.
    mod.bootActiveSessions();
    expect(mod.getActiveSession("dormant-narrow")?.status).toBe("dormant");

    // Re-import for a fresh boot with tighter policy.
    vi.resetModules();
    shared.reset();
    fsMock.reset();
    process.env.HOOOP_CWD_ROOTS = tmpAllowedRoot;
    stubCheckpoint("dormant-narrow", sessionCwd);
    mod = await import("./active-sessions");
    mod.bootActiveSessions();

    expect(mod.getActiveSession("dormant-narrow")).toBeUndefined();
  });
});

// The hand-written-checkpoint test above ("a checkpoint entry with idleTtlMs: 0
// restores as 0") only exercises loadCheckpoint's restore side. saveCheckpoint's
// own serialization (`s.meta.idleTtlMs != null ? {...} : {}`) has no coverage
// driven by a REAL live session — changing that `!= null` to a truthy check
// would drop idleTtlMs: 0 from the written file entirely (0 is falsy), and every
// existing test would stay green because none of them set idleTtlMs: 0 on a
// session that actually goes through a real save. That bug means "never go
// dormant" silently reverts to the install default on the next real restart.
describe("saveCheckpoint (real session round-trip)", () => {
  it("idleTtlMs: 0 on a live session survives an actual saveCheckpoint call, and the reload", async () => {
    // A real, existing directory: the reload half re-applies cwd policy
    // (realpathSync), which fails closed on a made-up path like "/x" that
    // other tests get away with only because they never reload the checkpoint.
    const real = fsMock.realFs!;
    const cwd = real.mkdtempSync(join(tmpdir(), "checkpoint-idle-zero-"));
    try {
      const { sessionId } = await mod.startNewConversation({ cwd, idleTtlMs: 0 });

      const fsReal = await import("node:fs");
      const writeFileSync = fsReal.writeFileSync as unknown as ReturnType<typeof vi.fn>;
      writeFileSync.mockClear();
      // renameSession is a cheap way to force a FRESH saveCheckpoint (same trick
      // the plan-review persistence tests use below), so this exercises the real
      // serialization path rather than a hand-written checkpoint fixture.
      mod.renameSession(sessionId, "still idle-exempt");

      const call = [...writeFileSync.mock.calls].reverse()
        .find((c) => String(c[0]).endsWith("active-sessions.json.tmp"));
      expect(call).toBeDefined();
      const body = JSON.parse(String(call![1]));
      const entry = body.sessions.find((s: any) => s.sessionId === sessionId);
      // A truthy check on idleTtlMs would omit the field for 0 entirely.
      expect(entry.idleTtlMs).toBe(0);

      // Round-trip: feed the just-written checkpoint back through loadCheckpoint
      // on a fresh boot and confirm 0 (not the install default) comes back.
      fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
      fsMock.readFileReturnValue = JSON.stringify(body);
      vi.resetModules();
      shared.reset();
      mod = await import("./active-sessions");
      mod.bootActiveSessions();

      expect(mod.getActiveSession(sessionId)?.idleTtlMs).toBe(0);
    } finally {
      real.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("stderr parser: auth failure detection", () => {
  it("emits activeSessionsBus.error with kind=auth when claude prints a 401", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("API Error: 401 Invalid Authentication", "utf-8");
    await flush();

    const auth = errors.find((e) => e.kind === "auth");
    expect(auth).toBeDefined();
    expect(auth.message).toMatch(/hooop login/i);
  });

  it("matches `claude login` recommendation text from claude itself", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("token rejected — please run claude login\n", "utf-8");
    await flush();

    expect(errors.some((e) => e.kind === "auth")).toBe(true);
  });

  it("does NOT fire when stderr only mentions a successful refresh", async () => {
    // Regression guard: claude logs "token refreshed" during a healthy
    // background rotation. That string contains "token" + "refresh" but
    // it's the OPPOSITE of an auth failure — must not trigger the banner.
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("oauth token refreshed (expires in 8h)\n", "utf-8");
    await flush();

    expect(errors.filter((e) => e.kind === "auth")).toHaveLength(0);
  });

  it("does NOT fire for unrelated stderr noise (sandbox debug logs, etc.)", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    (shared.children[0].stderr as any).push("debug: spawned child pid=12345\n", "utf-8");
    (shared.children[0].stderr as any).push("warning: tool Bash took 4.2s\n", "utf-8");
    await flush();

    expect(errors.filter((e) => e.kind === "auth")).toHaveLength(0);
  });

  it("fires at most once per slot — repeat 401 chunks don't flood the bus", async () => {
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));
    await mod.startNewConversation({ cwd: "/x" });

    // Three consecutive failure chunks (e.g. claude retried 3 times).
    (shared.children[0].stderr as any).push("API Error: 401 Unauthorized\n", "utf-8");
    (shared.children[0].stderr as any).push("API Error: 401 Unauthorized\n", "utf-8");
    (shared.children[0].stderr as any).push("API Error: 401 Unauthorized\n", "utf-8");
    await flush();

    expect(errors.filter((e) => e.kind === "auth")).toHaveLength(1);
  });
});

describe("stdout parser: hook-blocked prompt detection", () => {
  it("emits activeSessionsBus.error with kind=hook-blocked when a hook vetoes the prompt", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));

    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "informational",
      session_id: sessionId,
      level: "warning",
      preventContinuation: true,
      content:
        "UserPromptSubmit operation blocked by hook:\n[some hook command]: claude-mem worker unreachable for 4 consecutive hooks.\n\n\nOriginal prompt: start the preview again",
    });
    await flush();

    const blocked = errors.find((e) => e.kind === "hook-blocked");
    expect(blocked).toBeDefined();
    expect(blocked.sessionId).toBe(sessionId);
    expect(blocked.message).toBe("claude-mem worker unreachable for 4 consecutive hooks.");
  });

  it("does NOT fire for an informational frame that isn't blocking (no preventContinuation)", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const errors: any[] = [];
    mod.activeSessionsBus.on("error", (p) => errors.push(p));

    (shared.children[0].stdout as any).pushLine({
      type: "system",
      subtype: "informational",
      session_id: sessionId,
      level: "suggestion",
      content: "just a heads up, nothing was blocked",
    });
    await flush();

    expect(errors.filter((e) => e.kind === "hook-blocked")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plan-review durability: a synthetic plan review awaiting the human's decision
// must survive a sandbox restart (checkpoint) and a dormant→awake revive, and
// must NOT be idle-reaped out from under the user. Regression for session
// 887db520, where a restart between plan submission and the click dropped the
// review (checkpoint omitted it; revive rebuilt an empty slot).
// ---------------------------------------------------------------------------
describe("plan-review persistence (checkpoint + revive + reap)", () => {
  const TTL = 30 * 60 * 1000; // default HOOOP_SESSION_IDLE_TTL_MS

  // Drive a live session to a submitted plan review (the deterministic path: a
  // /plan turn where the model calls submit_plan). Ends the turn so turnActive is
  // false — so the reap test exercises the pending-review exemption, not the
  // turn-in-flight guard. Leaves the session alive with exactly one synthetic
  // pending review.
  async function primePlan(sid: string) {
    await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    await mod.writeUserTurn(sid, "/plan build a widget");
    mod.createPermissionRequest({ sessionId: sid, toolName: "mcp__plugin_hooop_tools__submit_plan", input: { plan: "## Plan\n1. do a\n2. do b" }, toolUseId: `tu-${sid}` });
    (child.stdout as any).pushLine({ type: "result", session_id: sid, result: "Plan submitted for review.", usage: { input_tokens: 5, output_tokens: 5 } });
    await flush();
    return child;
  }

  const syntheticReview = (requestId: string, plan: string) => ({
    requestId, toolUseId: null, toolName: "ExitPlanMode", input: { plan },
    decisionReason: null, receivedAt: Date.now(), author: "host", shareId: null, synthetic: true,
  });

  it("saveCheckpoint persists the synthetic plan review (mirrors lastStats)", async () => {
    const sid = "persist-review";
    await primePlan(sid);
    expect(mod.getPendingRequests(sid).filter((r) => r.synthetic)).toHaveLength(1);

    // The result-frame saveCheckpoint ran BEFORE the review was pushed; trigger a
    // fresh checkpoint (renameSession does) so the review makes it to disk.
    const fsReal = await import("node:fs");
    const writeFileSync = fsReal.writeFileSync as unknown as ReturnType<typeof vi.fn>;
    writeFileSync.mockClear();
    mod.renameSession(sid, "reviewed session");

    const call = [...writeFileSync.mock.calls].reverse().find((c) => String(c[0]).endsWith("active-sessions.json.tmp"));
    expect(call).toBeDefined();
    const body = JSON.parse(String(call![1]));
    const entry = body.sessions.find((s: any) => s.sessionId === sid);
    expect(entry.pendingReviews).toHaveLength(1);
    expect(entry.pendingReviews[0].synthetic).toBe(true);
    expect(entry.pendingReviews[0].input.plan).toContain("do a");
  });

  it("loadCheckpoint restores the review into the dormant slot (survives restart)", async () => {
    const sid = "restore-review";
    // loadCheckpoint re-applies cwd policy (realpathSync) — use a path that
    // actually resolves. No HOOOP_CWD_ROOTS set → any existing path is allowed.
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = makeCheckpoint(sid, tmpdir(), {
      pendingReviews: [syntheticReview("rev-restore", "1. persisted step")],
    });
    mod.bootActiveSessions();

    expect(mod.getActiveSession(sid)?.status).toBe("dormant");
    const pending = mod.getPendingRequests(sid);
    expect(pending).toHaveLength(1);
    expect(pending[0].toolName).toBe("ExitPlanMode");
    expect(pending[0].synthetic).toBe(true);
    expect((pending[0].input as any).plan).toContain("persisted step");
  });

  it("loadCheckpoint defensively drops a non-synthetic entry smuggled into pendingReviews", async () => {
    const sid = "smuggled-review";
    const real = { requestId: "not-a-review", toolUseId: "tu", toolName: "Bash", input: { command: "rm -rf /" }, decisionReason: null, receivedAt: Date.now(), author: "host", shareId: null };
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = makeCheckpoint(sid, tmpdir(), { pendingReviews: [real] });
    mod.bootActiveSessions();

    // No hook waits on this fake ask; it must not resurface as a pending card.
    expect(mod.getPendingRequests(sid)).toHaveLength(0);
  });

  it("wakeSession carries the review into the revived alive slot (survives revive)", async () => {
    const sid = "carry-review";
    fsMock.existsReturnValue = (p: string) => p.endsWith("active-sessions.json");
    fsMock.readFileReturnValue = makeCheckpoint(sid, tmpdir(), {
      pendingReviews: [syntheticReview("rev-carry", "1. carried step")],
    });
    mod.bootActiveSessions();
    expect(mod.getActiveSession(sid)?.status).toBe("dormant");

    const meta = await mod.wakeSession(sid);
    expect(meta.status).toBe("alive");
    // The review must still be there on the fresh (alive) slot — the old dormant
    // slot (and its pendingRequests) was discarded when the new one registered.
    const pending = mod.getPendingRequests(sid);
    expect(pending).toHaveLength(1);
    expect(pending[0].synthetic).toBe(true);
    expect((pending[0].input as any).plan).toContain("carried step");
  });

  it("sweepIdleSessions reaps a session with a pending plan review, keeping the review", async () => {
    // This used to assert the opposite. A pending review blocked reaping from
    // back when losing it was a real risk — but the review is durable now, so the
    // guard only meant such a session sat in Active forever holding a live
    // subprocess. Dormancy must not cost the user their plan, which is what the
    // second half pins.
    const sid = "reap-with-review";
    const child = await primePlan(sid);
    expect(mod.getPendingRequests(sid).filter((r) => r.synthetic)).toHaveLength(1);

    const lastSeen = mod.getActiveSession(sid)!.lastSeenAt;
    expect(mod.sweepIdleSessions(lastSeen + TTL * 10)).toContain(sid);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    child.emit("close", 1);
    await flush();
    expect(mod.getActiveSession(sid)?.status).toBe("dormant");
    expect(mod.getPendingRequests(sid).filter((r) => r.synthetic)).toHaveLength(1);
  });
});

describe("per-session workspace + git provisioning", () => {
  it("a non-git session gets its own private workdir under SESSIONS_ROOT", async () => {
    delete process.env.HOOOP_RUN_CWD;
    const { sessionId, meta } = await mod.startNewConversation({});
    // cwd is the session's own dir, named by its id — never the shared workspace.
    expect(meta.cwd).toBe(sessionWorkdir(sessionId));
    expect(meta.cwd.startsWith(SESSIONS_ROOT + "/")).toBe(true);
    expect(meta.status).toBe("alive");
    // The owned id is handed to claude via --session-id (no pending phase).
    const args = shared.children[shared.children.length - 1].spawnArgs as string[];
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(sessionId);
  });

  it("an explicit cwd still bypasses the per-session-dir machinery", async () => {
    delete process.env.HOOOP_RUN_CWD;
    const { meta } = await mod.startNewConversation({ cwd: "/x" });
    expect(meta.cwd).toBe("/x");
  });

  it("a git session returns immediately in 'provisioning' and is NOT drivable", async () => {
    delete process.env.HOOOP_RUN_CWD;
    // The mocked child never emits "close", so the clone never resolves — the
    // session stays provisioning, which is exactly the state we want to assert.
    const { sessionId, meta } = await mod.startNewConversation({
      gitRepo: "https://github.com/owner/repo.git",
    });
    expect(meta.status).toBe("provisioning");
    // The eventual cwd is nested under the session's private root.
    expect(meta.cwd.startsWith(sessionWorkdir(sessionId) + "/")).toBe(true);
    // A provisioning session is visible but not controllable...
    expect(mod.getActiveSession(sessionId)?.status).toBe("provisioning");
    expect(mod.isControllable(sessionId)).toBe(false);
    // ...and a side-channel !bash/>chat must NOT promote it to alive.
    mod.markSessionActive(sessionId);
    expect(mod.getActiveSession(sessionId)?.status).toBe("provisioning");
    // The git clone itself spawns a child (for progress streaming), but no
    // claude child is spawned while provisioning.
    expect(shared.children.length).toBe(1);
    expect(shared.children[0].spawnArgs).toContain("clone");
  });

  it("provisioning slots are not persisted to the checkpoint", async () => {
    delete process.env.HOOOP_RUN_CWD;
    const writeSpy = (await import("node:fs")).writeFileSync as unknown as ReturnType<typeof vi.fn>;
    writeSpy.mockClear?.();
    await mod.startNewConversation({ gitRepo: "https://github.com/owner/repo.git" });
    // registerProvisioningSlot must NOT trigger a checkpoint write (ephemeral).
    for (const call of writeSpy.mock?.calls ?? []) {
      expect(String(call[1] ?? "")).not.toContain("\"status\": \"provisioning\"");
    }
  });
});

describe("sessionRootFromCwd (delete guard)", () => {
  it("resolves a plain session cwd to its own root", () => {
    const root = sessionWorkdir("abc123");
    expect(mod.sessionRootFromCwd(root)).toBe(root);
  });
  it("resolves a git-clone cwd (root/<repo>) back to the session root", () => {
    const root = sessionWorkdir("abc123");
    expect(mod.sessionRootFromCwd(join(root, "repo"))).toBe(root);
    expect(mod.sessionRootFromCwd(join(root, "repo", "src", "deep"))).toBe(root);
  });
  it("refuses the sessions root itself, the shared workspace, and mounts", () => {
    expect(mod.sessionRootFromCwd(SESSIONS_ROOT)).toBeNull();
    expect(mod.sessionRootFromCwd(WORKSPACE_DIR)).toBeNull();
    // `hooop mount` folders live at WORKSPACE_DIR/<name>, never under sessions/.
    expect(mod.sessionRootFromCwd(join(WORKSPACE_DIR, "my-mount"))).toBeNull();
  });
  it("refuses paths outside the sessions root and traversal attempts", () => {
    expect(mod.sessionRootFromCwd("/etc")).toBeNull();
    expect(mod.sessionRootFromCwd("/home/agent/.claude")).toBeNull();
    expect(mod.sessionRootFromCwd(join(SESSIONS_ROOT, "..", "..", "etc"))).toBeNull();
  });
});

describe("early permission decisions are bound to the ask that produced them", () => {
  async function prime(sid: string) {
    const cwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "early-bind-"));
    await mod.startNewConversation({ cwd });
    (shared.children[shared.children.length - 1].stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
    return cwd;
  }

  it("a stashed allow cannot be replayed by a later ask that needs a human", async () => {
    const cwd = await prime("sid-replay");

    // 1. A benign ask under tool_use_id "X" is fast-laned to allow and stashed.
    mod.createPermissionRequest({
      sessionId: "sid-replay", toolName: "Read", input: { file_path: join(cwd, "ok.ts") }, toolUseId: "X",
    });
    expect(mod.peekPermissionDecision("X")?.decision).toBe("allow");

    // 2. A CRITICAL ask reuses that id. It must raise a card and must not
    //    inherit the earlier allow — the whole point of a critical ask is that
    //    a human answers it.
    mod.createPermissionRequest({
      sessionId: "sid-replay", toolName: "Bash", input: { command: "git push origin main" }, toolUseId: "X",
    });
    expect(mod.peekPermissionDecision("X")).toBeNull();
    expect(mod.getPendingRequests("sid-replay").some((p) => p.toolUseId === "X")).toBe(true);

    // 3. The hook's long-poll therefore waits for the operator instead of
    //    consuming the stale allow.
    expect((await mod.awaitPermissionDecision("X", 200)).decision).toBe("timeout");
  });
});

// ---------------------------------------------------------------------------
// Live previews: which tools reach a human, and which never can
// ---------------------------------------------------------------------------

describe("live preview tools", () => {
  const START = "mcp__plugin_hooop_tools__start_preview";
  const SHARE = "mcp__plugin_hooop_tools__share_preview";
  const STOP = "mcp__plugin_hooop_tools__stop_preview";
  const LIST = "mcp__plugin_hooop_tools__list_previews";

  let cwd: string;

  async function prime(sid: string) {
    cwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "preview-gate-"));
    await mod.startNewConversation({ cwd });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
  }

  /** Put a running preview in the fake registry for this session. */
  function seedRunning(sid: string, over: Record<string, unknown> = {}) {
    const rec = {
      previewId: "pv-1", sessionId: sid, slot: 1, slotPort: 7850,
      spec: { name: "web", run: "npm run dev", setup: ["npm ci"] },
      state: "running", phase: { kind: "run" },
      failedStep: null, failureReason: null, publicUrl: null, ...over,
    };
    previewsMock.records.push(rec);
    return rec;
  }

  it("start_preview runs without a card and returns the URL as the tool result", async () => {
    // Not a lax default: the model can already run arbitrary commands via Bash
    // in THIS container, so running them in a less privileged one isn't an
    // escalation, and a running preview is only reachable from the operator's
    // own loopback.
    await prime("sid-pv1");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pv1", toolName: START, toolUseId: "pv-a",
      input: { name: "web", run: "npm run dev" },
    });
    expect(mod.getPendingRequests("sid-pv1")).toHaveLength(0);
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("http://127.0.0.1:7850");
    // Deny, so the declaration-only MCP handler never also runs and appends
    // its "NOT DONE" text on top of a real result.
    expect(decision.decision).toBe("deny");
  });

  it("share_preview surfaces a card and does NOT decide on its own", async () => {
    await prime("sid-pv2");
    seedRunning("sid-pv2");
    mod.createPermissionRequest({
      sessionId: "sid-pv2", toolName: SHARE, toolUseId: "pv-share", input: { id: "pv-1" },
    });
    const pending = mod.getPendingRequests("sid-pv2");
    expect(pending).toHaveLength(1);
    expect((await mod.awaitPermissionDecision("pv-share", 200)).decision).toBe("timeout");
  });

  it("the share card carries the spec, so the human sees what is being published", async () => {
    await prime("sid-pv3");
    seedRunning("sid-pv3");
    mod.createPermissionRequest({
      sessionId: "sid-pv3", toolName: SHARE, toolUseId: "pv-share2", input: { id: "pv-1" },
    });
    const card = mod.getPendingRequests("sid-pv3")[0];
    const input = card.input as Record<string, unknown>;
    expect(input.name).toBe("web");
    expect(input.run).toBe("npm run dev");
    expect(input.setup).toEqual(["npm ci"]);
    expect(input.localUrl).toBe("http://127.0.0.1:7850");
  });

  describe("share_preview is never approved without a human", () => {
    it("stays pending under AUTO MODE", async () => {
      // Auto mode is the one a host opts into explicitly, and it still must not
      // publish agent-written code to a public URL on its own.
      await prime("sid-pv4");
      seedRunning("sid-pv4");
      mod.setSessionAutoMode("sid-pv4", true);
      mod.createPermissionRequest({
        sessionId: "sid-pv4", toolName: SHARE, toolUseId: "pv-auto", input: { id: "pv-1" },
      });
      expect(mod.getPendingRequests("sid-pv4")).toHaveLength(1);
      expect((await mod.awaitPermissionDecision("pv-auto", 200)).decision).toBe("timeout");
    });

    it("stays pending during an APPROVED-PLAN run", async () => {
      await prime("sid-pv5");
      seedRunning("sid-pv5");
      await mod.writeUserTurn("sid-pv5", "go", "host", null, { autoAllowRun: true });
      mod.createPermissionRequest({
        sessionId: "sid-pv5", toolName: SHARE, toolUseId: "pv-plan", input: { id: "pv-1" },
      });
      expect(mod.getPendingRequests("sid-pv5")).toHaveLength(1);
      expect((await mod.awaitPermissionDecision("pv-plan", 200)).decision).toBe("timeout");
    });

    it("stays pending for a TRUSTED PEER", async () => {
      await prime("sid-pv6");
      seedRunning("sid-pv6");
      await mod.writeUserTurn("sid-pv6", "go", "guest", "share-1");
      // Grant the peer session-scoped trust the way an "allow always" would.
      mod.createPermissionRequest({
        sessionId: "sid-pv6", toolName: "Write", input: { file_path: join(cwd, "a.txt"), content: "x" }, toolUseId: "w1",
      });
      await mod.respondToPermission("sid-pv6", "w1", "allow", null, true, "guest");
      mod.createPermissionRequest({
        sessionId: "sid-pv6", toolName: SHARE, toolUseId: "pv-peer", input: { id: "pv-1" },
      });
      expect(mod.getPendingRequests("sid-pv6")).toHaveLength(1);
      expect((await mod.awaitPermissionDecision("pv-peer", 200)).decision).toBe("timeout");
    });
  });

  describe("cross-session isolation", () => {
    it("refuses to stop another session's preview, even with the right id", async () => {
      await prime("sid-pv7");
      seedRunning("someone-else", { previewId: "pv-other" });
      const r = mod.createPermissionRequest({
        sessionId: "sid-pv7", toolName: STOP, toolUseId: "pv-x", input: { id: "pv-other" },
      });
      const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
      expect(decision.reason).toContain("belongs to this session");
      expect(previewsMock.stopped).toEqual([]);
    });

    it("refuses to SHARE another session's preview rather than showing a card", async () => {
      // A card here would let one session's agent get another session's app
      // published by guessing an id — exactly what the per-session slots exist
      // to prevent.
      await prime("sid-pv8");
      seedRunning("someone-else", { previewId: "pv-other" });
      const r = mod.createPermissionRequest({
        sessionId: "sid-pv8", toolName: SHARE, toolUseId: "pv-y", input: { id: "pv-other" },
      });
      expect(mod.getPendingRequests("sid-pv8")).toHaveLength(0);
      expect((await mod.awaitPermissionDecision(r.requestId, 500)).reason).toContain("belongs to this session");
    });
  });

  describe("share preconditions are resolved before a human is interrupted", () => {
    it("declines when the session has no preview at all", async () => {
      await prime("sid-pv9");
      const r = mod.createPermissionRequest({
        sessionId: "sid-pv9", toolName: SHARE, toolUseId: "pv-none", input: {},
      });
      expect(mod.getPendingRequests("sid-pv9")).toHaveLength(0);
      expect((await mod.awaitPermissionDecision(r.requestId, 500)).reason).toContain("start_preview first");
    });

    it("declines when the preview is still starting, rather than carding a no-op", async () => {
      await prime("sid-pv10");
      seedRunning("sid-pv10", { state: "starting" });
      const r = mod.createPermissionRequest({
        sessionId: "sid-pv10", toolName: SHARE, toolUseId: "pv-early", input: { id: "pv-1" },
      });
      expect(mod.getPendingRequests("sid-pv10")).toHaveLength(0);
      expect((await mod.awaitPermissionDecision(r.requestId, 500)).reason).toContain("nothing to share yet");
    });

    it("says so when it is already shared", async () => {
      await prime("sid-pv11");
      seedRunning("sid-pv11", { state: "shared", publicUrl: "https://x.trycloudflare.com" });
      const r = mod.createPermissionRequest({
        sessionId: "sid-pv11", toolName: SHARE, toolUseId: "pv-dup", input: { id: "pv-1" },
      });
      expect(mod.getPendingRequests("sid-pv11")).toHaveLength(0);
      expect((await mod.awaitPermissionDecision(r.requestId, 500)).reason).toContain("already shared");
    });
  });

  it("plan mode blocks preview tools — they start processes", async () => {
    // Deliberately NOT in PLAN_READONLY_TOOLS. A /plan turn is read-only until
    // the plan is approved, and spawning a dev server is not investigation.
    await prime("sid-pv12");
    await mod.writeUserTurn("sid-pv12", "/plan add a preview");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pv12", toolName: START, toolUseId: "pv-plan-block",
      input: { name: "web", run: "npm run dev" },
    });
    const decision = await mod.awaitPermissionDecision(r.requestId, 500);
    expect(decision.decision).toBe("deny");
    expect(decision.reason).toMatch(/read-only/i);
    expect(previewsMock.started).toHaveLength(0);
  });

  it("list_previews answers inline and is scoped to this session", async () => {
    await prime("sid-pv13");
    seedRunning("sid-pv13");
    seedRunning("other-session", { previewId: "pv-other" });
    const r = mod.createPermissionRequest({
      sessionId: "sid-pv13", toolName: LIST, toolUseId: "pv-list", input: {},
    });
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    // One of ours, and only a COUNT of the rest — another conversation's
    // preview names and workspace paths are not this session's business.
    expect(decision.reason).toContain("1 previews");
    expect(decision.reason).toContain("1 other preview");
  });

  it("reports a rejected spec back to the model instead of failing opaquely", async () => {
    await prime("sid-pv14");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pv14", toolName: START, toolUseId: "pv-bad", input: { name: "web" },
    });
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("Preview spec rejected");
    expect(decision.reason).toContain("Dockerfile CMD");
  });

  it("surfaces a registry failure as its message, not a generic error", async () => {
    await prime("sid-pv15");
    previewsMock.startError = Object.assign(new Error("all 3 preview slots are in use"), { name: "PreviewError" });
    const r = mod.createPermissionRequest({
      sessionId: "sid-pv15", toolName: START, toolUseId: "pv-full",
      input: { name: "web", run: "npm run dev" },
    });
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("all 3 preview slots are in use");
  });
});

// ---------------------------------------------------------------------------
// Driving the page: what the model gets back, and what it is never allowed to
// believe happened
// ---------------------------------------------------------------------------

describe("page-driving tools", () => {
  const CLICK = "mcp__plugin_hooop_tools__page_click";
  const SNAPSHOT = "mcp__plugin_hooop_tools__page_snapshot";
  const CALL = "mcp__plugin_hooop_tools__call_page_tool";

  async function prime(sid: string) {
    const cwd = fsMock.realFs!.mkdtempSync(join(tmpdir(), "page-gate-"));
    await mod.startNewConversation({ cwd });
    const child = shared.children[shared.children.length - 1];
    (child.stdout as any).pushLine({ type: "system", session_id: sid });
    await flush();
  }

  function seed(sid: string, over: Record<string, unknown> = {}) {
    previewsMock.records.push({
      previewId: "pv-1", sessionId: sid, slot: 2, slotPort: 7851,
      spec: { name: "web", run: "npm run dev", setup: [] },
      state: "running", phase: { kind: "run" },
      failedStep: null, failureReason: null, publicUrl: null, ...over,
    });
  }

  /** Stand in for the dashboard: collect the action and report a result. */
  async function asDashboard(result: Record<string, unknown>) {
    const drive = await import("./preview-drive");
    const action = await drive.driveQueue.take(2000);
    expect(action, "the tool never queued an action for the dashboard").not.toBeNull();
    drive.driveQueue.settle(action!.id, result as any);
    return action!;
  }

  it("keeps the whole exchange inside the gate's budget, with margin", async () => {
    // The gate long-polls ONCE and reads a timeout as the operator refusing. So
    // first try + nudge + retry has to finish comfortably inside the budget: it
    // added up to exactly 90s, which meant any overhead at all turned a call that
    // was still working into "denied by the operator" — a lie about a human.
    expect(mod.PAGE_TOOL_BUDGET.worstMs).toBeLessThan(mod.PREVIEW_GATE_BUDGET_MS);
    expect(mod.PREVIEW_GATE_BUDGET_MS - mod.PAGE_TOOL_BUDGET.worstMs).toBeGreaterThanOrEqual(10_000);
  });

  it("relays a click to the dashboard and reports where it landed", async () => {
    await prime("sid-pg1");
    seed("sid-pg1");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pg1", toolName: CLICK, toolUseId: "pg-a",
      input: { selector: "#go" },
    });
    // No card: the check on this is the human already watching the page, who
    // sees every action drawn on screen and can take it back with one click.
    expect(mod.getPendingRequests("sid-pg1")).toHaveLength(0);

    const action = await asDashboard({
      ok: true, result: { clicked: "#go" }, viewers: { following: 2, detached: 0, succeeded: 2 },
    });
    expect(action).toMatchObject({ slot: 2, action: "click", params: { selector: "#go" } });

    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("2 of 2 following pages");
    expect(decision.decision).toBe("deny");   // same reason as the preview tools
  });

  it("translates each tool to the action the injected driver understands", async () => {
    await prime("sid-pg2");
    seed("sid-pg2");
    mod.createPermissionRequest({
      sessionId: "sid-pg2", toolName: SNAPSHOT, toolUseId: "pg-b", input: {},
    });
    expect((await asDashboard({ ok: true, result: {} })).action).toBe("snapshot");

    mod.createPermissionRequest({
      sessionId: "sid-pg2", toolName: CALL, toolUseId: "pg-c",
      input: { name: "add_todo", arguments: { text: "milk" } },
    });
    const called = await asDashboard({ ok: true, result: {} });
    expect(called).toMatchObject({ action: "call_tool", params: { name: "add_todo" } });
  });

  it("says to start a preview when the session has none", async () => {
    await prime("sid-pg3");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pg3", toolName: CLICK, toolUseId: "pg-d", input: { selector: "#go" },
    });
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("start_preview");
  });

  it("does not queue an action against a preview that is still starting", async () => {
    // Clicking into a page that has not been served yet would fail in a way that
    // reads like the app being broken, when it is just not up.
    await prime("sid-pg4");
    seed("sid-pg4", { state: "starting", phase: { kind: "setup", step: 0 } });
    const r = mod.createPermissionRequest({
      sessionId: "sid-pg4", toolName: CLICK, toolUseId: "pg-e", input: { selector: "#go" },
    });
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("starting");
    const drive = await import("./preview-drive");
    expect(drive.driveQueue.size()).toEqual({ waiting: 0, running: 0 });
  });

  it("will not drive another session's preview", async () => {
    // The page belongs to whoever is looking at it. There is no id to guess here
    // — the preview is resolved from the session — and this pins that.
    await prime("sid-pg5");
    seed("someone-else");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pg5", toolName: CLICK, toolUseId: "pg-f", input: { selector: "#go" },
    });
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("no preview running");
  });

  it("nudges everyone to open the preview, then retries — it does not just give up", async () => {
    // The alternative would be a headless browser, which is exactly what this
    // design refuses: a second session diverging from the screen, invisibly. So
    // the only move left is to ask a human, out loud, and wait.
    await prime("sid-pg6");
    seed("sid-pg6");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pg6", toolName: CLICK, toolUseId: "pg-g", input: { selector: "#go" },
    });
    await asDashboard({ ok: false, reason: "no-viewer" });

    const previews = await import("./previews");
    const nudges = (previews.emitPreviewEvent as any).mock.calls
      .filter((c: any[]) => c[0] === "PreviewNeedsViewer" && c[1]?.sessionId === "sid-pg6");
    expect(nudges).toHaveLength(1);

    // Somebody opened it, so the retry lands and the model reports the action,
    // not the wait.
    const retry = await asDashboard({
      ok: true, result: { clicked: "#go" }, viewers: { following: 1, detached: 0, succeeded: 1 },
    });
    expect(retry.waitForViewerMs).toBeGreaterThan(0);
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("1 of 1 following page");
  });

  it("tells the model to wait for a person rather than to find another way in", async () => {
    await prime("sid-pg7");
    seed("sid-pg7");
    const r = mod.createPermissionRequest({
      sessionId: "sid-pg7", toolName: CLICK, toolUseId: "pg-h", input: { selector: "#go" },
    });
    await asDashboard({ ok: false, reason: "no-viewer" });   // first try
    await asDashboard({ ok: false, reason: "no-viewer" });   // nobody came
    const decision = await mod.awaitPermissionDecision(r.requestId, 2000);
    expect(decision.reason).toContain("Nobody opened the preview");
    expect(decision.reason).toContain("wait for them");
  });
});

describe("writeUserTurn: a mid-turn write does not get stuck behind a serialised queue", () => {
  it("still writes a second turn to stdin while the first is in flight (no Stop yet)", async () => {
    // A message sent to "guide" the model while it's already working (before
    // any Stop/result frame for the prior turn) must still reach stdin — it's
    // the only channel a running turn has for steering input.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    const writes: string[] = [];
    const orig = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => {
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return orig(chunk, ...rest);
    };

    await mod.writeUserTurn(sessionId, "first message", "host");
    expect(mod.getActiveSession(sessionId)?.turnActive).toBe(true);

    await mod.writeUserTurn(sessionId, "SECOND steering message", "host");

    expect(writes).toHaveLength(2);
    expect(writes[0]).toContain("first message");
    expect(writes[1]).toContain("SECOND steering message");
  });

  it("does not permanently break future turns after one write fails mid-session", async () => {
    // `slot.writeQueue = slot.writeQueue.then(sendTurn)` looks like ordinary
    // serialisation but is a poison pill: once that chained promise REJECTS
    // (a stdin write can fail — EPIPE from a dying child, a destroyed stream),
    // every LATER `.then(fn)` on the same rejected promise skips `fn` and just
    // re-rejects with the ORIGINAL error, forever. One transient write failure
    // — exactly the kind of thing that can happen while a turn is running —
    // would silently stop every subsequent message from ever reaching stdin
    // again, each failing instantly with a stale error nobody typed. This is
    // the regression test for enqueueWrite, which keeps the queue itself
    // always-resolved so a later turn still gets a real attempt.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    const child = shared.children[shared.children.length - 1];
    const writes: string[] = [];
    let failNext = false;
    const orig = child.stdin.write.bind(child.stdin);
    child.stdin.write = (chunk: any, ...rest: any[]) => {
      if (failNext) {
        failNext = false;
        const cb = rest[rest.length - 1];
        if (typeof cb === "function") cb(new Error("simulated EPIPE"));
        return false;
      }
      writes.push(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
      return orig(chunk, ...rest);
    };

    failNext = true;
    await expect(mod.writeUserTurn(sessionId, "will fail", "host")).rejects.toThrow();

    // A later turn — the caller's own next message — must still land.
    await mod.writeUserTurn(sessionId, "will this land?", "host");
    expect(writes.some((w) => w.includes("will this land?"))).toBe(true);
  });
});

describe("a steering message sent while the model is mid-turn", () => {
  // claude splices a write that lands during a running turn into that turn as a
  // `queued_command` attachment and emits NO UserPromptSubmit for it. Without
  // the synthesized echo, the message reaches the model but never reaches the
  // transcript — it vanishes from the chat frame — and the queued author goes
  // stale and mis-attributes the next real turn.
  const prompts = () =>
    ingestEventLineMock.mock.calls
      .map((c) => JSON.parse(c[0] as string))
      .filter((e) => e.hook === "UserPromptSubmit");

  it("records the message in the transcript even though no hook fires for it", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    await mod.writeUserTurn(sessionId, "first message", "host");
    expect(mod.getActiveSession(sessionId)?.turnActive).toBe(true);

    ingestEventLineMock.mockClear();
    await mod.writeUserTurn(sessionId, "I think you are overengineering.", "host");

    const echoed = prompts();
    expect(echoed).toHaveLength(1);
    expect(echoed[0].ctx.prompt).toBe("I think you are overengineering.");
    expect(echoed[0].ctx.author).toBe("host");
    expect(echoed[0].ctx.session_id).toBe(sessionId);
  });

  it("does NOT queue an author for it, which would mis-attribute the next real turn", async () => {
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    await mod.writeUserTurn(sessionId, "first message", "host");
    await mod.writeUserTurn(sessionId, "mid-turn steer", "riley");
    // Only the FIRST turn's author is queued; the mid-turn one echoed instead.
    expect(mod.popPendingAuthor(sessionId).author).toBe("host");
    expect(mod.popPendingAuthor(sessionId).author).toBeNull();
  });

  it("leaves an ordinary idle-session turn on the queue, with no synthetic echo", async () => {
    // The normal path must be untouched: a turn sent when nothing is running
    // still gets its UserPromptSubmit from the hook, so synthesizing one here
    // would double-record every message in the transcript.
    const { sessionId } = await mod.startNewConversation({ cwd: "/x" });
    ingestEventLineMock.mockClear();
    await mod.writeUserTurn(sessionId, "a normal turn", "host");
    expect(prompts()).toHaveLength(0);
    expect(mod.popPendingAuthor(sessionId).author).toBe("host");
  });
});
