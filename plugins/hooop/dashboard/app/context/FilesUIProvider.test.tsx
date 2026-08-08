import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import {
  installMockEventSource,
  clearEventSources,
  latestEventSource,
} from "./__test-utils__/mock-event-source";
import { installMockFetch, type FetchScript } from "./__test-utils__/mock-fetch";
import { installMockNavigation, setMockUrl } from "./__test-utils__/mock-navigation";
import type { FileNode } from "@/app/components/shell/files/types";

// Dynamic-imported after mocks are installed, same pattern as useFiles.test.tsx.
let SelectedSessionProvider: typeof import("./SelectedSessionProvider").SelectedSessionProvider;
let SessionsProvider: typeof import("./SessionsProvider").SessionsProvider;
let FilesUIProvider: typeof import("./FilesUIProvider").FilesUIProvider;
let useFilesUI: typeof import("./FilesUIProvider").useFilesUI;

async function loadModules() {
  vi.resetModules();
  const sel = await import("./SelectedSessionProvider");
  const sess = await import("./SessionsProvider");
  const ui = await import("./FilesUIProvider");
  SelectedSessionProvider = sel.SelectedSessionProvider;
  SessionsProvider = sess.SessionsProvider;
  FilesUIProvider = ui.FilesUIProvider;
  useFilesUI = ui.useFilesUI;
}

function wrap({ children }: { children: React.ReactNode }) {
  return (
    <SelectedSessionProvider>
      <SessionsProvider>
        <FilesUIProvider>{children}</FilesUIProvider>
      </SessionsProvider>
    </SelectedSessionProvider>
  );
}

/** The shape the sandbox's TOP-LEVEL walk returns: a heavy directory is a
 * `lazy` placeholder with empty children, never eagerly enumerated. */
const TOP_LEVEL: FileNode[] = [
  { name: "node_modules", path: "node_modules", isDir: true, status: "ignored", children: [], lazy: true },
  {
    name: "src",
    path: "src",
    isDir: true,
    status: null,
    children: [{ name: "index.ts", path: "src/index.ts", isDir: false, status: null }],
  },
];

/** What GET /files/tree?path=node_modules returns for that placeholder. */
const SUBTREE: FileNode[] = [
  {
    name: "pkg-alpha",
    path: "node_modules/pkg-alpha",
    isDir: true,
    status: "ignored",
    children: [{ name: "index.js", path: "node_modules/pkg-alpha/index.js", isDir: false, status: "ignored" }],
  },
];

const isTopLevelTree = (url: string) => url.startsWith("/api/files/tree") && !url.includes("&path=");
const isSubtree = (url: string) => url.startsWith("/api/files/tree") && url.includes("&path=");

function findNode(nodes: FileNode[], path: string): FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const hit = findNode(n.children, path);
      if (hit) return hit;
    }
  }
  return null;
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
                  mtime: "2026-07-27T00:00:00Z",
                  size: 0,
                  sessionId: "sess-a",
                  cwd: "/workspace",
                  lifecycle: "alive",
                  aliases: [],
                },
              ],
            }
          : null,
      (url) => (isSubtree(url) ? { json: { tree: SUBTREE, truncated: false } } : null),
      (url) => (isTopLevelTree(url) ? { json: { tree: TOP_LEVEL, truncated: false } } : null),
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

describe("FilesUIProvider — lazy subtree loading", () => {
  it("loadSubtree fetches the directory's real contents and splices them in, clearing `lazy`", async () => {
    const { result } = renderHook(() => useFilesUI(), { wrapper: wrap });
    await waitFor(() => expect(result.current.tree).toHaveLength(2));
    expect(findNode(result.current.tree, "node_modules")).toMatchObject({ lazy: true, children: [] });

    act(() => result.current.loadSubtree("node_modules"));

    await waitFor(() =>
      expect(findNode(result.current.tree, "node_modules/pkg-alpha/index.js")).not.toBeNull(),
    );
    // `lazy` cleared, so expanding again is pure visibility — no second fetch.
    expect(findNode(result.current.tree, "node_modules")?.lazy).toBe(false);
    // Untouched siblings keep their identity (immutable splice, not a rebuild).
    expect(findNode(result.current.tree, "src/index.ts")).not.toBeNull();
    expect(fetchScript.calls.filter((c) => isSubtree(c.url))).toHaveLength(1);
    expect(fetchScript.calls.find((c) => isSubtree(c.url))?.url).toContain("path=node_modules");
  });

  it("dedupes concurrent loads of the same path into ONE request", async () => {
    const { result } = renderHook(() => useFilesUI(), { wrapper: wrap });
    await waitFor(() => expect(result.current.tree).toHaveLength(2));
    fetchScript.once(isSubtree, { json: { tree: SUBTREE, truncated: false }, delayMs: 50 });

    act(() => {
      result.current.loadSubtree("node_modules");
      result.current.loadSubtree("node_modules");
      result.current.loadSubtree("node_modules");
    });

    await waitFor(() => expect(result.current.loadingPaths.has("node_modules")).toBe(false));
    expect(fetchScript.calls.filter((c) => isSubtree(c.url))).toHaveLength(1);
  });

  it("exposes the in-flight path via loadingPaths so the row can show a spinner", async () => {
    const { result } = renderHook(() => useFilesUI(), { wrapper: wrap });
    await waitFor(() => expect(result.current.tree).toHaveLength(2));
    fetchScript.once(isSubtree, { json: { tree: SUBTREE, truncated: false }, delayMs: 80 });

    act(() => result.current.loadSubtree("node_modules"));
    await waitFor(() => expect(result.current.loadingPaths.has("node_modules")).toBe(true));
    await waitFor(() => expect(result.current.loadingPaths.has("node_modules")).toBe(false));
  });

  it("a live refresh resets a loaded lazy dir to a placeholder and does NOT auto-refetch it", async () => {
    // The deliberate cost tradeoff, pinned as a test because it's the kind of
    // thing a well-meaning "fix the blank directory" change would undo: the
    // top-level response ALWAYS represents a lazy dir as an empty placeholder,
    // so a live refresh does blank it — and the provider must NOT chase that
    // with a subtree refetch. Measured on a real node_modules (490 packages,
    // 30k files) one refetch is ~1.66 MiB / 17.4k nodes / ~100ms of server
    // walk, and this path runs on every live refresh — roughly once per save
    // (the sandbox's `files` emit is a trailing 300ms debounce, so bursts
    // coalesce into one). Recovery is FilesRail's `openDir`, on a single
    // click, for the ONE directory the user actually has open.
    const { result } = renderHook(() => useFilesUI(), { wrapper: wrap });
    await waitFor(() => expect(result.current.tree).toHaveLength(2));
    act(() => result.current.loadSubtree("node_modules"));
    await waitFor(() => expect(findNode(result.current.tree, "node_modules")?.lazy).toBe(false));
    const subtreeCallsBefore = fetchScript.calls.filter((c) => isSubtree(c.url)).length;

    act(() => latestEventSource()?.fire("files", { sessionId: "sess-a", cwd: "/workspace" }));

    // Top-level refetch happens (that's the live refresh)…
    await waitFor(() => expect(findNode(result.current.tree, "node_modules")?.lazy).toBe(true));
    expect(findNode(result.current.tree, "node_modules")?.children).toEqual([]);
    // …but no subtree refetch rides along with it.
    await new Promise((r) => setTimeout(r, 100));
    expect(fetchScript.calls.filter((c) => isSubtree(c.url))).toHaveLength(subtreeCallsBefore);

    // And loading it again works (no stale in-flight/loaded bookkeeping left
    // behind that would swallow the retry click).
    act(() => result.current.loadSubtree("node_modules"));
    await waitFor(() =>
      expect(findNode(result.current.tree, "node_modules/pkg-alpha/index.js")).not.toBeNull(),
    );
  });

  it("asks for only the node budget the accumulated tree still has room for", async () => {
    // The sandbox's cap is per RESPONSE, so N expansions would otherwise put
    // N full budgets in client state. `max` is this side's half of that
    // contract: spend down one shared ceiling instead.
    const { result } = renderHook(() => useFilesUI(), { wrapper: wrap });
    await waitFor(() => expect(result.current.tree).toHaveLength(2));

    act(() => result.current.loadSubtree("node_modules"));
    await waitFor(() => expect(result.current.loadingPaths.has("node_modules")).toBe(false));

    // TOP_LEVEL is 3 nodes (node_modules, src, src/index.ts) out of 60000.
    expect(fetchScript.calls.find((c) => isSubtree(c.url))?.url).toContain("max=59997");
  });

  it("declines to load another subtree once the tree is at the node ceiling, and says so", async () => {
    // Pathological-but-reachable: enough expansions (or one enormous
    // directory) to fill the client budget. Refusing beats silently
    // presenting a truncated subtree as the directory's real contents.
    const huge: FileNode[] = [
      { name: "node_modules", path: "node_modules", isDir: true, status: "ignored", children: [], lazy: true },
      ...Array.from({ length: 60000 }, (_, i) => ({
        name: `f${i}.ts`,
        path: `f${i}.ts`,
        isDir: false,
        status: null as FileNode["status"],
      })),
    ];
    fetchScript.once(isTopLevelTree, { json: { tree: huge, truncated: false } });
    const { result } = renderHook(() => useFilesUI(), { wrapper: wrap });
    await waitFor(() => expect(result.current.tree.length).toBeGreaterThan(60000));
    const before = fetchScript.calls.filter((c) => isSubtree(c.url)).length;

    act(() => result.current.loadSubtree("node_modules"));

    expect(fetchScript.calls.filter((c) => isSubtree(c.url))).toHaveLength(before);
    // Not a silent no-op: the navigator's truncation notice explains it, and
    // the node stays lazy rather than posing as an empty directory.
    expect(result.current.treeTruncated).toBe(true);
    expect(findNode(result.current.tree, "node_modules")?.lazy).toBe(true);
    expect(result.current.loadingPaths.has("node_modules")).toBe(false);
  });

  it("keeps a failed subtree load lazy so the next click retries it", async () => {
    const { result } = renderHook(() => useFilesUI(), { wrapper: wrap });
    await waitFor(() => expect(result.current.tree).toHaveLength(2));
    fetchScript.once(isSubtree, { status: 500, json: { error: "boom" } });

    act(() => result.current.loadSubtree("node_modules"));
    await waitFor(() => expect(result.current.loadingPaths.has("node_modules")).toBe(false));
    expect(findNode(result.current.tree, "node_modules")?.lazy).toBe(true);

    act(() => result.current.loadSubtree("node_modules"));
    await waitFor(() =>
      expect(findNode(result.current.tree, "node_modules/pkg-alpha/index.js")).not.toBeNull(),
    );
  });
});
