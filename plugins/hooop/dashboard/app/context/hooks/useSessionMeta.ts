"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionInfo, SessionLifecycle } from "@/lib/types/session";
import { useSSE } from "@/app/components/useSSE";

export interface SessionMeta {
  /** The full row from /api/sessions for this id, if present. */
  session: SessionInfo | null;
  model: string | null;
  lifecycle: SessionLifecycle | null;
  cwd: string | null;
  displayName: string | null;
  /** Unattended auto-approval (auto mode) is engaged for this session. */
  autoMode: boolean;
  /** True once this session is armed to self-destruct instead of going
   * dormant. Set at creation; can be cancelled later but not enabled later. */
  burnAfterUse: boolean;
  /** Idle-dormancy window for this session. null = install-wide default,
   * 0 = never go dormant, positive = this session's own window, in ms. */
  idleTtlMs: number | null;
}

/**
 * Derives per-session meta from the live sessions array, with a
 * network-backed model fallback.
 *
 * Three signals trigger a model refresh: sessionId change, session-status
 * SSE, and a Stop frame on the event SSE. Rather than firing three
 * uncoordinated fetches (which the previous build did, with `sessionId!`
 * non-null assertions inside async closures), this hook funnels them
 * into a single `modelTick` counter; one effect watches the tick and
 * issues at most one in-flight fetch at a time via an AbortController.
 * Subsequent triggers cancel the prior request.
 */
export function useSessionMeta(
  sessionId: string | null,
  sessions: SessionInfo[],
  aliases: readonly string[],
): SessionMeta {
  const session = useMemo(() => {
    if (!sessionId) return null;
    return (
      sessions.find(
        (s) =>
          s.sessionId === sessionId ||
          (s.aliases ?? []).includes(sessionId) ||
          aliases.some(
            (a) => s.sessionId === a || (s.aliases ?? []).includes(a),
          ),
      ) ?? null
    );
  }, [sessionId, sessions, aliases]);

  const [fetchedModel, setFetchedModel] = useState<string | null>(null);
  const [modelTick, setModelTick] = useState(0);

  // Reset the fallback whenever the active session changes. No modelTick bump
  // needed — the fetch effect below already depends on sessionId, so it re-runs
  // (immediately, delay 0) on a session change. Bumping the tick here caused a
  // second effect run that was misclassified as a debounced (non-initial)
  // fetch, delaying the initial model load by 250ms.
  useEffect(() => {
    setFetchedModel(null);
  }, [sessionId]);

  // Single in-flight model fetch, cancelled on subsequent ticks or unmount.
  // The INITIAL load for a session fetches immediately (snappy display); the
  // SSE-driven refetches (Stop / session-status bump modelTick) are debounced,
  // so a busy turn with many Stop frames collapses into one fetch instead of a
  // burst. The AbortController still cancels any fetch in flight when superseded.
  const lastFetchedSidRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const id = sessionId;
    const immediate = lastFetchedSidRef.current !== id;
    lastFetchedSidRef.current = id;
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/sessions/${encodeURIComponent(id)}/model`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { model: string | null } | null) => {
          if (ctrl.signal.aborted) return;
          if (j) setFetchedModel(j.model ?? null);
        })
        .catch((e: unknown) => {
          // AbortError is the documented cancellation path; everything else
          // we silently drop — the display falls back to lastStats.
          if ((e as { name?: string })?.name !== "AbortError") return;
        });
    }, immediate ? 0 : 250);
    return () => { clearTimeout(timer); ctrl.abort(); };
  }, [sessionId, modelTick]);

  // Aliases as a ref so SSE callbacks see the latest set without
  // re-binding the subscription.
  const aliasesRef = useRef<readonly string[]>(aliases);
  aliasesRef.current = aliases;
  const sidRef = useRef<string | null>(sessionId);
  sidRef.current = sessionId;

  useSSE({
    "session-status": (data) => {
      const payload = data as { sessionId?: string } | null;
      const sid = sidRef.current;
      if (!sid || !payload?.sessionId) return;
      if (payload.sessionId !== sid && !aliasesRef.current.includes(payload.sessionId)) {
        return;
      }
      setModelTick((t) => t + 1);
    },
    event: (data) => {
      const row = data as { session_id?: string; hook_type?: string } | null;
      if (!row || row.hook_type !== "Stop" || !row.session_id) return;
      const sid = sidRef.current;
      if (!sid) return;
      if (row.session_id !== sid && !aliasesRef.current.includes(row.session_id)) {
        return;
      }
      setModelTick((t) => t + 1);
    },
  });

  const model = fetchedModel ?? session?.lastStats?.model ?? null;

  return {
    session,
    model,
    lifecycle: session?.lifecycle ?? null,
    cwd: session?.cwd ?? null,
    displayName: session?.displayName ?? null,
    autoMode: session?.autoMode === true,
    burnAfterUse: session?.burnAfterUse === true,
    idleTtlMs: session?.idleTtlMs ?? null,
  };
}
