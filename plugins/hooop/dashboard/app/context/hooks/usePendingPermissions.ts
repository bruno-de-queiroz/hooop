"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSSE } from "@/app/components/useSSE";
import { useSessions } from "@/app/context/SessionsProvider";
import type { PendingPermissionRequest } from "./usePendingRequests";

export interface GlobalPendingRequest {
  /** The session the ask belongs to (canonical id from the pending-requests API). */
  sessionId: string;
  request: PendingPermissionRequest;
}

export interface UsePendingPermissionsValue {
  /** Newest-first across every session. */
  pending: GlobalPendingRequest[];
  /** Host decision for a specific session's ask. Optimistically drops the row.
   * `feedback` is relayed to the model as the decision reason (plan rejection). */
  decide: (
    sessionId: string,
    requestId: string,
    decision: "allow" | "deny",
    scope?: "once" | "always",
    feedback?: string,
  ) => Promise<void>;
  /** Last decide-error keyed by requestId, cleared on the next attempt. */
  errors: Record<string, string>;
}

/**
 * Cross-session sibling of {@link usePendingRequests}. Where that hook is
 * scoped to the selected session (and drives the in-panel card), this one
 * tracks tool-permission asks for EVERY session so the global permissions
 * surface can show a request no matter which session is currently open.
 *
 * Same sourcing contract: the sandbox is the source of truth, so we always
 * re-fetch `/sessions/:id/pending-requests`; SSE is only the "when to refetch"
 * edge. Unlike the scoped hook, the edge here does NOT filter by session — any
 * PermissionRequest/PermissionResponse triggers a refetch of *that* session,
 * which also covers sessions that appeared after mount (e.g. a standalone
 * skill run).
 *
 * Mount hydration: for each session we learn about we fetch its open asks once
 * (a request could already be waiting before this panel mounted). SSE keeps it
 * live thereafter.
 */
export function usePendingPermissions(): UsePendingPermissionsValue {
  const { sessions } = useSessions();
  const [bySession, setBySession] = useState<Record<string, PendingPermissionRequest[]>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const bySessionRef = useRef(bySession);
  bySessionRef.current = bySession;

  const refreshSession = useCallback(async (sid: string) => {
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/pending-requests`);
      if (!r.ok) return;
      const body = (await r.json()) as { requests?: PendingPermissionRequest[] };
      const fresh = Array.isArray(body.requests) ? body.requests : [];
      setBySession((cur) => {
        // Drop empty buckets so `pending` stays lean and labels don't linger.
        if (fresh.length === 0) {
          if (!cur[sid]) return cur;
          const next = { ...cur };
          delete next[sid];
          return next;
        }
        return { ...cur, [sid]: fresh };
      });
    } catch {
      // Silent — the next SSE edge retries.
    }
  }, []);

  // Hydrate each session once, as we learn about it (initial load + new
  // sessions spawned later). A ref-tracked set avoids refetching on every
  // stats tick from the sessions list. Dormant sessions are skipped — a
  // stopped process can't be holding an open ask, so there's nothing to fetch.
  const hydratedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    for (const s of sessions) {
      const sid = s.sessionId;
      if (!sid || s.lifecycle === "dormant" || hydratedRef.current.has(sid)) continue;
      hydratedRef.current.add(sid);
      void refreshSession(sid);
    }
  }, [sessions, refreshSession]);

  // Refetch whichever session an ask event names — no session filter, so a
  // request from a non-selected session still surfaces.
  useSSE({
    event: (data) => {
      const row = data as { session_id?: string; hook_type?: string } | null;
      if (!row?.session_id || !row.hook_type) return;
      if (row.hook_type !== "PermissionRequest" && row.hook_type !== "PermissionResponse") return;
      void refreshSession(row.session_id);
    },
  });

  const decide = useCallback(
    async (
      sessionId: string,
      requestId: string,
      decision: "allow" | "deny",
      scope: "once" | "always" = "once",
      feedback?: string,
    ) => {
      setErrors((e) => {
        const { [requestId]: _drop, ...rest } = e;
        return rest;
      });
      const snapshot = bySessionRef.current[sessionId] ?? [];
      setBySession((cur) => {
        const list = (cur[sessionId] ?? []).filter((r) => r.requestId !== requestId);
        const next = { ...cur };
        if (list.length === 0) delete next[sessionId];
        else next[sessionId] = list;
        return next;
      });
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/permission`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, decision, scope, ...(feedback ? { feedback } : {}) }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setErrors((e) => ({ ...e, [requestId]: body?.error ?? `HTTP ${r.status}` }));
          setBySession((cur) => ({ ...cur, [sessionId]: snapshot }));
        }
      } catch (err) {
        setErrors((e) => ({
          ...e,
          [requestId]: (err as { message?: string })?.message ?? "permission response failed",
        }));
        setBySession((cur) => ({ ...cur, [sessionId]: snapshot }));
      }
    },
    [],
  );

  const pending: GlobalPendingRequest[] = Object.entries(bySession)
    .flatMap(([sessionId, reqs]) => reqs.map((request) => ({ sessionId, request })))
    .sort((a, b) => b.request.receivedAt - a.request.receivedAt);

  return { pending, decide, errors };
}
