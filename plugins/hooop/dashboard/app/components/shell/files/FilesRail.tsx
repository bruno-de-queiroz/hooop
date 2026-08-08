"use client";
import { useCallback, useMemo, useRef, useState } from "react";
import { ChevronRight, File as FileIcon, Filter, Folder, Loader2, Plus, Search } from "lucide-react";
import { cn } from "../../ui/cn";
import { cwdBasename } from "../../lib/format";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import { useComposerInsert } from "@/app/context/ComposerInsertProvider";
import { useSessionFileTree } from "./useSessionFiles";
import type { FileNode, GitStatus } from "./types";

// The Files navigator: workspace tree decorated with the session's git status
// (added / changed / removed / ignored), a filter, an insert-as-@reference
// action, and click-to-preview. Matches the mockup's Files view.
//
// Rendered FLAT (one row per visible node, `aria-level` carrying the depth)
// rather than as nested containers, which is what makes keyboard navigation
// tractable: DOM order is exactly the visible order, so arrow keys are index
// arithmetic over `rows` and focus is a lookup by that index.

const BADGE: Record<Exclude<GitStatus, "ignored" | null>, string> = { added: "A", changed: "M", removed: "D" };
const STATUS_TEXT: Record<Exclude<GitStatus, "ignored" | null>, string> = {
  added: "text-wrap",
  changed: "text-live",
  removed: "text-fail line-through",
};
const STATUS_DOT: Record<Exclude<GitStatus, "ignored" | null>, string> = {
  added: "bg-wrap",
  changed: "bg-live",
  removed: "bg-fail",
};

// Which dirs start expanded: those carrying changes (not ignored).
function initialExpanded(nodes: FileNode[], acc: Set<string> = new Set()): Set<string> {
  for (const n of nodes) {
    if (n.isDir && n.status && n.status !== "ignored") acc.add(n.path);
    if (n.children) initialExpanded(n.children, acc);
  }
  return acc;
}

/** Every path in `nodes`, plus which of them are `lazy` directories.
 *
 * Used to drop entries for paths that no longer exist from the expanded /
 * collapsed / reloaded sets. Those are keyed by path and live as long as the
 * mounted rail, so without pruning they accumulate every directory the user
 * ever opened or closed AND every path a build ever created and deleted, for
 * the life of the tab — and a deleted-then-recreated directory would come
 * back carrying whatever expansion state it had a session ago.
 *
 * A path under a still-present LAZY directory counts as present even though
 * it isn't in the walk: it's missing only because that directory's children
 * weren't sent (every live refresh resets those to placeholders), so pruning
 * it would silently collapse everything the user had open inside a lazily-
 * loaded directory each time the tree refreshed. */
function indexPaths(
  nodes: FileNode[],
  present: Set<string> = new Set(),
  lazyDirs: string[] = [],
): { present: Set<string>; lazyDirs: string[] } {
  for (const n of nodes) {
    present.add(n.path);
    if (n.isDir && n.lazy === true) lazyDirs.push(n.path);
    if (n.children) indexPaths(n.children, present, lazyDirs);
  }
  return { present, lazyDirs };
}

/** Filtered copy of `set`, returning `set` ITSELF when nothing was dropped so
 * a no-op prune doesn't hand React a new object (and re-render) on every
 * live refresh. */
function keepOnly(set: Set<string>, keep: (path: string) => boolean): Set<string> {
  let dropped = false;
  const next = new Set<string>();
  for (const p of set) {
    if (keep(p)) next.add(p);
    else dropped = true;
  }
  return dropped ? next : set;
}

// Prune to leaves matching `keep`. A dir survives if any descendant survives,
// or — when `keepDirOnOwnMatch` — the dir itself matches `keep`. The latter
// matters for BOTH filters: a text search surfaces an empty-but-named dir to
// browse into, and the changed-only filter surfaces a collapsed untracked
// directory (git reports it as one node with status "added" and NO children,
// so a children-only rule would wrongly hide all-new folders).
//
// `keepLazyDirs` keeps a `lazy` directory even when neither it nor (the
// nothing we have of) its contents matches. A lazy dir's children were never
// sent, so a text filter genuinely cannot know whether it contains a match —
// dropping it would present "no matches" as if the whole tree had been
// searched. Kept, it renders as an explicitly UNSEARCHED row the user can
// click to load and thereby include. Only the text filter passes this: the
// changed-only filter is asking a question a lazy dir's own status already
// answers (git marked it ignored or untracked), so there's nothing hidden.
function pruneTree(
  nodes: FileNode[],
  keep: (n: FileNode) => boolean,
  keepDirOnOwnMatch: boolean,
  keepLazyDirs = false,
): FileNode[] {
  const walk = (list: FileNode[]): FileNode[] => {
    const out: FileNode[] = [];
    for (const n of list) {
      if (n.isDir) {
        const kids = walk(n.children ?? []);
        if (kids.length || (keepDirOnOwnMatch && keep(n)) || (keepLazyDirs && n.lazy === true)) {
          out.push({ ...n, children: kids });
        }
      } else if (keep(n)) {
        out.push(n);
      }
    }
    return out;
  };
  return walk(nodes);
}

interface Row {
  node: FileNode;
  depth: number;
  isOpen: boolean;
  /** 1-based index among siblings, and the sibling count — `aria-posinset` /
   * `aria-setsize`, which a flat tree has to state explicitly since the DOM
   * no longer groups siblings. */
  posInSet: number;
  setSize: number;
}

function flattenVisible(nodes: FileNode[], open: (n: FileNode) => boolean, depth = 0, out: Row[] = []): Row[] {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const isOpen = n.isDir && open(n);
    out.push({ node: n, depth, isOpen, posInSet: i + 1, setSize: nodes.length });
    if (isOpen && n.children?.length) flattenVisible(n.children, open, depth + 1, out);
  }
  return out;
}

/** A directory the user can meaningfully expand: it has children, or it's a
 * `lazy` placeholder whose children exist but haven't been fetched. A dir
 * that's genuinely empty gets NO `aria-expanded`, so a screen reader
 * announces it as a leaf instead of "collapsed" — which would imply
 * there's something in there. */
function isExpandable(n: FileNode): boolean {
  return n.isDir && (n.lazy === true || (n.children?.length ?? 0) > 0);
}

export function FilesRail() {
  const { tree, loading, cwd, truncated } = useSessionFileTree();
  const { selectedId } = useSelectedSession();
  const { openFile, file, loadSubtree, loadingPaths } = useFilesUI();
  const { insertReference, canInsert } = useComposerInsert();
  const [filter, setFilter] = useState("");
  const [hideUnchanged, setHideUnchanged] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpanded(tree));
  // Directories the user closed BY HAND, which the auto-expand seed below
  // must not re-open. Without this, closing a directory that carries changes
  // lasted only until the next tree change — i.e. the next live refresh,
  // which during active agent work means it sprang back open continuously.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  // Lazy dirs already reloaded in place once for THIS tree generation — see
  // `openDir`, where it's what stops a failing reload from trapping a node open.
  const [reloaded, setReloaded] = useState<Set<string>>(() => new Set());
  // Roving tabindex: exactly one row is in the tab order, arrows move it.
  // (Making every row tabbable would put a whole workspace between the
  // filter input and whatever follows the rail.)
  const [activePath, setActivePath] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement | null>(null);

  // The tree arrives async (and again on session switch, and again on every
  // live-refresh SSE tick), so reconcile the per-path UI state whenever it
  // changes. React's "adjust state during render when a prop changes" pattern
  // (https://react.dev/reference/react/useState#storing-information-from-previous-renders):
  // runs on an actual (re)load only, not on filter typing (which leaves the
  // tree reference untouched).
  //
  // Expansion is CARRIED OVER, not recomputed: `loadSubtree` also produces a
  // new `tree` reference (splicing in a lazily-loaded directory's real
  // children), and recomputing would immediately re-collapse the very node
  // the user just clicked to expand (it's still `status: "ignored"` / not
  // itself "changed", so `initialExpanded` alone wouldn't include it). Same
  // for an unrelated live-refresh tick, which would otherwise spring every
  // manually-opened folder shut.
  const [prevTree, setPrevTree] = useState(tree);
  if (prevTree !== tree) {
    setPrevTree(tree);
    const { present, lazyDirs } = indexPaths(tree);
    // An empty tree is far more often "the fetch failed / the session went
    // away" than "every file was deleted" (the provider sets `[]` on error
    // too), so treat it as no information rather than pruning every path
    // there is — that would silently discard the user's expansion state on a
    // transient blip, with nothing left to restore it from.
    const stillExists = tree.length
      ? (p: string) => present.has(p) || lazyDirs.some((d) => p.startsWith(`${d}/`))
      : () => true;
    setExpanded((prev) => {
      const kept = keepOnly(prev, stillExists);
      const auto = [...initialExpanded(tree)].filter((p) => !collapsed.has(p) && !kept.has(p));
      return auto.length ? new Set([...kept, ...auto]) : kept;
    });
    setCollapsed((prev) => keepOnly(prev, stillExists));
    setReloaded((prev) => (prev.size ? new Set() : prev));
  }

  // When filtering (by name or to changed-only), force everything open so
  // matches deep in the tree are visible.
  const trimmedFilter = filter.trim();
  const forceOpen = trimmedFilter.length > 0 || hideUnchanged;
  const shown = useMemo(() => {
    let out = tree;
    if (trimmedFilter) {
      const lower = trimmedFilter.toLowerCase();
      out = pruneTree(out, (n) => n.name.toLowerCase().includes(lower), true, true);
    }
    if (hideUnchanged) {
      out = pruneTree(out, (n) => !!n.status && n.status !== "ignored", true);
    }
    return out;
  }, [tree, trimmedFilter, hideUnchanged]);

  const isOpen = useCallback((n: FileNode) => forceOpen || expanded.has(n.path), [forceOpen, expanded]);
  const rows = useMemo(() => flattenVisible(shown, isOpen), [shown, isOpen]);

  const toggle = (path: string) => {
    const wasOpen = expanded.has(path);
    setExpanded((prev) => {
      const next = new Set(prev);
      wasOpen ? next.delete(path) : next.add(path);
      return next;
    });
    // Mirror image, so the auto-expand seed above knows the difference
    // between "not opened yet" and "deliberately closed".
    setCollapsed((prev) => {
      if (wasOpen === prev.has(path)) return prev;
      const next = new Set(prev);
      wasOpen ? next.add(path) : next.delete(path);
      return next;
    });
  };

  // Expanding a `lazy` node kicks off the fetch that fills in its real
  // children — see FilesUIProvider's `loadSubtree`. Once loaded, the
  // response clears `lazy`, so collapse/re-expand is pure visibility with
  // no re-fetch.
  //
  // The already-open case is the one that isn't obvious: a live refresh
  // replaces the whole tree with the server's top-level walk, which always
  // represents a lazy directory as an unloaded placeholder — so a directory
  // the user had expanded can come back still-expanded but empty and lazy
  // again. Reload it IN PLACE then (don't toggle it shut), so recovering
  // takes the one click the user already made rather than a confusing
  // collapse-then-re-expand pair. Provider-side auto-refetching was the
  // alternative and it's far too expensive — see the tree effect there.
  //
  // ONE such in-place reload per tree generation, tracked in `reloaded`:
  // otherwise a directory whose load keeps failing (or keeps coming back
  // empty) can never be closed again, because every click on it reloads
  // instead of toggling. The second click collapses; expanding it later
  // retries the load, since that path goes through the not-open branch.
  const openDir = (n: FileNode) => {
    if (!n.isDir) return;
    const needsLoad = n.lazy === true && !loadingPaths.has(n.path);
    if (!needsLoad) return toggle(n.path);
    if (!expanded.has(n.path)) {
      loadSubtree(n.path);
      return toggle(n.path);
    }
    if (reloaded.has(n.path)) return toggle(n.path); // already tried; let it close
    setReloaded((prev) => new Set(prev).add(n.path));
    loadSubtree(n.path);
  };

  const activate = (n: FileNode) => {
    if (n.isDir) openDir(n);
    else if (selectedId) openFile({ sessionId: selectedId, path: n.path, name: n.name });
  };

  // Exactly one row carries tabIndex=0. Falls back to the first row whenever
  // the active one is gone (filtered out, collapsed away, deleted on disk),
  // so the tree never drops out of the tab order entirely.
  const tabbablePath = rows.some((r) => r.node.path === activePath) ? activePath : (rows[0]?.node.path ?? null);

  const focusRow = (index: number) => {
    const clamped = Math.max(0, Math.min(rows.length - 1, index));
    const row = rows[clamped];
    if (!row) return;
    setActivePath(row.node.path);
    // By index, not by path: paths contain quotes/brackets that would need
    // escaping in a selector, and the flat render guarantees index order.
    treeRef.current?.querySelector<HTMLElement>(`[data-row="${clamped}"]`)?.focus();
  };

  const parentOf = (index: number) => {
    const { depth } = rows[index];
    for (let j = index - 1; j >= 0; j--) if (rows[j].depth < depth) return j;
    return index;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Only when a row itself has focus. Keys pressed on the insert-reference
    // button inside a row bubble up here too, and Enter must activate that
    // button alone rather than also opening/previewing the row.
    if (!(e.target instanceof HTMLElement) || !e.target.hasAttribute("data-row")) return;
    const i = rows.findIndex((r) => r.node.path === activePath);
    const row = i >= 0 ? rows[i] : undefined;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        focusRow(i + 1); // i === -1 → first row
        break;
      case "ArrowUp":
        e.preventDefault();
        focusRow(i < 0 ? 0 : i - 1);
        break;
      case "Home":
        e.preventDefault();
        focusRow(0);
        break;
      case "End":
        e.preventDefault();
        focusRow(rows.length - 1);
        break;
      case "ArrowRight":
        if (!row?.node.isDir) return;
        e.preventDefault();
        if (row.isOpen) focusRow(i + 1);
        else openDir(row.node);
        break;
      case "ArrowLeft":
        if (!row) return;
        e.preventDefault();
        // `forceOpen` means a filter is holding everything open, so
        // collapsing would do nothing visible — move to the parent instead.
        if (row.node.isDir && row.isOpen && !forceOpen) toggle(row.node.path);
        else focusRow(parentOf(i));
        break;
      case "Enter":
      case " ":
        if (!row) return;
        e.preventDefault();
        activate(row.node);
        break;
      default:
        return;
    }
  };

  // Leaf dir name only — cwd is a sandbox-internal session workdir path
  // (SESSIONS_ROOT/<sessionId>/...) that's meaningless to show in full.
  const cwdLabel = cwd ? cwdBasename(cwd) : "workspace";

  const renderRow = ({ node: n, depth, isOpen: open, posInSet, setSize }: Row, index: number) => {
    const ignored = n.status === "ignored";
    const badge = !ignored && n.status && n.status !== "ignored" ? BADGE[n.status] : null;
    const selected = !n.isDir && file?.path === n.path;
    // Still `lazy` even though open means the fetch that fills in its real
    // children hasn't landed (or hasn't been kicked off) yet — covers both
    // "currently loading" and a first render of `forceOpen` (filter/hide-
    // unchanged) skipping `openDir`'s click-triggered fetch entirely.
    const isLoadingDir = open && n.isDir && n.lazy === true && loadingPaths.has(n.path);
    // A filter is running but this directory's contents were never fetched,
    // so the filter has provably not been applied inside it. Said out loud
    // (rather than rendering it as an empty match-less folder) because the
    // fix — click to load, and the filter then covers it — is otherwise
    // impossible to guess.
    const unsearched = !!trimmedFilter && n.isDir && n.lazy === true && !isLoadingDir;
    const isActive = n.path === tabbablePath;
    const title = unsearched
      ? `${n.path} — not searched; click to load, then the filter includes it`
      : n.lazy
        ? `${n.path} (click to load)`
        : n.path;
    return (
      <div
        key={n.path}
        data-row={index}
        role="treeitem"
        aria-level={depth + 1}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-expanded={isExpandable(n) ? open : undefined}
        aria-selected={selected || undefined}
        aria-busy={isLoadingDir || undefined}
        tabIndex={isActive ? 0 : -1}
        onFocus={() => setActivePath(n.path)}
        className={cn(
          "group flex items-center gap-1.5 pr-2 py-1 rounded-md cursor-pointer text-[12.5px]",
          "hover:bg-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
          selected && "bg-sdk/[0.16] text-ink",
          ignored ? "opacity-45" : "text-ink-soft",
        )}
        style={{ paddingLeft: depth * 12 + 6 }}
        onClick={() => activate(n)}
        title={title}
      >
        {isLoadingDir ? (
          <Loader2 className="w-3.5 h-3.5 shrink-0 text-ink-faint animate-spin" />
        ) : (
          <ChevronRight
            className={cn(
              "w-3.5 h-3.5 shrink-0 text-ink-faint transition-transform",
              n.isDir ? (open ? "rotate-90" : "") : "invisible",
            )}
          />
        )}
        {n.isDir ? (
          <Folder className="w-3.5 h-3.5 shrink-0 text-live" />
        ) : (
          <FileIcon className="w-3.5 h-3.5 shrink-0 text-ink-mute" />
        )}
        <span
          className={cn(
            "flex-1 min-w-0 truncate",
            ignored && "italic",
            !ignored && n.status && n.status !== "ignored" && !n.isDir && STATUS_TEXT[n.status],
          )}
        >
          {n.name}
        </span>
        {unsearched && <span className="text-[10px] text-ink-faint shrink-0 whitespace-nowrap">not searched</span>}
        {/* right cluster: hover "+" then the status marker. The insert
            affordance is hidden for spectate-only peers (view-only). Only
            the active row's button is tabbable, so Tab doesn't walk every
            file in the workspace; it reveals itself on focus as well as
            hover so keyboard users can see what they're on. */}
        {canInsert && !ignored && !n.isDir && (
          <button
            type="button"
            tabIndex={isActive ? 0 : -1}
            className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-sdk hover:bg-sdk/[0.18] rounded p-0.5 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            title="Insert as @reference"
            aria-label={`Insert ${n.name} as a reference`}
            onClick={(e) => {
              e.stopPropagation();
              insertReference(`@${n.path}`);
            }}
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
        {badge && (
          <span className={cn("font-mono text-[10px] font-bold w-3 text-center shrink-0", STATUS_TEXT[n.status as "added" | "changed" | "removed"])}>
            {badge}
          </span>
        )}
        {n.isDir && !ignored && n.status && n.status !== "ignored" && (
          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[n.status])} />
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* breadcrumb + filter + legend */}
      <div className="shrink-0 px-2.5 py-2 border-b border-divider flex flex-col gap-2">
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-ink-mute">
          <Folder className="w-3.5 h-3.5 text-ink-faint" />
          <span className="text-ink-soft truncate" title={cwd ?? undefined}>~/{cwdLabel}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-ink-faint" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter files…"
              aria-label="Filter files by name"
              className="field w-full !pl-7 text-[12px] py-1.5"
            />
          </div>
          <button
            type="button"
            className={cn("icon-btn w-7 h-7 shrink-0", hideUnchanged && "text-sdk bg-sdk/[0.16] hover:bg-sdk/[0.16]")}
            title={hideUnchanged ? "Showing changed files only" : "Show changed files only"}
            aria-pressed={hideUnchanged}
            onClick={() => setHideUnchanged((v) => !v)}
          >
            <Filter className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-3 flex-wrap text-[10px] text-ink-faint">
          <span className="inline-flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-wrap inline-block" />added</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-live inline-block" />changed</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-fail inline-block" />removed</span>
          <span className="inline-flex items-center gap-1.5"><i className="w-1.5 h-1.5 rounded-full bg-ink-hush inline-block" />ignored</span>
        </div>
      </div>
      {/* tree */}
      <div className="flex-1 min-h-0 overflow-y-auto p-1.5">
        {loading && !tree.length ? (
          <p className="px-2 py-3 text-[12px] text-ink-faint">Loading files…</p>
        ) : rows.length ? (
          <div ref={treeRef} role="tree" aria-label="Workspace files" onKeyDown={onKeyDown}>
            {rows.map(renderRow)}
          </div>
        ) : (
          <p className="px-2 py-3 text-[12px] text-ink-faint">
            {hideUnchanged && tree.length ? "No changed files." : "No files."}
          </p>
        )}
        {truncated && (
          <p className="px-2 py-2 mt-1 text-[10.5px] text-ink-faint border-t border-divider">
            Large workspace — some directories have more files than shown here.
          </p>
        )}
      </div>
    </div>
  );
}
