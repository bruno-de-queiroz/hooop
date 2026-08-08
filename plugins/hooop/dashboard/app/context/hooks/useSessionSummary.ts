"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSSE } from "@/app/components/useSSE";
import type { SessionSummary } from "@/lib/sandbox-client";

// claude-mem indexes asynchronously after Stop. 1.5s is the heuristic
// we've used elsewhere; if it consistently misses, raise this or move
// to an exponential retry.
const POST_STOP_REFETCH_DELAY_MS = 1_500;

export type SummaryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; summary: SessionSummary | null }
  | { status: "error" };

export interface UseSessionSummary {
  state: SummaryState;
  /** Lazy: triggers the first fetch on demand (e.g. when the card expands). */
  ensureLoaded: () => void;
  /** Forces a re-fetch immediately, ignoring cache state. */
  refetch: () => void;
}

/**
 * Per-session claude-mem summary, with lazy first-fetch and automatic
 * post-Stop refresh.
 *
 * Lazy first-fetch keeps us from spamming the sandbox when the user is
 * just clicking through sessions; the summary card calls `ensureLoaded`
 * the first time it expands.
 *
 * Post-Stop refresh: when a Stop event arrives for this session, we
 * schedule a refetch ~1.5s later (claude-mem's writer runs
 * asynchronously). Multiple Stops within the window coalesce into one
 * refetch via a debounce timer.
 */
export function useSessionSummary(
  sessionId: string | null,
  aliases: readonly string[],
): UseSessionSummary {
  const [state, setState] = useState<SummaryState>({ status: "idle" });
  const triggeredRef = useRef(false);
  const refetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const genRef = useRef(0);

  // Reset on session change.
  useEffect(() => {
    triggeredRef.current = false;
    setState({ status: "idle" });
    genRef.current++;
    if (refetchTimerRef.current) {
      clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = null;
    }
  }, [sessionId]);

  const doFetch = useCallback(async () => {
    if (!sessionId) return;
    const myGen = genRef.current;
    setState({ status: "loading" });
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/summary`);
      if (myGen !== genRef.current) return;
      if (!r.ok) {
        setState({ status: "error" });
        return;
      }
      const body = (await r.json()) as { summary: SessionSummary | null };
      if (myGen !== genRef.current) return;
      setState({ status: "ready", summary: body.summary });
    } catch {
      if (myGen !== genRef.current) return;
      setState({ status: "error" });
    }
  }, [sessionId]);

  const ensureLoaded = useCallback(() => {
    if (triggeredRef.current) return;
    triggeredRef.current = true;
    doFetch();
  }, [doFetch]);

  const refetch = useCallback(() => {
    triggeredRef.current = true;
    doFetch();
  }, [doFetch]);

  // SSE: schedule a refetch on Stop for this session.
  useSSE({
    event: (data) => {
      const row = data as { session_id?: string; hook_type?: string } | null;
      if (!row || row.hook_type !== "Stop" || !row.session_id) return;
      const sid = sessionId;
      if (!sid) return;
      const matches =
        row.session_id === sid || aliases.includes(row.session_id);
      if (!matches) return;
      if (!triggeredRef.current) return; // user never opened the card; don't pre-warm
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
      refetchTimerRef.current = setTimeout(() => {
        refetchTimerRef.current = null;
        doFetch();
      }, POST_STOP_REFETCH_DELAY_MS);
    },
  });

  // Cleanup the timer when the hook unmounts (or sessionId changes — the
  // earlier effect already nulls the timer, but this is the unmount path).
  useEffect(() => {
    return () => {
      if (refetchTimerRef.current) clearTimeout(refetchTimerRef.current);
    };
  }, []);

  return { state, ensureLoaded, refetch };
}
