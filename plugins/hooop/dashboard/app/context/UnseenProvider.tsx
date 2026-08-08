"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSSE } from "@/app/components/useSSE";
import { useSelectedSession } from "./SelectedSessionProvider";
import { myDisplayName, participantKind } from "../components/lib/participant";
import { countsAsUnseen } from "@shared/notifiable";

/**
 * Per-viewer "unseen activity" markers. When a new message lands on a session
 * the viewer is NOT currently looking at — and it isn't the viewer's own
 * message — that session is flagged. The sidebar renders a dot from this so the
 * user knows to check the other session; switching to it clears the flag.
 *
 * Ephemeral and client-only (like presence). In practice this is a host affair:
 * a peer is locked to a single session and only receives that session's events,
 * so `sid` always matches their current view and never flags. The host receives
 * every session's events and can switch between them, so the markers accumulate
 * for whichever sessions produced activity while the host was elsewhere.
 */
export interface UnseenValue {
  /** Raw set of session ids (canonical or alias) with unseen activity. */
  unseen: ReadonlySet<string>;
  /** True if any of the given ids (a session's canonical id + aliases) is flagged. */
  hasUnseen: (...ids: Array<string | null | undefined>) => boolean;
}

const UnseenContext = createContext<UnseenValue | null>(null);

// Which events count as "a new message" now lives in @shared/notifiable, so the
// sidebar dot and the sandbox's push notifications answer that question from one
// definition instead of two that can drift apart. Everything left in this file
// is viewer-specific — whether it's MY message, and whether I'm already looking
// at that session — which is not intrinsic to the event and so can't be shared.

export function UnseenProvider({ children }: { children: React.ReactNode }) {
  const { selectedId, aliases } = useSelectedSession();
  const [unseen, setUnseen] = useState<Set<string>>(() => new Set());

  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;
  const aliasesRef = useRef<readonly string[]>(aliases);
  aliasesRef.current = aliases;

  // Viewing a session clears its marker (canonical id + any historical alias).
  useEffect(() => {
    if (!selectedId) return;
    setUnseen((cur) => {
      const ids = [selectedId, ...aliases];
      if (!ids.some((id) => cur.has(id))) return cur;
      const next = new Set(cur);
      for (const id of ids) next.delete(id);
      return next;
    });
  }, [selectedId, aliases]);

  useSSE({
    event: (raw) => {
      const e = raw as {
        session_id?: string | null;
        hook_type?: string | null;
        author?: string | null;
        text?: string | null;
        agent_id?: string | null;
        kind?: string | null;
      };
      const sid = e?.session_id;
      // Intrinsic filters — real message, not sub-agent chatter, not a hidden
      // turn kind, not a contentless turn-complete marker. See @shared/notifiable.
      if (!sid || !countsAsUnseen(e)) return;
      // Belongs to the session I'm currently viewing (or an alias of it)? Seen.
      const cur = selectedRef.current;
      if (cur && (sid === cur || aliasesRef.current.includes(sid))) return;
      // From me? Don't self-notify. Host events carry author "host"; a peer's
      // carry their chosen name. (Assistant Stop has author null → always flags.)
      const me = participantKind() === "host" ? "host" : myDisplayName();
      if (e.author && e.author === me) return;
      setUnseen((curSet) => {
        if (curSet.has(sid)) return curSet;
        const next = new Set(curSet);
        next.add(sid);
        return next;
      });
    },
  });

  const hasUnseen = useCallback(
    (...ids: Array<string | null | undefined>) => ids.some((id) => !!id && unseen.has(id)),
    [unseen],
  );

  const value = useMemo<UnseenValue>(() => ({ unseen, hasUnseen }), [unseen, hasUnseen]);
  return <UnseenContext.Provider value={value}>{children}</UnseenContext.Provider>;
}

export function useUnseen(): UnseenValue {
  const ctx = useContext(UnseenContext);
  // Tolerate use outside the provider (e.g. isolated tests): report nothing unseen.
  if (!ctx) return { unseen: new Set(), hasUnseen: () => false };
  return ctx;
}
