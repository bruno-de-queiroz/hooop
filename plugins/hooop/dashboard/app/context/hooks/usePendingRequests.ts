"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSSE } from "@/app/components/useSSE";

export interface PendingPermissionRequest {
  requestId: string;
  toolUseId: string | null;
  toolName: string;
  input: unknown;
  decisionReason: string | null;
  receivedAt: number;
  /** "host" or a peer's name — who drove the turn this ask came from. */
  author: string | null;
}

export interface UsePendingRequestsValue {
  /** Newest-first list of open asks. */
  pending: PendingPermissionRequest[];
  /** Send the host's decision to the sandbox; optimistically drops the row.
   * `scope:"always"` also grants the driving peer session-scoped auto-approve.
   * `feedback` is relayed to the model as the decision reason (plan rejection). */
  decide: (requestId: string, decision: "allow" | "deny", scope?: "once" | "always", feedback?: string) => Promise<void>;
  /** Last decide-error, cleared on the next decide attempt. */
  error: string | null;
}

/**
 * Tracks tool-permission asks for the currently-selected session.
 *
 * The sandbox is the source of truth; we always re-fetch
 * `/sessions/:id/pending-requests` to get the canonical list. SSE acts as a
 * notification edge (PermissionRequest / PermissionResponse) — we use it
 * only to know WHEN to re-fetch. This avoids reconstructing the request
 * shape from the truncated `text` column (the structured-log envelope
 * loses fields like `request_id` that aren't in the ingestor's known
 * key list).
 *
 * `decide()` optimistically drops the row locally so the card hides
 * immediately, then POSTs the decision. On failure we re-add to pending
 * so the user can retry.
 */
export function usePendingRequests(sessionId: string | null): UsePendingRequestsValue {
  const [pending, setPending] = useState<PendingPermissionRequest[]>([]);
  const [error, setError] = useState<string | null>(null);
  const sidRef = useRef<string | null>(sessionId);
  sidRef.current = sessionId;

  const refresh = useCallback(async () => {
    const sid = sidRef.current;
    if (!sid) {
      setPending([]);
      return;
    }
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/pending-requests`);
      if (!r.ok) return;
      const body = (await r.json()) as { requests?: PendingPermissionRequest[] };
      if (sidRef.current !== sid) return;
      const fresh = Array.isArray(body.requests) ? body.requests : [];
      fresh.sort((a, b) => b.receivedAt - a.receivedAt);
      setPending(fresh);
    } catch {
      // Silent — if hydration fails, the next SSE edge will retry.
    }
  }, []);

  // Hydrate on session change.
  useEffect(() => {
    setError(null);
    setPending([]);
    if (!sessionId) return;
    void refresh();
  }, [sessionId, refresh]);

  // Treat every Permission* event as a "refresh trigger". We do NOT filter by
  // session_id: a freshly-spawned session's request can arrive under its
  // post-swap canonical id while we're still selected under the `pending-` id
  // (or an older alias), so an exact match would miss it. The refetch is scoped
  // to the selected session server-side (alias-resolved), so an unrelated
  // session's edge just triggers a cheap, correct re-poll of our own list.
  useSSE({
    event: (data) => {
      const row = data as { session_id?: string; hook_type?: string } | null;
      if (!row || !row.hook_type) return;
      if (!sidRef.current) return;
      if (row.hook_type !== "PermissionRequest" && row.hook_type !== "PermissionResponse") return;
      void refresh();
    },
  });

  const decide = useCallback(
    async (requestId: string, decision: "allow" | "deny", scope: "once" | "always" = "once", feedback?: string) => {
      const sid = sidRef.current;
      if (!sid) return;
      setError(null);
      const snapshot = pending;
      setPending((cur) => cur.filter((r) => r.requestId !== requestId));
      try {
        const r = await fetch(
          `/api/sessions/${encodeURIComponent(sid)}/permission`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requestId, decision, scope, ...(feedback ? { feedback } : {}) }),
          },
        );
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setError(body?.error ?? `HTTP ${r.status}`);
          setPending(snapshot);
        }
      } catch (e) {
        setError((e as { message?: string })?.message ?? "permission response failed");
        setPending(snapshot);
      }
    },
    [pending],
  );

  return { pending, decide, error };
}
