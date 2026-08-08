"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSSE } from "@/app/components/useSSE";
import type { EventRow } from "@/lib/sandbox-client";
import { userPromptText } from "@/app/components/active-session/eventText";

const INITIAL_LIMIT = 500;
const PAGE_LIMIT = 200;
// Two-tier dedupe window. Optimistic→real has the wider window because
// slow CI / sandbox under load can take well over 5s between the
// client's send and the hook's ingest. Real→real has the tighter
// window because the only legitimate "two real rows for the same
// prompt" case is the user typing the same text twice on purpose —
// collapsing those would silently swallow a legitimate send. 5s catches
// claude's --resume-cycle double-fire without eating intentional repeats.
const OPTIMISTIC_DEDUPE_WINDOW_MS = 30_000;
const REAL_DUPLICATE_WINDOW_MS = 5_000;
// Server-side `deriveText` caps each field at 2000 chars (`.slice(0, 2000)`
// in sandbox/lib/ingestor.ts deriveText). Optimistic rows carry the
// full prompt; the real frame's `prompt=` is truncated. Compare on the
// leading slice so long pasted prompts still reconcile. Coupled to the
// sandbox constant — if that cap moves, update this in lockstep.
const PROMPT_COMPARE_PREFIX = 2000;

export interface OptimisticUserRow extends EventRow {
  __optimistic: true;
}

/** Layout-seed attributes for an optimistic row. Mirror what the sandbox will
 * stamp on the real frame so the optimistic twin renders identically and the
 * later reconcile is invisible: `kind` picks the renderer (a command card vs an
 * ordinary bubble) and `author` drives the viewer-relative colour (a peer's own
 * turn is green, not blue). */
export interface OptimisticMeta {
  kind?: string | null;
  author?: string | null;
}

export interface UseTranscript {
  events: EventRow[];
  loading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  /** Append a synthetic UserPromptSubmit row immediately on send; returns its
   * (negative) id so a failed send can roll it back. `meta` seeds the row's
   * final layout attributes (kind → command card vs chat bubble; author →
   * viewer-relative colour) so it renders in its final form immediately rather
   * than flashing the default styling before the real frame reconciles. */
  pushOptimistic: (text: string, meta?: OptimisticMeta) => number;
  /** Remove an optimistic row by id — used when the send is rejected so a
   * message that never reached the model doesn't linger in the transcript. */
  removeOptimistic: (id: number) => void;
}

// Monotonic counter for optimistic row ids — avoids the (vanishingly
// small but real) collision risk from Date.now() + Math.random() when
// two sends fire in the same millisecond.
let optimisticIdSeq = 0;

function makeOptimistic(text: string, meta?: OptimisticMeta): OptimisticUserRow {
  optimisticIdSeq += 1;
  return {
    id: -optimisticIdSeq,
    ts: new Date().toISOString(),
    session_id: null,
    hook_type: "UserPromptSubmit",
    tool_name: null,
    text,
    // Seed the final-layout attributes up front (see OptimisticMeta): without
    // these a command flashes as a plain bubble and a peer's own turn flashes
    // blue before the real frame swaps in the command card / green bubble.
    kind: meta?.kind ?? null,
    author: meta?.author ?? null,
    __optimistic: true,
  } as OptimisticUserRow;
}

function isOptimistic(row: EventRow): row is OptimisticUserRow {
  return (row as Partial<OptimisticUserRow>).__optimistic === true;
}

// Canonical compare-key for a UserPromptSubmit row. Pulls the
// human-meaningful body out of the sandbox's structured-log wrapper
// for real frames, and uses the raw text for optimistic rows (which
// store the bare prompt). Trimmed + truncated to the server's 2000-
// char per-field cap so a long pasted prompt still matches its
// truncated server-side twin.
function promptKey(row: EventRow): string {
  return userPromptText(row).trim().slice(0, PROMPT_COMPARE_PREFIX);
}

function matchesOptimistic(real: EventRow, opt: OptimisticUserRow): boolean {
  if (real.hook_type !== "UserPromptSubmit") return false;
  if (promptKey(real) !== promptKey(opt)) return false;
  const realT = Date.parse(real.ts);
  const optT = Date.parse(opt.ts);
  if (!Number.isFinite(realT) || !Number.isFinite(optT)) return false;
  return Math.abs(realT - optT) < OPTIMISTIC_DEDUPE_WINDOW_MS;
}

// Detects the second-arrival-of-the-same-prompt case: claude / the
// sandbox can emit UserPromptSubmit twice for one user input (once on
// initial spawn, once on the --resume cycle after an alias swap). Both
// frames have unique ids in the events DB, so id-equality dedupe
// doesn't catch them. Content-equality (on the extracted prompt body)
// within the tighter window does.
//
// We deliberately use REAL_DUPLICATE_WINDOW_MS (5s) not the wider
// optimistic window — a user sending the same prompt twice within
// 30s is a legitimate action we should NOT collapse.
function isDuplicateUserPrompt(incoming: EventRow, existing: EventRow): boolean {
  if (incoming.hook_type !== "UserPromptSubmit") return false;
  if (existing.hook_type !== "UserPromptSubmit") return false;
  if (promptKey(incoming) !== promptKey(existing)) return false;
  const a = Date.parse(incoming.ts);
  const b = Date.parse(existing.ts);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) < REAL_DUPLICATE_WINDOW_MS;
}

// Page-level helper: collapse duplicate UserPromptSubmit rows in a
// historic events page. Walks oldest-first and drops any subsequent
// row that's a duplicate-prompt-within-window of one we've kept.
function dedupeUserPrompts(rows: EventRow[]): EventRow[] {
  const out: EventRow[] = [];
  for (const r of rows) {
    if (r.hook_type === "UserPromptSubmit") {
      let dupe = false;
      for (let i = out.length - 1; i >= 0; i--) {
        if (isDuplicateUserPrompt(r, out[i])) {
          dupe = true;
          break;
        }
      }
      if (dupe) continue;
    }
    out.push(r);
  }
  return out;
}

// Merge a single incoming row (from SSE or the polling backstop) into the
// transcript: drop exact-id duplicates, replace a matching optimistic twin, or
// drop a re-fired duplicate prompt; otherwise append. Pure so SSE and poll
// share identical semantics (and so SSE+poll delivering the same row is a no-op).
function ingestRow(prev: EventRow[], row: EventRow): EventRow[] {
  if (prev.some((p) => p.id === row.id)) return prev;
  for (let i = prev.length - 1; i >= 0; i--) {
    const r = prev[i];
    if (isOptimistic(r) && matchesOptimistic(row, r)) {
      const next = prev.slice();
      next[i] = row;
      return next;
    }
    if (isDuplicateUserPrompt(row, r)) return prev;
  }
  return [...prev, row];
}

/**
 * Owns the transcript array for the currently-selected session.
 *
 * Critical invariants:
 *
 *   1. **Clear-before-fetch.** When `sessionId` changes, events is set to
 *      `[]` SYNCHRONOUSLY in a useEffect that fires before the fetch's
 *      .then() resolves. This is the regression guard from the prior
 *      build, lifted into this single owner so leaf components can't
 *      reintroduce the bug.
 *
 *   2. **Stale-fetch discard.** Each fetch captures the sessionId it was
 *      issued for; if the value has changed by the time the response
 *      lands, the result is dropped. Same idea for SSE frames: when an
 *      event arrives for a session id that isn't current, it's ignored.
 *
 *   3. **Alias-aware filter.** A session's canonical id may swap mid-flight
 *      (claude --resume). Aliases are passed in by the caller (typically
 *      sourced from SelectedSessionContext); we accept frames matching
 *      sessionId OR any alias.
 *
 *   4. **Optimistic dedupe.** Sends push a negative-id row immediately;
 *      when the real UserPromptSubmit arrives via SSE, the optimistic
 *      twin is replaced (matched on (text, ts ± 5s)).
 *
 *   5. **Stable return identity.** The returned object is memoized, so a
 *      session that receives an SSE event only re-renders consumers
 *      whose visible state actually changed (the events array). Without
 *      this, the callback identities propagate through ActiveSessionProvider
 *      and cause unrelated consumers to re-render on every frame.
 */
export function useTranscript(
  sessionId: string | null,
  aliases: readonly string[],
): UseTranscript {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);

  // Refs so handlers see the latest values without forcing a
  // re-subscription on every state change.
  const currentIdRef = useRef<string | null>(sessionId);
  currentIdRef.current = sessionId;
  const aliasesRef = useRef<readonly string[]>(aliases);
  aliasesRef.current = aliases;
  const eventsRef = useRef<EventRow[]>(events);
  eventsRef.current = events;

  // Each fetch increments the gen counter; on resolve, if gen has moved,
  // the result is stale and we discard it. Coupled with the clear-first
  // effect, this means a fast-switch between sessions can never leak
  // events from the previous one into the new transcript.
  const genRef = useRef(0);

  // Initial fetch (and clear) on sessionId change.
  useEffect(() => {
    // Clear synchronously so consumers never observe leaked events.
    setEvents([]);
    setHasMore(false);
    if (!sessionId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    const myGen = ++genRef.current;
    const ctrl = new AbortController();

    fetch(
      `/api/events?session=${encodeURIComponent(sessionId)}&limit=${INITIAL_LIMIT}`,
      { signal: ctrl.signal },
    )
      .then(async (r) => {
        if (ctrl.signal.aborted || myGen !== genRef.current) return;
        if (!r.ok) {
          setLoading(false);
          return;
        }
        const raw = (await r.json()) as EventRow[];
        if (ctrl.signal.aborted || myGen !== genRef.current) return;
        // /api/events returns newest-first. We render oldest-first for
        // a terminal-style transcript that grows downward. Run the
        // duplicate-prompt filter on the historic page too — the
        // sandbox can persist both copies of a double-fired
        // UserPromptSubmit, so this isn't a runtime-only problem.
        const ordered = dedupeUserPrompts(raw.slice().reverse());
        setEvents(ordered);
        setHasMore(raw.length === INITIAL_LIMIT);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if ((e as { name?: string })?.name === "AbortError") return;
        if (myGen !== genRef.current) return;
        setLoading(false);
      });

    return () => ctrl.abort();
  }, [sessionId]);

  // loadMore reads events via ref so its identity is stable across
  // re-renders. Walks the array with a for-loop instead of
  // Math.min(...events.map()) — the latter spreads up to 10k+ args and
  // hits the call-arity limit on some engines.
  const loadMore = useCallback(async () => {
    const sid = currentIdRef.current;
    if (!sid) return;
    const current = eventsRef.current;
    if (current.length === 0) return;
    let oldestId = Infinity;
    for (const e of current) {
      if (e.id > 0 && e.id < oldestId) oldestId = e.id;
    }
    if (!Number.isFinite(oldestId)) return;

    const myGen = genRef.current;
    const r = await fetch(
      `/api/events?session=${encodeURIComponent(sid)}&limit=${PAGE_LIMIT}&before=${oldestId}`,
    );
    if (myGen !== genRef.current) return;
    if (!r.ok) return;
    const raw = (await r.json()) as EventRow[];
    if (myGen !== genRef.current) return;
    const ordered = raw.slice().reverse();
    setEvents((prev) => {
      const seen = new Set(prev.map((p) => p.id));
      const filtered = ordered.filter((e) => !seen.has(e.id));
      // The same UserPromptSubmit can appear twice in the page (claude
      // double-fired); drop dupes across the pending earlier-history
      // batch AND against rows already loaded into `prev`.
      const collapsedPage = dedupeUserPrompts(filtered);
      const final = collapsedPage.filter((e) => {
        if (e.hook_type !== "UserPromptSubmit") return true;
        return !prev.some((p) => isDuplicateUserPrompt(e, p));
      });
      return [...final, ...prev];
    });
    setHasMore(raw.length === PAGE_LIMIT);
  }, []);

  // Foreground backfill. Re-pull the latest page and MERGE it (never clear) so
  // events that landed while the tab was backgrounded — when the socket was
  // suspended and its live frames were dropped — are recovered without the
  // clear-then-refetch flash of the sessionId-change path. Idempotent: rows
  // already present are skipped by id in ingestRow, so a no-op refresh is cheap
  // and invisible. Does NOT bump the gen counter (it isn't switching sessions),
  // so an in-flight loadMore isn't invalidated.
  const refetch = useCallback(async () => {
    const sid = currentIdRef.current;
    if (!sid) return;
    const myGen = genRef.current;
    let r: Response;
    try {
      r = await fetch(`/api/events?session=${encodeURIComponent(sid)}&limit=${INITIAL_LIMIT}`);
    } catch { return; }
    if (myGen !== genRef.current || sid !== currentIdRef.current || !r.ok) return;
    const raw = (await r.json()) as EventRow[];
    if (myGen !== genRef.current || sid !== currentIdRef.current) return;
    const ordered = dedupeUserPrompts(raw.slice().reverse());
    // Synchronous from here (no await): the snapshot can't drift under us, so
    // building the merged array off `eventsRef` and setting it directly is safe.
    const before = eventsRef.current;
    let merged = before;
    for (const row of ordered) merged = ingestRow(merged, row);
    if (merged !== before) setEvents(merged);
  }, []);

  const pushOptimistic = useCallback((text: string, meta?: OptimisticMeta) => {
    const row = makeOptimistic(text, meta);
    setEvents((prev) => [...prev, row]);
    return row.id;
  }, []);

  const removeOptimistic = useCallback((id: number) => {
    setEvents((prev) => prev.filter((e) => e.id !== id));
  }, []);

  // SSE: append real events for the active session id or any alias.
  // De-dupes against any matching optimistic in one pass.
  useSSE({
    event: (data) => {
      const row = data as EventRow | null;
      if (!row || row.session_id == null) return;
      const sid = currentIdRef.current;
      if (!sid) return;
      const isMine =
        row.session_id === sid || aliasesRef.current.includes(row.session_id);
      if (!isMine) return;
      setEvents((prev) => ingestRow(prev, row));
    },
    // The tab returned to the foreground (or reconnected): backfill anything the
    // suspended socket missed. See useSSE onForeground / refetch.
    resync: () => { void refetch(); },
  });

  // Stable return identity: only re-creates when one of its visible
  // fields actually changed.
  return useMemo<UseTranscript>(
    () => ({ events, loading, hasMore, loadMore, pushOptimistic, removeOptimistic }),
    [events, loading, hasMore, loadMore, pushOptimistic, removeOptimistic],
  );
}
