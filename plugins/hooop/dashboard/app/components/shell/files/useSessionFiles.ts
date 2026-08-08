"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSelectedCwd } from "@/app/context/useSelectedCwd";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import type { FileNode, FilePreviewData } from "./types";

// Data hooks for the Files navigator, scoped to the selected session's cwd.
// The tree itself is fetched once in FilesUIProvider (shared by the
// navigator and the "files to review" pill); useFilePreview still fetches
// independently per opened file.

export interface FileTreeState {
  tree: FileNode[];
  loading: boolean;
  cwd: string | null;
  /** Tree hit the sandbox node cap and is a partial (alphabetical head) view. */
  truncated: boolean;
}

export function useSessionFileTree(): FileTreeState {
  const cwd = useSelectedCwd();
  const { tree, treeLoading, treeTruncated } = useFilesUI();
  return { tree, loading: treeLoading, cwd, truncated: treeTruncated };
}

/** Flatten to leaves only, in the tree's existing traversal order (dirs-first,
 * alphabetical — see sandbox/lib/git.ts's `sortNodes`). */
function flattenLeaves(nodes: FileNode[], acc: FileNode[] = []): FileNode[] {
  for (const n of nodes) {
    if (n.isDir) {
      if (n.children) flattenLeaves(n.children, acc);
    } else {
      acc.push(n);
    }
  }
  return acc;
}

/** Leaves with an "added", "changed", or "removed" git status, in traversal
 * order — the affected-files queue. Shared by useAffectedFiles (count +
 * first) and useAdjacentFiles (prev/next within this same queue), so there's
 * one filter, not two. */
function affectedLeaves(tree: FileNode[]): FileNode[] {
  return flattenLeaves(tree).filter((n) => n.status === "added" || n.status === "changed" || n.status === "removed");
}

export interface AffectedFiles {
  count: number;
  first: { path: string; name: string } | null;
}

/** `first` is a stable, cheap-to-compute pick with no extra ordering data
 * (e.g. mtime) needed, since `affectedLeaves` traversal order is already
 * deterministic. */
export function useAffectedFiles(): AffectedFiles {
  const { tree } = useFilesUI();
  return useMemo(() => {
    const affected = affectedLeaves(tree);
    return { count: affected.length, first: affected[0] ? { path: affected[0].path, name: affected[0].name } : null };
  }, [tree]);
}

export interface AdjacentFiles {
  prev: { path: string; name: string } | null;
  next: { path: string; name: string } | null;
}

/** The file immediately before/after `path` within the affected-files queue
 * (added/changed/removed, traversal order) — NOT the full tree. Paging
 * through the "files affected" pill's queue is the point; a file outside
 * that queue (opened by clicking an unaffected file directly in the tree)
 * has no defined position in it, so both neighbors come back null rather
 * than falling back to some other ordering. */
export function useAdjacentFiles(path: string | null): AdjacentFiles {
  const { tree } = useFilesUI();
  return useMemo(() => {
    if (!path) return { prev: null, next: null };
    const queue = affectedLeaves(tree);
    const i = queue.findIndex((n) => n.path === path);
    if (i === -1) return { prev: null, next: null };
    const prev = i > 0 ? queue[i - 1] : null;
    const next = i < queue.length - 1 ? queue[i + 1] : null;
    return {
      prev: prev ? { path: prev.path, name: prev.name } : null,
      next: next ? { path: next.path, name: next.name } : null,
    };
  }, [tree, path]);
}

export interface FilePreviewState {
  data: FilePreviewData | null;
  loading: boolean;
  error: string | null;
}

/**
 * Same file, same bytes? Then a revalidation has nothing to show and must not
 * touch state — see useFilePreview.
 *
 * Every field of FilePreviewData is a scalar except `diff`, so the scalars are
 * compared by enumeration rather than by a hand-written list: a field added to
 * the type later is then compared automatically instead of being silently
 * treated as "unchanged" by a list nobody remembered to extend. `diff` is a
 * parsed object tree and is pulled out to be compared structurally.
 */
function samePreview(a: FilePreviewData | null, b: FilePreviewData): boolean {
  if (!a) return false;
  const { diff: aDiff, ...aRest } = a;
  const { diff: bDiff, ...bRest } = b;
  const scalars = new Set([...Object.keys(aRest), ...Object.keys(bRest)]);
  for (const k of scalars) {
    if ((aRest as Record<string, unknown>)[k] !== (bRest as Record<string, unknown>)[k]) return false;
  }
  // Reached only when the bytes and every flag already match, so this runs on
  // the common no-op path — and is trivial there, since an unchanged file's diff
  // is null on both sides. It still has to be compared: for byte-identical
  // content the working-tree diff can move on its own (the INDEX changed —
  // `git add` with no edit), which is a real change to render.
  return JSON.stringify(aDiff) === JSON.stringify(bDiff);
}

/**
 * Preview for `path`, revalidated whenever the session's cwd changes on disk.
 *
 * That revalidation is deliberately invisible. The fs-change event carries only
 * `{sessionId, cwd}` (see sandbox/lib/file-watch.ts) — never a path list — so
 * ANY write anywhere under the cwd bumps `filesNonce` and re-fetches this file,
 * which for an open preview is overwhelmingly a write to some OTHER file. So:
 *
 *   - a refetch of the SAME file keeps the rendered preview mounted rather than
 *     blanking to `data: null` + `loading`. Blanking unmounted the body, and the
 *     scroll container went with it, so every unrelated write threw the reader
 *     back to the top of the file.
 *   - an identical payload returns the previous state object unchanged, so React
 *     bails out and nothing re-renders at all. This is the common case.
 *
 * Only a genuinely different file (cwd or path) clears the pane.
 */
export function useFilePreview(path: string | null): FilePreviewState {
  const cwd = useSelectedCwd();
  const { filesNonce } = useFilesUI();
  const [state, setState] = useState<FilePreviewState>({ data: null, loading: false, error: null });
  // Identity of the file `state` currently describes, so this effect can tell a
  // revalidation from a switch to another file. A ref, not state: it must be
  // readable and writable within one effect run without scheduling a render.
  const shownRef = useRef<string | null>(null);

  useEffect(() => {
    if (!cwd || !path) {
      shownRef.current = null;
      setState({ data: null, loading: false, error: null });
      return;
    }
    const key = `${cwd}\n${path}`;
    const revalidating = shownRef.current === key;
    shownRef.current = key;
    const ctrl = new AbortController();
    // A revalidation deliberately sets NOTHING here — not even `loading` — so
    // the pane holds still. Two extra renders per fs event would otherwise
    // reconcile every line row of a large file twice for no visible change.
    if (!revalidating) setState({ data: null, loading: true, error: null });
    fetch(
      `/api/files/preview?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(path)}`,
      { signal: ctrl.signal },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`preview ${r.status}`))))
      .then((data: FilePreviewData) =>
        setState((prev) => (samePreview(prev.data, data) ? prev : { data, loading: false, error: null })),
      )
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") return;
        const message = (e as Error)?.message ?? "failed to load";
        // A failed REVALIDATION keeps what's on screen: the file is most likely
        // mid-write (the preview endpoint 200s with `content: null` for a
        // vanished file, so this is a transient fault, not a deletion), and the
        // next fs event retries anyway. Replacing a readable preview with an
        // error banner over that would be strictly worse. With nothing to fall
        // back on, the error is the only thing to show — and an unchanged error
        // is itself a no-op, so a pane that is already reporting this failure
        // doesn't re-render once per write for as long as it keeps failing.
        setState((prev) =>
          prev.data || prev.error === message ? prev : { data: null, loading: false, error: message },
        );
      });
    return () => ctrl.abort();
  }, [cwd, path, filesNonce]);

  return state;
}
