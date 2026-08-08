"use client";
import { useCallback, useEffect, useState } from "react";
import type { PlanReviewComment } from "@/lib/sandbox-client";

export interface UsePlanCommentsValue {
  comments: PlanReviewComment[];
  /** The caller's author identity — comments with author === you are editable. */
  you: string | null;
  add: (input: { quote: string; offset: number; length: number; body: string }) => Promise<void>;
  reply: (commentId: string, body: string) => Promise<void>;
  edit: (commentId: string, body: string) => Promise<void>;
  remove: (commentId: string) => Promise<void>;
  error: string | null;
}

const POLL_MS = 1500;

/**
 * Shared plan-review comments for one plan (requestId). The sandbox holds them
 * for the whole session, so polling here surfaces comments authored by any
 * peer live. Mutations POST then re-fetch so the local view converges quickly.
 */
export function usePlanComments(sessionId: string | null, requestId: string | null): UsePlanCommentsValue {
  const [comments, setComments] = useState<PlanReviewComment[]>([]);
  const [you, setYou] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = !!sessionId && !!requestId;

  const refresh = useCallback(async () => {
    if (!sessionId || !requestId) return;
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan-comments?requestId=${encodeURIComponent(requestId)}`);
      if (!r.ok) return;
      const body = (await r.json()) as { comments?: PlanReviewComment[]; you?: string | null };
      setComments(Array.isArray(body.comments) ? body.comments : []);
      setYou(body.you ?? null);
    } catch {
      /* transient — next poll retries */
    }
  }, [sessionId, requestId]);

  useEffect(() => {
    if (!active) { setComments([]); return; }
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(t);
  }, [active, refresh]);

  const mutate = useCallback(
    async (path: string, payload: Record<string, unknown>) => {
      if (!sessionId || !requestId) return;
      setError(null);
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/plan-comments${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ requestId, ...payload }),
        });
        if (!r.ok) {
          const b = (await r.json().catch(() => null)) as { error?: string } | null;
          setError(b?.error ?? `HTTP ${r.status}`);
        }
      } catch (e) {
        setError((e as { message?: string })?.message ?? "request failed");
      } finally {
        void refresh();
      }
    },
    [sessionId, requestId, refresh],
  );

  const add = useCallback(
    (input: { quote: string; offset: number; length: number; body: string }) => mutate("", input),
    [mutate],
  );
  const reply = useCallback((commentId: string, body: string) => mutate("/reply", { commentId, body }), [mutate]);
  const edit = useCallback((commentId: string, body: string) => mutate("/edit", { commentId, body }), [mutate]);
  const remove = useCallback((commentId: string) => mutate("/remove", { commentId }), [mutate]);

  return { comments, you, add, reply, edit, remove, error };
}
