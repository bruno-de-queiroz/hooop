"use client";
import { useEffect, useRef, useState } from "react";
import { useSelectedSession } from "./SelectedSessionProvider";
import type { PresenceParticipant } from "./hooks/usePresence";
import type { AutocompleteEntry } from "./CommandsProvider";

const DEBOUNCE_MS = 120;

/**
 * Roster lookup for the composer's `@peer` autocomplete. `query` is the text
 * after "@" (no leading "@"); pass null to close — no fetch, no entries.
 *
 * Deliberately a FETCH rather than a presence SSE subscription, mirroring
 * useFiles. Subscribing here would re-render ShellComposer on every heartbeat
 * (~10s per participant), which is precisely what its memo exists to prevent —
 * see the note on that component. Fetching on open means the composer only
 * re-renders while the popover is actually up, and the roster is at most a
 * dropdown-open old, which is fresh enough to pick a name from.
 *
 * Uses the read-only GET on /api/presence, never the heartbeat POST: opening a
 * dropdown must not assert that the viewer is present (that would suppress
 * their own notifications).
 */
export function usePeers(query: string | null): { entries: AutocompleteEntry[] } {
  const { selectedId } = useSelectedSession();
  const [entries, setEntries] = useState<AutocompleteEntry[]>([]);

  // Monotonic request id: a slow in-flight fetch for a stale query must not
  // overwrite the results of a newer one that resolved first.
  const reqSeq = useRef(0);

  useEffect(() => {
    if (query === null || !selectedId) return;

    const seq = ++reqSeq.current;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/presence?sessionId=${encodeURIComponent(selectedId)}`);
        const body = res.ok
          ? ((await res.json()) as { participants?: PresenceParticipant[]; me?: string })
          : {};
        if (seq !== reqSeq.current) return; // superseded by a newer query
        setEntries(toEntries(body.participants ?? [], body.me ?? null, query));
      } catch {
        if (seq === reqSeq.current) setEntries([]);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [selectedId, query]);

  if (query === null || !selectedId) return { entries: [] };
  return { entries };
}

/**
 * Roster → autocomplete rows. Pure so the filtering rules are testable without
 * a fetch.
 *
 * Matches on the handle AND the display name, so someone reading "Bruno de
 * Queiroz" on an avatar can type `@bruno` or `@queiroz` and still find them —
 * the handle is a typing convenience, not a name people are expected to learn.
 */
export function toEntries(
  participants: readonly PresenceParticipant[],
  me: string | null,
  query: string,
): AutocompleteEntry[] {
  const q = query.toLowerCase();
  return participants
    // No self-mentions: you are never the person being called over.
    .filter((p) => p.participantId !== me)
    // A participant from an older frame has no handle and cannot be mentioned;
    // showing it would insert an empty "@" that resolves to nobody.
    .filter((p): p is PresenceParticipant & { handle: string } => !!p.handle)
    .filter((p) => p.handle.includes(q) || p.name.toLowerCase().includes(q))
    .map((p) => ({
      insert: `@${p.handle}`,
      label: p.name,
      description: p.kind === "host" ? "host" : p.away ? "away" : "peer",
      kind: "peer" as const,
      source: null,
    }));
}
