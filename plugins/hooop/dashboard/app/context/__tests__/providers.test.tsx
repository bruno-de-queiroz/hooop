import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import {
  installMockEventSource,
  latestEventSource,
  clearEventSources,
} from "../__test-utils__/mock-event-source";
import { installMockFetch, type FetchScript } from "../__test-utils__/mock-fetch";
import {
  installMockNavigation,
  mockRouterReplace,
  setMockUrl,
} from "../__test-utils__/mock-navigation";

// Tests dynamic-import the providers after mocks are installed so the
// vi.doMock("next/navigation") factory wins.
let DashboardProviders: typeof import("../DashboardProviders").DashboardProviders;
let useSelectedSession: typeof import("../SelectedSessionProvider").useSelectedSession;
let useSessions: typeof import("../SessionsProvider").useSessions;
let useActiveSession: typeof import("../ActiveSessionProvider").useActiveSession;

const wrap = (Provider: typeof DashboardProviders) => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => <Provider>{children}</Provider>;
  Wrapper.displayName = "TestProviderWrapper";
  return Wrapper;
};

async function loadProviders() {
  vi.resetModules();
  const dp = await import("../DashboardProviders");
  const ss = await import("../SelectedSessionProvider");
  const sp = await import("../SessionsProvider");
  const ap = await import("../ActiveSessionProvider");
  DashboardProviders = dp.DashboardProviders;
  useSelectedSession = ss.useSelectedSession;
  useSessions = sp.useSessions;
  useActiveSession = ap.useActiveSession;
}

function fireSse(type: string, data: unknown) {
  act(() => {
    latestEventSource()?.fire(type, data);
  });
}

let fetchScript: FetchScript;

beforeEach(async () => {
  installMockEventSource();
  installMockNavigation();
  fetchScript = installMockFetch({
    routes: [
      (url, method) => {
        if (url === "/api/sessions" && method === "GET") {
          return { json: defaultSessions };
        }
        if (url.startsWith("/api/events?") && method === "GET") {
          return { json: defaultEvents };
        }
        if (url.match(/\/api\/sessions\/[^/]+\/model$/) && method === "GET") {
          return { json: { model: "sonnet-4-6" } };
        }
        if (url.match(/\/api\/sessions\/[^/]+\/summary$/) && method === "GET") {
          return { json: { summary: null } };
        }
        if (url.startsWith("/api/commands") && method === "GET") return { json: [] };
        if (url.startsWith("/api/skills") && method === "GET") return { json: [] };
        return null;
      },
    ],
    fallback: { status: 200, json: {} },
  });
  await loadProviders();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearEventSources();
});

const defaultSessions = [
  {
    id: "sess-a",
    path: "",
    mtime: "2026-05-19T10:00:00Z",
    size: 0,
    sessionId: "sess-a",
    displayName: "alpha-bravo-charlie",
    cwd: "/workspace",
    lifecycle: "alive",
    aliases: [],
  },
  {
    id: "sess-b",
    path: "",
    mtime: "2026-05-19T09:00:00Z",
    size: 0,
    sessionId: "sess-b",
    displayName: "delta-echo-foxtrot",
    cwd: "/workspace",
    lifecycle: "dormant",
    aliases: [],
  },
];

const defaultEvents: Array<{
  id: number;
  ts: string;
  session_id: string;
  hook_type: string;
  tool_name: null;
  text: string;
}> = [];

describe("SessionsProvider", () => {
  it("fetches /api/sessions on mount and exposes the rows", async () => {
    const { result } = renderHook(() => useSessions(), { wrapper: wrap(DashboardProviders) });
    await act(async () => {
      await flush();
    });
    expect(result.current.sessions).toHaveLength(2);
    expect(result.current.sessions[0].sessionId).toBe("sess-a");
  });

  it("debounces 3 SSE `sessions` pings within 200ms into ONE refetch", async () => {
    renderHook(() => useSessions(), { wrapper: wrap(DashboardProviders) });
    await act(async () => {
      await flush();
    });
    const initialFetches = fetchScript.calls.filter((c) => c.url === "/api/sessions").length;

    fireSse("sessions", { changed: true });
    fireSse("sessions", { changed: true });
    fireSse("sessions", { changed: true });

    // Within the debounce window — no new fetch yet.
    expect(
      fetchScript.calls.filter((c) => c.url === "/api/sessions").length - initialFetches,
    ).toBe(0);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(
      fetchScript.calls.filter((c) => c.url === "/api/sessions").length - initialFetches,
    ).toBe(1);
  });

  it("two simultaneous consumers share ONE fetch on initial mount", async () => {
    function Consumer() {
      useSessions();
      return null;
    }
    function Wrapper() {
      return (
        <DashboardProviders>
          <Consumer />
          <Consumer />
        </DashboardProviders>
      );
    }
    render(<Wrapper />);
    await act(async () => {
      await flush();
    });
    expect(fetchScript.calls.filter((c) => c.url === "/api/sessions").length).toBe(1);
  });

  it("bounces a ?session that resolves to no known session back to the create flow", async () => {
    setMockUrl("http://localhost/?session=ghost-id");
    await loadProviders();

    render(
      <DashboardProviders>
        <div />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    // Still within the grace window — no bounce yet.
    mockRouterReplace.mockClear();

    // Let the grace window elapse; the id never lands, so we clear the param.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2700));
    });

    const last = mockRouterReplace.mock.calls.at(-1)?.[0] as string | undefined;
    expect(last).toBeDefined();
    expect(last).not.toMatch(/session=/);
  });

  it("does NOT bounce when the unknown id lands in the list within the grace window", async () => {
    const withLate = [
      ...defaultSessions,
      {
        id: "late-id",
        path: "",
        mtime: "2026-05-19T11:00:00Z",
        size: 0,
        sessionId: "late-id",
        displayName: null,
        cwd: "/workspace",
        lifecycle: "alive",
        aliases: [],
      },
    ];
    let listCall = 0;
    fetchScript = installMockFetch({
      routes: [
        (url, method) => {
          if (url === "/api/sessions" && method === "GET") {
            listCall += 1;
            return { json: listCall === 1 ? defaultSessions : withLate };
          }
          if (url.startsWith("/api/events?")) return { json: [] };
          if (url.match(/\/api\/sessions\/[^/]+\/(model|summary)$/))
            return { json: { model: null, summary: null } };
          if (url.startsWith("/api/commands") || url.startsWith("/api/skills")) return { json: [] };
          return null;
        },
      ],
    });
    setMockUrl("http://localhost/?session=late-id");
    await loadProviders();

    render(
      <DashboardProviders>
        <div />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });
    mockRouterReplace.mockClear();

    // The row lands via an SSE-driven refresh before the grace elapses.
    fireSse("sessions", { changed: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300));
      await flush();
    });

    // Now let the grace window fully elapse — the timer must see the row and
    // NOT clear the selection.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 2600));
    });

    const clearedSelection = mockRouterReplace.mock.calls
      .map((c) => c[0] as string)
      .some((u) => !/session=/.test(u));
    expect(clearedSelection).toBe(false);
  });

  it("deleteSession() clears the URL when the deleted session is selected", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let captured: { selectedId: string | null; del: (id: string) => Promise<void> } | null = null;
    function Capture() {
      const sel = useSelectedSession();
      const sess = useSessions();
      useEffect(() => {
        captured = { selectedId: sel.selectedId, del: sess.deleteSession };
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    expect(captured!.selectedId).toBe("sess-a");
    await act(async () => {
      await captured!.del("sess-a");
    });

    // setSelected(null) replaces the URL without ?session.
    expect(mockRouterReplace).toHaveBeenCalled();
    const lastReplace = mockRouterReplace.mock.calls.at(-1)?.[0] as string;
    expect(lastReplace).not.toMatch(/session=/);
  });
});

describe("SelectedSessionProvider", () => {
  it("widens aliases on session-status aliasFrom matching the active id", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let aliasesSnapshot: string[] = [];
    function Capture() {
      const sel = useSelectedSession();
      useEffect(() => {
        aliasesSnapshot = sel.aliases;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    fireSse("session-status", { sessionId: "new-id", aliasFrom: "sess-a", status: "alive" });
    await act(async () => {
      await flush();
    });

    expect(aliasesSnapshot).toContain("new-id");
  });

  it("ignores session-status frames for OTHER sessions", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let aliasesSnapshot: string[] = [];
    function Capture() {
      const sel = useSelectedSession();
      useEffect(() => {
        aliasesSnapshot = sel.aliases;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    fireSse("session-status", {
      sessionId: "unrelated-new",
      aliasFrom: "some-other-session",
      status: "alive",
    });
    await act(async () => {
      await flush();
    });

    expect(aliasesSnapshot).toEqual([]);
  });

  it("setSelected(id) writes ?session=id to the URL", async () => {
    let setSel: ((id: string | null) => void) | null = null;
    function Capture() {
      const sel = useSelectedSession();
      useEffect(() => {
        setSel = sel.setSelected;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    act(() => setSel!("sess-b"));
    const lastReplace = mockRouterReplace.mock.calls.at(-1)?.[0] as string;
    expect(lastReplace).toMatch(/session=sess-b/);
  });
});

describe("ActiveSessionProvider — transcript regression guards", () => {
  // The mid-flight session-switch leak is exercised by the stricter
  // "rapid mid-flight session switch in the same provider instance"
  // test below — it stays inside ONE provider mount instead of
  // remounting via loadProviders(), which the old weak version did and
  // which left orphaned consumers throwing during cleanup.

  it("appends `event` SSE frames for the selected id or aliases", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        last = a;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    // Frame for the canonical id.
    fireSse("event", {
      id: 10,
      ts: "2026-05-19T10:00:00Z",
      session_id: "sess-a",
      hook_type: "UserPromptSubmit",
      tool_name: null,
      text: "hi",
    });
    await act(async () => {
      await flush();
    });
    expect(last!.events.some((e) => e.id === 10)).toBe(true);

    // Alias the session, then accept a frame under the new id.
    fireSse("session-status", { sessionId: "alias-1", aliasFrom: "sess-a", status: "alive" });
    fireSse("event", {
      id: 11,
      ts: "2026-05-19T10:01:00Z",
      session_id: "alias-1",
      hook_type: "Stop",
      tool_name: null,
      text: "done",
    });
    await act(async () => {
      await flush();
    });
    expect(last!.events.some((e) => e.id === 11)).toBe(true);
  });

  it("ignores `event` frames for OTHER sessions", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        last = a;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    fireSse("event", {
      id: 42,
      ts: "2026-05-19T10:00:00Z",
      session_id: "sess-b",
      hook_type: "UserPromptSubmit",
      tool_name: null,
      text: "leak attempt",
    });
    await act(async () => {
      await flush();
    });

    expect(last!.events.find((e) => e.id === 42)).toBeUndefined();
  });
});

describe("ActiveSessionProvider — send + waiting", () => {
  it("send() POSTs the message and pushes an optimistic UserPromptSubmit", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        last = a;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    await act(async () => {
      await last!.send("hello there");
    });

    const posted = fetchScript.calls.find(
      (c) => c.url === "/api/sessions/sess-a/message" && c.method === "POST",
    );
    expect(posted).toBeDefined();
    expect((posted!.body as { text: string }).text).toBe("hello there");
    expect(last!.events.some((e) => e.text === "hello there")).toBe(true);
    expect(last!.isWaiting).toBe(true);
  });

  it("seeds a slash-command send's optimistic row with kind=command (no default-bubble flash)", async () => {
    // Regression: the optimistic row used to carry no `kind`, so a `/plan …`
    // turn rendered as an ordinary chat bubble until the real frame arrived and
    // swapped in the command card. Seeding kind up front (the `/plan` intercept
    // is authoritative even with an empty command corpus) keeps the layout
    // stable from the first paint.
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        last = a;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    await act(async () => {
      await last!.send("/plan add caching");
    });

    const optimistic = last!.events.find((e) => e.text === "/plan add caching");
    expect(optimistic).toBeDefined();
    expect(optimistic!.kind).toBe("command");
    // Host viewer → no author (host-authored), matching the real frame.
    expect(optimistic!.author ?? null).toBeNull();
  });

  it("does NOT tag a plain message that merely starts with a slash as a command", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        last = a;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    await act(async () => {
      await last!.send("/etc/hosts got clobbered, please check");
    });

    const row = last!.events.find((e) => e.text?.startsWith("/etc/hosts"));
    expect(row).toBeDefined();
    expect(row!.kind ?? null).toBeNull();
  });

  it("waiting clears on first non-UserPromptSubmit event", async () => {
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        last = a;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    await act(async () => {
      await last!.send("hi");
    });
    expect(last!.isWaiting).toBe(true);

    fireSse("event", {
      id: 50,
      ts: "2026-05-19T10:00:00Z",
      session_id: "sess-a",
      hook_type: "PreToolUse",
      tool_name: "Bash",
      text: null,
    });
    await act(async () => {
      await flush();
    });
    expect(last!.isWaiting).toBe(false);
  });

  it("shows the thinking indicator when a PEER submits a turn (UserPromptSubmit via SSE, no local send)", async () => {
    // Cross-client: another participant's turn must light the indicator for
    // everyone, not just the sender. This client never calls send().
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => { last = a; });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => { await flush(); });
    expect(last!.isWaiting).toBe(false);

    fireSse("event", {
      id: 70,
      ts: "2026-05-19T10:00:00Z",
      session_id: "sess-a",
      hook_type: "UserPromptSubmit",
      tool_name: null,
      text: "a peer asked something",
    });
    await act(async () => { await flush(); });
    expect(last!.isWaiting).toBe(true);

    // …and it clears once the model starts producing output.
    fireSse("event", {
      id: 71,
      ts: "2026-05-19T10:00:02Z",
      session_id: "sess-a",
      hook_type: "Stop",
      tool_name: null,
      text: null,
    });
    await act(async () => { await flush(); });
    expect(last!.isWaiting).toBe(false);
  });

  it("waking a dormant session: SessionStart does NOT clear waiting; the next Stop does", async () => {
    // Regression: when a dormant session is woken, claude fires SessionStart
    // before the model produces output. The previous logic cleared
    // isWaiting on any non-UserPromptSubmit event, which made the
    // "thinking…" indicator vanish prematurely.
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => { last = a; });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => { await flush(); });

    await act(async () => {
      await last!.send("wake up");
    });
    expect(last!.isWaiting).toBe(true);

    // Simulate the wake-path event flurry: SessionStart should be ignored.
    fireSse("event", {
      id: 60,
      ts: "2026-05-19T10:00:00Z",
      session_id: "sess-a",
      hook_type: "SessionStart",
      tool_name: null,
      text: null,
    });
    await act(async () => { await flush(); });
    expect(last!.isWaiting).toBe(true);

    // PreCompact is also a non-output event and should not clear waiting.
    fireSse("event", {
      id: 61,
      ts: "2026-05-19T10:00:01Z",
      session_id: "sess-a",
      hook_type: "PreCompact",
      tool_name: null,
      text: null,
    });
    await act(async () => { await flush(); });
    expect(last!.isWaiting).toBe(true);

    // Now the actual end-of-turn signal lands — indicator should clear.
    fireSse("event", {
      id: 62,
      ts: "2026-05-19T10:00:05Z",
      session_id: "sess-a",
      hook_type: "Stop",
      tool_name: null,
      text: null,
    });
    await act(async () => { await flush(); });
    expect(last!.isWaiting).toBe(false);
  });
});

describe("hardening regressions (bad-mood review fixes)", () => {
  it("useSessionStats reads cumulative tokens from session.lastStats.totals", async () => {
    const sessionsWithTotals = [
      {
        ...defaultSessions[0],
        lastStats: {
          v: 1 as const,
          model: "sonnet-4-6",
          usage: { input_tokens: 100, output_tokens: 50 },
          turnEndedAt: 1_700_000_000_000,
          totals: {
            input_tokens: 84_210,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 12_345,
            output_tokens: 5_600,
            turns: 4,
          },
        },
      },
      defaultSessions[1],
    ];
    fetchScript = installMockFetch({
      routes: [
        (url) => (url === "/api/sessions" ? { json: sessionsWithTotals } : null),
        (url) =>
          url.startsWith("/api/events?") ? { json: [] } : null,
        (url) =>
          url.match(/\/api\/sessions\/[^/]+\/model$/)
            ? { json: { model: null } }
            : null,
        (url) =>
          url.match(/\/api\/sessions\/[^/]+\/summary$/)
            ? { json: { summary: null } }
            : null,
        (url) => (url.startsWith("/api/commands") ? { json: [] } : null),
        (url) => (url.startsWith("/api/skills") ? { json: [] } : null),
      ],
    });
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let last: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        last = a;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    expect(last!.stats.inputTokens).toBe(84_210);
    expect(last!.stats.outputTokens).toBe(5_600);
    expect(last!.stats.cacheReadTokens).toBe(12_345);
    expect(last!.stats.cacheCreationTokens).toBe(200);
    expect(last!.stats.turns).toBe(4);
  });

  it("a sessions refresh whose ONLY delta is lastStats DOES propagate", async () => {
    // Reproduces the shallowEqual bug: the previous build's diff omitted
    // lastStats, so end-of-turn token updates landed in /api/sessions
    // but were eaten by SessionsProvider's "nothing visible changed" guard.
    const before = [{ ...defaultSessions[0], lastStats: undefined as undefined }];
    const after = [
      {
        ...defaultSessions[0],
        lastStats: {
          v: 1 as const,
          totals: {
            input_tokens: 1_000,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
            output_tokens: 500,
            turns: 1,
          },
        },
      },
    ];
    let listCallCount = 0;
    fetchScript = installMockFetch({
      routes: [
        (url) => {
          if (url !== "/api/sessions") return null;
          listCallCount += 1;
          return { json: listCallCount === 1 ? before : after };
        },
        (url) => (url.startsWith("/api/events?") ? { json: [] } : null),
        (url) =>
          url.match(/\/api\/sessions\/[^/]+\/(model|summary)$/)
            ? { json: { model: null, summary: null } }
            : null,
        (url) =>
          url.startsWith("/api/commands") || url.startsWith("/api/skills") ? { json: [] } : null,
      ],
    });
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let captured: SessionInfoLike[] = [];
    function Capture() {
      const s = useSessions();
      useEffect(() => {
        captured = s.sessions;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });
    expect(captured[0].lastStats).toBeUndefined();

    // Trigger a debounced refresh.
    fireSse("sessions", { changed: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await flush();
    });

    expect(captured[0].lastStats?.totals?.input_tokens).toBe(1_000);
  });

  it("a sessions refresh whose ONLY delta is updatedAt (a `!bash`/`>chat`) DOES propagate", async () => {
    // Side-channel activity (a model-free `!bash` or `>chat`) bumps only the
    // registry's lastSeenAt, which the sandbox surfaces as updatedAt. No
    // lifecycle/lastStats/turnActive change rides along, so if shallowEqual
    // ignores updatedAt the refresh is deduped away and the session never reads
    // as recently-active — the reported "not activating the session" bug.
    const before = [{ ...defaultSessions[0], updatedAt: 1_000 }];
    const after = [{ ...defaultSessions[0], updatedAt: 2_000 }];
    let listCallCount = 0;
    fetchScript = installMockFetch({
      routes: [
        (url) => {
          if (url !== "/api/sessions") return null;
          listCallCount += 1;
          return { json: listCallCount === 1 ? before : after };
        },
        (url) => (url.startsWith("/api/events?") ? { json: [] } : null),
        (url) =>
          url.match(/\/api\/sessions\/[^/]+\/(model|summary)$/)
            ? { json: { model: null, summary: null } }
            : null,
        (url) =>
          url.startsWith("/api/commands") || url.startsWith("/api/skills") ? { json: [] } : null,
      ],
    });
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let captured: SessionInfoLike[] = [];
    function Capture() {
      const s = useSessions();
      useEffect(() => {
        captured = s.sessions;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });
    expect(captured[0].updatedAt).toBe(1_000);

    fireSse("sessions", { changed: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await flush();
    });

    expect(captured[0].updatedAt).toBe(2_000);
  });

  it("a sessions refresh whose ONLY delta is turnActive DOES propagate", async () => {
    // The running pulse reads off turnActive; the same dedupe trap applies.
    const before = [{ ...defaultSessions[0], turnActive: false }];
    const after = [{ ...defaultSessions[0], turnActive: true }];
    let listCallCount = 0;
    fetchScript = installMockFetch({
      routes: [
        (url) => {
          if (url !== "/api/sessions") return null;
          listCallCount += 1;
          return { json: listCallCount === 1 ? before : after };
        },
        (url) => (url.startsWith("/api/events?") ? { json: [] } : null),
        (url) =>
          url.match(/\/api\/sessions\/[^/]+\/(model|summary)$/)
            ? { json: { model: null, summary: null } }
            : null,
        (url) =>
          url.startsWith("/api/commands") || url.startsWith("/api/skills") ? { json: [] } : null,
      ],
    });
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let captured: SessionInfoLike[] = [];
    function Capture() {
      const s = useSessions();
      useEffect(() => {
        captured = s.sessions;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });
    expect(captured[0].turnActive).toBe(false);

    fireSse("sessions", { changed: true });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
      await flush();
    });

    expect(captured[0].turnActive).toBe(true);
  });

  it("renameSession rolls back the optimistic update on a 4xx and rethrows", async () => {
    fetchScript = installMockFetch({
      routes: [
        (url, method) => {
          if (url === "/api/sessions" && method === "GET") {
            return { json: defaultSessions };
          }
          if (
            url.match(/\/api\/sessions\/[^/]+$/) &&
            method === "PATCH"
          ) {
            return { status: 400, json: { error: "name too long" } };
          }
          if (url.startsWith("/api/events?")) return { json: [] };
          if (url.match(/\/api\/sessions\/[^/]+\/(model|summary)$/))
            return { json: { model: null, summary: null } };
          if (url.startsWith("/api/commands") || url.startsWith("/api/skills")) return { json: [] };
          return null;
        },
      ],
    });
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    let api: ReturnType<typeof useSessions> | null = null;
    function Capture() {
      const s = useSessions();
      useEffect(() => {
        api = s;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });
    const before = api!.sessions[0].displayName;
    expect(before).toBe("alpha-bravo-charlie");

    await expect(
      act(async () => {
        await api!.renameSession("sess-a", "x".repeat(300));
      }),
    ).rejects.toThrow(/name too long/);

    expect(api!.sessions[0].displayName).toBe(before);
  });

  it("an `event` SSE arrival does NOT re-create useActiveSession `send` identity", async () => {
    // Without stable send identity, every event arrival would invalidate
    // every memo dependent on send — invisible render-thrash regression
    // that the previous Phase 3 build introduced. This test pins it.
    setMockUrl("http://localhost/?session=sess-a");
    await loadProviders();

    const sendSnapshots: Array<(text: string) => Promise<void>> = [];
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        sendSnapshots.push(a.send);
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });
    const initial = sendSnapshots[sendSnapshots.length - 1];

    fireSse("event", {
      id: 70,
      ts: "2026-05-19T10:00:00Z",
      session_id: "sess-a",
      hook_type: "PreToolUse",
      tool_name: "Bash",
      text: null,
    });
    fireSse("event", {
      id: 71,
      ts: "2026-05-19T10:00:01Z",
      session_id: "sess-a",
      hook_type: "PostToolUse",
      tool_name: "Bash",
      text: null,
    });
    await act(async () => {
      await flush();
    });

    const latest = sendSnapshots[sendSnapshots.length - 1];
    expect(latest).toBe(initial);
  });

  it("rapid mid-flight session switch in the same provider instance does not leak events", async () => {
    // Strengthens the earlier weak test: stays inside ONE provider mount,
    // hands sess-a a never-resolving events response, then setSelected('b')
    // and asserts the late-resolving sess-a frames never enter state.
    setMockUrl("http://localhost/?session=sess-a");

    let releaseSessA: (() => void) | null = null;
    const sessAEvents = [
      {
        id: 999,
        ts: "2026-05-19T10:00:00Z",
        session_id: "sess-a",
        hook_type: "UserPromptSubmit",
        tool_name: null,
        text: "ghost",
      },
    ];

    fetchScript = installMockFetch({
      routes: [
        (url, method) => {
          if (url === "/api/sessions" && method === "GET") {
            return { json: defaultSessions };
          }
          if (url.startsWith("/api/events?session=sess-a")) {
            // Deferred: hold until the test releases.
            return null;
          }
          if (url.startsWith("/api/events?session=sess-b")) {
            return { json: [] };
          }
          if (url.match(/\/api\/sessions\/[^/]+\/(model|summary)$/)) {
            return { json: { model: null, summary: null } };
          }
          if (url.startsWith("/api/commands") || url.startsWith("/api/skills")) return { json: [] };
          return null;
        },
      ],
    });
    // One-shot deferred response for sess-a's events.
    let resolveSlow: ((res: { status: number; json: unknown }) => void) | null = null;
    const slowResponse: Promise<{ status: number; json: unknown }> = new Promise((res) => {
      resolveSlow = (v) => res(v);
    });
    releaseSessA = () => resolveSlow?.({ status: 200, json: sessAEvents });
    fetchScript.once(
      (url) => url.startsWith("/api/events?session=sess-a"),
      { delayMs: 0, json: [] }, // placeholder; overridden below
    );
    // Intercept the placeholder and route to the slowResponse promise:
    // we re-stub the once mock so it actually waits.
    const realFn = (globalThis as { fetch?: typeof fetch }).fetch!;
    (globalThis as { fetch?: typeof fetch }).fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/events?session=sess-a")) {
        const v = await slowResponse;
        return new Response(JSON.stringify(v.json), {
          status: v.status,
          headers: { "content-type": "application/json" },
        });
      }
      return realFn(input as Request, init);
    }) as typeof fetch;

    await loadProviders();

    let activeSnapshot: ReturnType<typeof useActiveSession> | null = null;
    function Capture() {
      const a = useActiveSession();
      useEffect(() => {
        activeSnapshot = a;
      });
      return null;
    }
    let setSel: ((id: string | null) => void) | null = null;
    function CaptureSel() {
      const s = useSelectedSession();
      useEffect(() => {
        setSel = s.setSelected;
      });
      return null;
    }
    render(
      <DashboardProviders>
        <Capture />
        <CaptureSel />
      </DashboardProviders>,
    );
    await act(async () => {
      await flush();
    });

    // Switch session BEFORE sess-a's events resolve.
    act(() => setSel!("sess-b"));
    setMockUrl("http://localhost/?session=sess-b");

    await act(async () => {
      await flush();
    });

    // Now release the stale sess-a fetch. It must NOT enter state.
    releaseSessA?.();
    await act(async () => {
      await flush();
      await flush();
    });

    expect(activeSnapshot!.events.some((e) => e.id === 999)).toBe(false);
  });
});

// Loose shape for the captured sessions array in tests.
type SessionInfoLike = {
  sessionId?: string;
  displayName?: string | null;
  updatedAt?: number;
  turnActive?: boolean;
  lastStats?: {
    totals?: { input_tokens: number };
  };
};

async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}
