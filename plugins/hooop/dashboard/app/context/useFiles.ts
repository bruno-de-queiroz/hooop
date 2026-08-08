"use client";
import { useEffect, useRef, useState } from "react";
import type { FileEntry } from "@/lib/sandbox-client";
import { useSelectedCwd } from "./useSelectedCwd";
import type { AutocompleteEntry } from "./CommandsProvider";

const DEBOUNCE_MS = 120;
const LIMIT = 20;

function toEntry(f: FileEntry): AutocompleteEntry {
  return {
    insert: `@${f.name}`,
    label: f.name,
    description: f.isDir ? "directory" : null,
    kind: f.isDir ? "dir" : "file",
    source: null,
  };
}

function keyOf(cwd: string, query: string): string {
  return `${cwd}^@${query}`;
}

/**
 * Debounced `/api/files` lookup for the `@file` autocomplete. `query` is
 * the text after "@" (no leading "@"); pass null to close (no fetch, no
 * entries) — e.g. while the composer's `@` token isn't active.
 *
 * Scoped to the selected session's cwd via `useSelectedCwd`, same as
 * `CommandsProvider`, so both autocomplete sources always agree on which
 * project they're browsing.
 */
export function useFiles(query: string | null): { entries: AutocompleteEntry[]; loading: boolean } {
  const cwd = useSelectedCwd();
  const [entries, setEntries] = useState<AutocompleteEntry[]>([]);
  // The (cwd, query) key of the most recently *resolved* fetch. Comparing
  // it against the key we currently want derives `loading` without a
  // synchronous setState at the top of the effect.
  const [resolvedKey, setResolvedKey] = useState<string | null>(null);

  // Monotonic request id: a slow in-flight fetch for a stale query must
  // not overwrite the results of a newer one that resolved first.
  const reqSeq = useRef(0);

  const closed = query === null || !cwd;
  const wantedKey = query !== null && cwd ? keyOf(cwd, query) : null;

  useEffect(() => {
    // Checked directly (rather than via `closed`/`wantedKey`) so TS
    // narrows `cwd`/`query` to non-null for the closure below.
    if (query === null || !cwd) return;

    const seq = ++reqSeq.current;
    const doneKey = keyOf(cwd, query);
    const timer = setTimeout(async () => {
      try {
        const qs = new URLSearchParams({ cwd, limit: String(LIMIT) });
        if (query) qs.set("q", query);
        const res = await fetch(`/api/files?${qs.toString()}`);
        const body = res.ok ? ((await res.json()) as { entries: FileEntry[] }) : { entries: [] };
        if (seq !== reqSeq.current) return; // superseded by a newer query
        setEntries(body.entries.map(toEntry));
      } finally {
        if (seq === reqSeq.current) setResolvedKey(doneKey);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [cwd, query]);

  if (closed) return { entries: [], loading: false };
  return { entries, loading: resolvedKey !== wantedKey };
}
