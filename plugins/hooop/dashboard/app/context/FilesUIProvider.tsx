"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSelectedSession } from "./SelectedSessionProvider";
import { useSessions } from "./SessionsProvider";
import { useSelectedCwd } from "./useSelectedCwd";
import { useSSE } from "@/app/components/useSSE";
import type { FileNode } from "@/app/components/shell/files/types";

// Shell state for the filesystem navigator:
//
//  · view — which right-rail section is showing, "details" (summary + skills +
//    sub-agents) or "files" (the navigator). PERSISTS across session switches:
//    switching sessions only re-scopes the tree, it never closes the drawer.
//  · file — the file open in the docked preview, tagged with the session it
//    belongs to. Derived visibility is session-scoped: switching to a session
//    the file doesn't belong to hides it (auto-close), computed synchronously so
//    the dock doesn't flicker (same trick as the plan dock's openPlan).
//  · mobile — on phones the right rail is hidden; Details/Files open as a
//    full-screen overlay from the session-header ⋯ menu.

// The right rail's sections. "browser" is the live preview: a SIBLING of Details
// and Files rather than a docked column, because it competes with them for the
// same rail — you look at the app, or the tree, or the summary. Making it a dock
// forced it to fight the file preview for a slot and to evict things to be seen.
export type RailView = "details" | "files" | "browser";
export interface OpenFile {
  sessionId: string;
  path: string; // path relative to the session cwd, e.g. "src/hello.py"
  name: string; // basename, e.g. "hello.py"
}

interface FilesUIValue {
  view: RailView;
  setView: (v: RailView) => void;

  /** Desktop right rail: collapsed to the mini icon strip, or expanded onto
   * `view`. Lives here (not local to DesktopShell) so any consumer — e.g. the
   * "files to review" pill — can expand it, not just the rail's own controls. */
  railCollapsed: boolean;
  setRailCollapsed: (v: boolean) => void;

  /** The preview file for the currently-selected session, or null. */
  file: OpenFile | null;
  openFile: (f: OpenFile) => void;
  closeFile: () => void;

  /** Mobile full-screen overlay target (null = closed). */
  mobileView: RailView | null;
  openMobile: (v: RailView) => void;
  closeMobile: () => void;

  /** Bumps on every manual refresh, or on a live `files` SSE event for the
   * selected session's cwd; the file tree + preview hooks key their refetch
   * off it. */
  filesNonce: number;
  refreshFiles: () => void;

  /** The selected session's file tree, fetched once here and shared by the
   * navigator (`useSessionFileTree`) and the "files to review" pill so an
   * always-mounted pill doesn't double the fetch rate. */
  tree: FileNode[];
  treeLoading: boolean;
  treeTruncated: boolean;

  /** Fetch and splice in the real contents of a `lazy: true` node (see
   * types.ts) — e.g. the first time the navigator expands `node_modules`.
   * Silently a no-op if `path` isn't in the current tree (a stale click
   * racing a tree refresh) or the request fails; the node just stays lazy,
   * so the same click that would expand it will retry.
   *
   * Callable repeatedly for the same path: any live refresh re-fetches the
   * top-level tree, which resets every lazy node to an unloaded
   * placeholder, so a previously-loaded directory legitimately needs
   * loading again (FilesRail's `openDir` does that on click). Concurrent
   * calls for one path are deduped.
   *
   * Also a no-op once the accumulated tree reaches TREE_MAX_CLIENT_NODES —
   * it sets `treeTruncated` instead, leaving the node lazy. */
  loadSubtree: (path: string) => void;
  /** Paths currently mid-fetch via `loadSubtree`, for a per-node spinner. */
  loadingPaths: Set<string>;
}

const Ctx = createContext<FilesUIValue | null>(null);

// Ceiling on the WHOLE client-side tree, across the top-level walk plus every
// lazy directory expanded since. The sandbox's node cap is per RESPONSE
// (20k), which bounds any single fetch but not their sum: expanding ten
// heavy directories in one sitting would otherwise put ten full budgets in
// React state at once (measured ~1.66 MiB of JSON per real node_modules).
// Three times the server's per-response cap, so the `max` this sends only
// starts to bind past 40k nodes (60k − one full response) — i.e. the initial
// walk plus roughly two full-size expansions come back untouched, and only
// beyond that do subtrees get trimmed and, at the ceiling, refused.
const TREE_MAX_CLIENT_NODES = 60000;

function countNodes(nodes: FileNode[]): number {
  let n = 0;
  for (const node of nodes) {
    n++;
    if (node.children) n += countNodes(node.children);
  }
  return n;
}

/** Immutable splice of a freshly-loaded subtree into the node at `targetPath`
 * — returns a NEW array (new node objects on the path down to the target,
 * everything else untouched by reference) so React/FilesRail's
 * tree-reference-changed detection still works. Clears `lazy` on the target
 * so a second expand doesn't re-fetch. A `targetPath` no longer present
 * (pruned by a full-tree refresh that raced this fetch) is silently a
 * no-op — nothing to splice into. */
function spliceLoadedChildren(nodes: FileNode[], targetPath: string, children: FileNode[]): FileNode[] {
  let changed = false;
  const next = nodes.map((n) => {
    if (n.path === targetPath) {
      changed = true;
      return { ...n, children, lazy: false };
    }
    if (n.children) {
      const kids = spliceLoadedChildren(n.children, targetPath, children);
      if (kids !== n.children) {
        changed = true;
        return { ...n, children: kids };
      }
    }
    return n;
  });
  return changed ? next : nodes;
}

export function FilesUIProvider({ children }: { children: React.ReactNode }) {
  const { selectedId } = useSelectedSession();
  const { sessions } = useSessions();
  const cwd = useSelectedCwd();
  const [view, setView] = useState<RailView>("details");
  // Defaults collapsed to the mini strip (mockup), keeping the chat pane as
  // wide as possible; expanding animates the width open.
  const [railCollapsed, setRailCollapsed] = useState(true);
  const [rawFile, setRawFile] = useState<OpenFile | null>(null);
  const [mobileView, setMobileView] = useState<RailView | null>(null);
  const [filesNonce, setFilesNonce] = useState(0);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeTruncated, setTreeTruncated] = useState(false);
  // The cwd the current `tree` state was actually fetched for. A session
  // switch changes `cwd` before the new fetch resolves, and the old `tree`
  // otherwise lingers in state across that gap — fine for a browsed-and-
  // already-visible FilesRail (a one-frame flicker), but the always-mounted
  // review pill could hand a stale `first.path` to `openFile` paired with the
  // NEW `selectedId`, opening a file that isn't even the new session's.
  const [treeCwd, setTreeCwd] = useState<string | null>(null);

  // Does `sid` denote the session on screen (directly or via an alias)?
  const matches = useCallback(
    (sid: string) => {
      if (!selectedId) return false;
      if (sid === selectedId) return true;
      const s = sessions.find((x) => x.sessionId === sid);
      return (s?.aliases ?? []).includes(selectedId);
    },
    [selectedId, sessions],
  );

  // Session-scoped, derived (no effect): a preview opened in another session
  // simply stops rendering once you switch away — no explicit close needed.
  const file = useMemo(() => (rawFile && matches(rawFile.sessionId) ? rawFile : null), [rawFile, matches]);

  const openFile = useCallback((f: OpenFile) => setRawFile(f), []);
  const closeFile = useCallback(() => setRawFile(null), []);
  const openMobile = useCallback((v: RailView) => setMobileView(v), []);
  const closeMobile = useCallback(() => setMobileView(null), []);
  const refreshFiles = useCallback(() => setFilesNonce((n) => n + 1), []);

  const [loadingPaths, setLoadingPaths] = useState<Set<string>>(new Set());
  // Always holds the LATEST cwd (unlike a value captured in loadSubtree's
  // own closure, which is frozen at call time) — lets an in-flight fetch
  // detect a session switch that happened while it was awaiting the
  // network, so it doesn't splice a stale cwd's subtree into a coincidentally
  // same-named path in the new cwd's tree.
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  // Same reason as cwdRef: `loadSubtree` needs the CURRENT tree to size its
  // remaining node budget, but reading `tree` from its closure would rebuild
  // it (and re-render every consumer) on every splice.
  const treeRef = useRef(tree);
  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  // In-flight dedupe, deliberately NOT the `loadingPaths` state below:
  // that state exists purely to drive the spinner and changes on every
  // load's start AND finish, so reading it here would give `loadSubtree` a
  // new identity that often. Keeping the identity stable (it changes only
  // with `cwd`) keeps this out of the context `value` memo's churn, so an
  // expand doesn't re-render every `useFilesUI` consumer twice.
  const inFlightRef = useRef<Set<string>>(new Set());

  const loadSubtree = useCallback(
    (path: string) => {
      if (!cwd) return;
      // Collapsing and re-expanding a still-loading node before it lands
      // (`n.lazy` stays true until the response arrives) would otherwise
      // fire a second, redundant fetch for the same path.
      if (inFlightRef.current.has(path)) return;
      // Ask only for the room left in the accumulated tree (see
      // TREE_MAX_CLIENT_NODES). At zero, decline rather than fetch: the
      // response would be an empty tree anyway, and this way the node stays
      // `lazy` (so nothing is silently presented as an empty directory) and
      // the truncation notice explains why the click did nothing.
      const budget = TREE_MAX_CLIENT_NODES - countNodes(treeRef.current);
      if (budget <= 0) {
        setTreeTruncated(true);
        return;
      }
      inFlightRef.current.add(path);
      const forCwd = cwd;
      setLoadingPaths((prev) => new Set(prev).add(path));
      fetch(`/api/files/tree?cwd=${encodeURIComponent(forCwd)}&path=${encodeURIComponent(path)}&max=${budget}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`subtree ${r.status}`))))
        .then((data: { tree?: FileNode[]; truncated?: boolean }) => {
          if (forCwd !== cwdRef.current) return; // session switched mid-fetch
          setTree((prevTree) => spliceLoadedChildren(prevTree, path, data.tree ?? []));
          if (data.truncated) setTreeTruncated(true);
        })
        .catch(() => { /* best-effort — node stays lazy, user can retry */ })
        .finally(() => {
          inFlightRef.current.delete(path);
          setLoadingPaths((prev) => {
            if (!prev.has(path)) return prev;
            const next = new Set(prev);
            next.delete(path);
            return next;
          });
        });
    },
    [cwd],
  );

  useEffect(() => {
    if (!cwd) {
      setTree([]);
      setTreeTruncated(false);
      setTreeLoading(false);
      setTreeCwd(null);
      return;
    }
    const ctrl = new AbortController();
    setTreeLoading(true);
    fetch(`/api/files/tree?cwd=${encodeURIComponent(cwd)}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`tree ${r.status}`))))
      .then((data: { tree?: FileNode[]; truncated?: boolean }) => {
        // Wholesale replace — which DOES reset any lazy directory the user
        // had expanded back to an unloaded placeholder, since this
        // top-level walk never carries a lazy dir's children (that's the
        // whole point of `lazy`). Deliberately NOT auto-re-fetching those
        // here: measured against a real node_modules (490 packages, 30k
        // files), one such subtree costs ~1.66 MiB / 17.4k nodes / ~100ms
        // of server-side walk, and this effect re-runs on every live
        // refresh — in practice about once per save, since the sandbox's
        // `files` emit is a trailing 300ms debounce that coalesces a burst
        // into one event (measured: 3s of writes at 100ms intervals
        // produced exactly ONE event, at the end). Paying that repeatedly
        // for the one part of the tree that is by definition NOT watched
        // for changes is the wrong trade. FilesRail's `openDir` instead
        // reloads a blanked-out directory in place on a single click.
        setTree(data.tree ?? []);
        setTreeTruncated(!!data.truncated);
        setTreeCwd(cwd);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") return;
        setTree([]);
        setTreeTruncated(false);
        setTreeCwd(cwd); // an error result is still "current" (empty), not stale
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setTreeLoading(false);
      });
    return () => ctrl.abort();
  }, [cwd, filesNonce]);

  // Gate on the fetch actually matching the CURRENTLY selected cwd — closes
  // the window (a session switch changing `cwd` before its new fetch
  // resolves) where a consumer could otherwise read the previous session's
  // tree paired with the new session's id.
  const treeIsCurrent = treeCwd === cwd;
  const safeTree = useMemo(() => (treeIsCurrent ? tree : []), [treeIsCurrent, tree]);
  const safeTreeTruncated = treeIsCurrent && treeTruncated;

  // Live refresh: the sandbox's per-cwd fs.watch fires a `files` event
  // (`{sessionId, cwd}`) whenever the selected session's working directory
  // changes on disk, so the navigator updates without a manual click.
  // `resync` (foreground/reconnect backfill — see useSSE.ts) also triggers a
  // refetch since a missed live event would otherwise leave a stale "files to
  // review" count until the next unrelated refresh.
  useSSE({
    files: (data) => {
      const sid = (data as { sessionId?: string } | null)?.sessionId;
      if (sid && matches(sid)) refreshFiles();
    },
    resync: () => refreshFiles(),
  });

  const value = useMemo<FilesUIValue>(
    () => ({
      view, setView, railCollapsed, setRailCollapsed, file, openFile, closeFile, mobileView, openMobile, closeMobile,
      filesNonce, refreshFiles, tree: safeTree, treeLoading, treeTruncated: safeTreeTruncated,
      loadSubtree, loadingPaths,
    }),
    [
      view, railCollapsed, file, openFile, closeFile, mobileView, openMobile, closeMobile, filesNonce, refreshFiles,
      safeTree, treeLoading, safeTreeTruncated, loadSubtree, loadingPaths,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFilesUI(): FilesUIValue {
  const c = useContext(Ctx);
  if (!c) throw new Error("useFilesUI must be used within FilesUIProvider");
  return c;
}
