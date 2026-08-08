import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import {
  installMockEventSource,
  clearEventSources,
} from "./__test-utils__/mock-event-source";
import { installMockFetch, type FetchScript } from "./__test-utils__/mock-fetch";
import { installMockNavigation, setMockUrl } from "./__test-utils__/mock-navigation";

// Dynamic-imported after mocks are installed, same pattern as
// __tests__/providers.test.tsx, so vi.doMock("next/navigation") wins.
let SelectedSessionProvider: typeof import("./SelectedSessionProvider").SelectedSessionProvider;
let SessionsProvider: typeof import("./SessionsProvider").SessionsProvider;
let useFiles: typeof import("./useFiles").useFiles;

async function loadModules() {
  vi.resetModules();
  const sel = await import("./SelectedSessionProvider");
  const sess = await import("./SessionsProvider");
  const uf = await import("./useFiles");
  SelectedSessionProvider = sel.SelectedSessionProvider;
  SessionsProvider = sess.SessionsProvider;
  useFiles = uf.useFiles;
}

function wrap({ children }: { children: React.ReactNode }) {
  return (
    <SelectedSessionProvider>
      <SessionsProvider>{children}</SessionsProvider>
    </SelectedSessionProvider>
  );
}

let fetchScript: FetchScript;

beforeEach(async () => {
  installMockEventSource();
  installMockNavigation();
  fetchScript = installMockFetch({
    routes: [
      (url) =>
        url === "/api/sessions"
          ? {
              json: [
                {
                  id: "sess-a",
                  path: "",
                  mtime: "2026-07-15T00:00:00Z",
                  size: 0,
                  sessionId: "sess-a",
                  cwd: "/workspace",
                  lifecycle: "alive",
                  aliases: [],
                },
              ],
            }
          : null,
    ],
    fallback: { status: 200, json: {} },
  });
  setMockUrl("http://localhost/?session=sess-a");
  await loadModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearEventSources();
});

describe("useFiles", () => {
  it("stays closed (no fetch, no entries) while query is null", async () => {
    const { result } = renderHook(() => useFiles(null), { wrapper: wrap });
    expect(result.current).toEqual({ entries: [], loading: false });

    // Give the debounce window plenty of time to prove no fetch fires.
    await new Promise((r) => setTimeout(r, 200));
    expect(fetchScript.calls.some((c) => c.url.startsWith("/api/files"))).toBe(false);
  });

  it("debounces, fetches /api/files once the query settles, and maps FileEntry to AutocompleteEntry", async () => {
    fetchScript.once(
      (url) => url.startsWith("/api/files"),
      { json: { entries: [{ name: "a.ts", isDir: false }, { name: "src", isDir: true }] } },
    );

    const { result } = renderHook(() => useFiles("a"), { wrapper: wrap });

    await waitFor(
      () =>
        expect(result.current).toEqual({
          entries: [
            { insert: "@a.ts", label: "a.ts", description: null, kind: "file", source: null },
            { insert: "@src", label: "src", description: "directory", kind: "dir", source: null },
          ],
          loading: false,
        }),
      { timeout: 2000 },
    );

    const filesCalls = fetchScript.calls.filter((c) => c.url.startsWith("/api/files"));
    expect(filesCalls).toHaveLength(1);
    expect(filesCalls[0].url).toContain("cwd=%2Fworkspace");
    expect(filesCalls[0].url).toContain("q=a");
  });

  it("never lets a stale in-flight request clobber a newer query's resolved result", async () => {
    // "a" resolves slowly; "b" (issued after) resolves fast. Without the
    // monotonic request-id guard, "a"'s late response would overwrite "b"'s.
    fetchScript.once(
      (url) => url.includes("q=a"),
      { json: { entries: [{ name: "a-result.ts", isDir: false }] }, delayMs: 300 },
    );
    fetchScript.once(
      (url) => url.includes("q=b"),
      { json: { entries: [{ name: "b-result.ts", isDir: false }] } },
    );

    const { result, rerender } = renderHook(({ q }) => useFiles(q), {
      wrapper: wrap,
      initialProps: { q: "a" },
    });

    // Wait for "a"'s debounced fetch to actually fire (still in flight, delayed).
    await waitFor(
      () => expect(fetchScript.calls.some((c) => c.url.includes("q=a"))).toBe(true),
      { timeout: 2000 },
    );

    rerender({ q: "b" });

    await waitFor(
      () =>
        expect(result.current.entries).toEqual([
          { insert: "@b-result.ts", label: "b-result.ts", description: null, kind: "file", source: null },
        ]),
      { timeout: 2000 },
    );

    // Let "a"'s delayed response land — it must not clobber "b"'s result.
    await new Promise((r) => setTimeout(r, 400));
    expect(result.current.entries).toEqual([
      { insert: "@b-result.ts", label: "b-result.ts", description: null, kind: "file", source: null },
    ]);
  });
});
