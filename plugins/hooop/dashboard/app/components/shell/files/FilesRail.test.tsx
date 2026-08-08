import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { FileNode, GitStatus } from "./types";

// FilesRail owns a small state machine nothing else can exercise: which
// directories are open, how that survives the tree being wholesale replaced on
// every live refresh, and what a `lazy` (never-walked) directory does under a
// filter. The context it reads is mocked so these tests drive the tree
// directly — `useSessionFileTree` itself is real and thin (it just reads
// FilesUIProvider), and the provider's own fetch/splice behavior is covered in
// FilesUIProvider.test.tsx.

const loadSubtree = vi.fn();
const openFile = vi.fn();
const insertReference = vi.fn();

const state: {
  tree: FileNode[];
  treeLoading: boolean;
  treeTruncated: boolean;
  loadingPaths: Set<string>;
  file: { sessionId: string; path: string; name: string } | null;
} = { tree: [], treeLoading: false, treeTruncated: false, loadingPaths: new Set(), file: null };

vi.mock("@/app/context/FilesUIProvider", () => ({
  useFilesUI: () => ({ ...state, loadSubtree, openFile }),
}));
vi.mock("@/app/context/useSelectedCwd", () => ({ useSelectedCwd: () => "/workspace" }));
vi.mock("@/app/context/SelectedSessionProvider", () => ({ useSelectedSession: () => ({ selectedId: "s1" }) }));
vi.mock("@/app/context/ComposerInsertProvider", () => ({
  useComposerInsert: () => ({ insertReference, canInsert: true }),
}));

import { FilesRail } from "./FilesRail";

// Paths are written out in full (the sandbox sends cwd-relative paths, and the
// rail keys all of its per-directory state on them), with `name` derived.
const leaf = (path: string): string => path.split("/").pop() as string;
const dir = (path: string, children: FileNode[], status: GitStatus = null): FileNode => ({
  name: leaf(path),
  path,
  isDir: true,
  status,
  children,
});
const file = (path: string, status: GitStatus = null): FileNode => ({
  name: leaf(path),
  path,
  isDir: false,
  status,
});
/** A directory git/walkFs deliberately left unwalked: its children exist on
 * disk but weren't sent, and are fetched on demand. */
const lazyDir = (path: string): FileNode => ({
  name: leaf(path),
  path,
  isDir: true,
  status: "ignored",
  children: [],
  lazy: true,
});

function mount(tree: FileNode[]) {
  state.tree = tree;
  const utils = render(<FilesRail />);
  return {
    ...utils,
    /** A live refresh: the provider replaces the whole tree with the server's
     * fresh top-level walk, so a NEW reference (even for identical content) is
     * the load-bearing part. */
    refresh(next: FileNode[]) {
      state.tree = next;
      utils.rerender(<FilesRail />);
    },
  };
}

const row = (name: string) => screen.getByText(name).closest("[role=treeitem]") as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  state.tree = [];
  state.treeLoading = false;
  state.treeTruncated = false;
  state.loadingPaths = new Set();
  state.file = null;
});

describe("FilesRail — expansion state across live refreshes", () => {
  // A directory carrying changes auto-expands, and the tree is replaced on
  // every live refresh (roughly once per file save during agent work), so
  // re-seeding the auto-expanded set has to distinguish "not opened yet" from
  // "the user closed this".
  const changedTree = () => [dir("src", [file("src/index.ts", "changed")], "changed")];

  it("keeps a hand-collapsed directory closed across refreshes, even though it auto-expands", () => {
    const { refresh } = mount(changedTree());
    expect(screen.queryByText("index.ts")).toBeInTheDocument();

    fireEvent.click(row("src"));
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();

    // Before the collapsed-set fix this re-opened here, and kept re-opening on
    // every subsequent tick — the directory could not be closed at all.
    refresh(changedTree());
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    expect(row("src")).toHaveAttribute("aria-expanded", "false");

    // Re-opening by hand still works, and clears the "closed" memory.
    fireEvent.click(row("src"));
    refresh(changedTree());
    expect(screen.queryByText("index.ts")).toBeInTheDocument();
  });

  it("keeps a hand-expanded directory open across refreshes", () => {
    const clean = () => [dir("lib", [file("lib/util.ts")])];
    const { refresh } = mount(clean());
    expect(screen.queryByText("util.ts")).not.toBeInTheDocument();

    fireEvent.click(row("lib"));
    expect(screen.queryByText("util.ts")).toBeInTheDocument();

    refresh(clean());
    expect(screen.queryByText("util.ts")).toBeInTheDocument();
  });

  it("forgets a directory's expansion once it no longer exists", () => {
    // The expanded/collapsed sets are keyed by path and live as long as the
    // rail, so they have to be pruned: otherwise they retain every path ever
    // opened for the life of the tab, and a directory that's deleted and later
    // recreated comes back mysteriously pre-expanded.
    const withTmp = () => [dir("tmp", [file("tmp/scratch.txt")])];
    const { refresh } = mount(withTmp());
    fireEvent.click(row("tmp"));
    expect(screen.queryByText("scratch.txt")).toBeInTheDocument();

    refresh([dir("lib", [file("lib/util.ts")])]); // tmp deleted
    refresh(withTmp()); // …and recreated
    expect(screen.queryByText("scratch.txt")).not.toBeInTheDocument();
  });

  it("does not treat an empty tree as 'everything was deleted'", () => {
    // The provider also sets an empty tree when the fetch fails or the
    // session goes away, so pruning against it would throw away expansion
    // state on a transient blip.
    const clean = () => [dir("lib", [file("lib/util.ts")])];
    const { refresh } = mount(clean());
    fireEvent.click(row("lib"));
    expect(screen.queryByText("util.ts")).toBeInTheDocument();

    refresh([]);
    refresh(clean());
    expect(screen.queryByText("util.ts")).toBeInTheDocument();
  });

  it("keeps expansion inside a lazily-loaded directory, which a refresh blanks to a placeholder", () => {
    // The one case pruning must NOT touch: `node_modules/pkg` is absent from a
    // refreshed walk only because lazy children are never sent. Pruning it
    // would silently collapse everything the user had open in there.
    const loaded = () => [
      {
        ...dir("node_modules", [dir("node_modules/pkg", [file("node_modules/pkg/index.js", "ignored")], "ignored")], "ignored"),
        lazy: false,
      },
    ];
    const { refresh } = mount(loaded());
    fireEvent.click(row("node_modules"));
    fireEvent.click(row("pkg"));
    expect(screen.queryByText("index.js")).toBeInTheDocument();

    refresh([lazyDir("node_modules")]); // live refresh: back to a placeholder
    refresh(loaded()); // …and reloaded on click
    expect(screen.queryByText("index.js")).toBeInTheDocument();
  });
});

describe("FilesRail — lazy directories under a filter", () => {
  const tree = () => [lazyDir("node_modules"), dir("src", [file("src/index.ts")])];

  it("surfaces an unsearched lazy directory instead of silently excluding it", () => {
    mount(tree());
    fireEvent.change(screen.getByLabelText("Filter files by name"), { target: { value: "zzz" } });

    // Nothing in the walked part of the tree matches…
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
    // …but node_modules' contents were never fetched, so the filter provably
    // has not been applied inside it. It stays visible and says so, rather
    // than rendering as an open-but-empty folder with no explanation.
    expect(screen.queryByText("node_modules")).toBeInTheDocument();
    expect(screen.queryByText("not searched")).toBeInTheDocument();

    // And the row is the affordance: one click loads it, after which the
    // filter covers its real contents.
    fireEvent.click(row("node_modules"));
    expect(loadSubtree).toHaveBeenCalledWith("node_modules");
  });

  it("does not label anything unsearched when no filter is running", () => {
    mount(tree());
    expect(screen.queryByText("not searched")).not.toBeInTheDocument();
  });

  it("hides an ignored lazy directory under the changed-only filter", () => {
    // Unlike the text filter, "changed only" is a question the lazy dir's own
    // status already answers — nothing is hidden by not walking it.
    mount(tree());
    fireEvent.click(screen.getByTitle("Show changed files only"));
    expect(screen.queryByText("node_modules")).not.toBeInTheDocument();
  });
});

describe("FilesRail — a lazy load that keeps failing", () => {
  it("retries in place once, then lets the directory be collapsed again", () => {
    // A failed load leaves the node `lazy` (the provider keeps it retryable),
    // and a live refresh blanks an expanded lazy dir back to a placeholder — so
    // "click reloads in place instead of toggling" was unconditional, and a
    // directory whose load never succeeds could never be closed.
    mount([lazyDir("node_modules"), dir("src", [file("src/index.ts")])]);

    fireEvent.click(row("node_modules")); // open + load
    expect(loadSubtree).toHaveBeenCalledTimes(1);
    expect(row("node_modules")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(row("node_modules")); // still lazy (load failed): retry, stay open
    expect(loadSubtree).toHaveBeenCalledTimes(2);
    expect(row("node_modules")).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(row("node_modules")); // one retry was enough of a try
    expect(loadSubtree).toHaveBeenCalledTimes(2);
    expect(row("node_modules")).toHaveAttribute("aria-expanded", "false");

    // Expanding again is a fresh attempt, not a dead end.
    fireEvent.click(row("node_modules"));
    expect(loadSubtree).toHaveBeenCalledTimes(3);
  });

  it("does not re-request a directory that is already loading", () => {
    state.loadingPaths = new Set(["node_modules"]);
    mount([lazyDir("node_modules")]);
    fireEvent.click(row("node_modules"));
    expect(loadSubtree).not.toHaveBeenCalled();
  });
});

describe("FilesRail — keyboard and screen-reader access", () => {
  const tree = () => [
    dir("src", [file("src/index.ts"), file("src/util.ts")], "changed"),
    file("README.md"),
  ];

  it("exposes the tree with levels, expansion state and sibling positions", () => {
    mount(tree());
    expect(screen.getByRole("tree", { name: "Workspace files" })).toBeInTheDocument();
    expect(row("src")).toHaveAttribute("aria-level", "1");
    expect(row("src")).toHaveAttribute("aria-expanded", "true");
    expect(row("index.ts")).toHaveAttribute("aria-level", "2");
    expect(row("index.ts")).toHaveAttribute("aria-posinset", "1");
    expect(row("index.ts")).toHaveAttribute("aria-setsize", "2");
    // Files aren't expandable, so they must not claim to be collapsed.
    expect(row("README.md")).not.toHaveAttribute("aria-expanded");
  });

  it("says nothing about expansion for a genuinely empty directory", () => {
    // An empty dir with aria-expanded="false" would be announced as collapsed,
    // implying there's something inside to open.
    mount([dir("empty", [])]);
    expect(row("empty")).not.toHaveAttribute("aria-expanded");
  });

  it("keeps exactly one row in the tab order and moves it with the arrows", () => {
    mount(tree());
    const tabbable = () => screen.queryAllByRole("treeitem").filter((r) => r.getAttribute("tabindex") === "0");
    expect(tabbable()).toEqual([row("src")]);

    fireEvent.focus(row("src"));
    fireEvent.keyDown(row("src"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("index.ts"));
    expect(tabbable()).toEqual([row("index.ts")]);

    fireEvent.keyDown(row("index.ts"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("util.ts"));

    fireEvent.keyDown(row("util.ts"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(row("index.ts"));

    fireEvent.keyDown(row("index.ts"), { key: "End" });
    expect(document.activeElement).toBe(row("README.md"));

    fireEvent.keyDown(row("README.md"), { key: "Home" });
    expect(document.activeElement).toBe(row("src"));
  });

  it("expands and collapses with the horizontal arrows", () => {
    mount([dir("lib", [file("lib/util.ts")])]);
    fireEvent.focus(row("lib"));
    expect(screen.queryByText("util.ts")).not.toBeInTheDocument();

    fireEvent.keyDown(row("lib"), { key: "ArrowRight" });
    expect(screen.queryByText("util.ts")).toBeInTheDocument();

    // Open already: ArrowRight steps into the first child instead.
    fireEvent.keyDown(row("lib"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(row("util.ts"));

    // On a leaf, ArrowLeft goes back to the parent…
    fireEvent.keyDown(row("util.ts"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row("lib"));
    // …and on an open directory it closes it.
    fireEvent.keyDown(row("lib"), { key: "ArrowLeft" });
    expect(screen.queryByText("util.ts")).not.toBeInTheDocument();
  });

  it("opens a file with Enter and toggles a directory with Space", () => {
    mount(tree());
    fireEvent.focus(row("README.md"));
    fireEvent.keyDown(row("README.md"), { key: "Enter" });
    expect(openFile).toHaveBeenCalledWith({ sessionId: "s1", path: "README.md", name: "README.md" });

    fireEvent.focus(row("src"));
    fireEvent.keyDown(row("src"), { key: " " });
    expect(screen.queryByText("index.ts")).not.toBeInTheDocument();
  });

  it("leaves the insert-reference button's own keys alone", () => {
    // The button sits inside the row, so its keydowns bubble to the tree's
    // handler — Enter there must insert the reference WITHOUT the row also
    // handling it as "activate this file".
    mount(tree());
    fireEvent.keyDown(screen.getByLabelText("Insert README.md as a reference"), { key: "Enter" });
    expect(openFile).not.toHaveBeenCalled();
  });
});
