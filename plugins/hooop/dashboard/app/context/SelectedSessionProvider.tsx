"use client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useSSE } from "@/app/components/useSSE";
import { isPeerClient, peerSessionId } from "@/app/components/lib/participant";

export interface SelectedSessionValue {
  selectedId: string | null;
  /** Historical session_ids the active conversation is also known by. */
  aliases: string[];
  setSelected: (id: string | null) => void;
}

const SelectedSessionContext = createContext<SelectedSessionValue | null>(null);

/**
 * Single source of selection truth.
 *
 * - **Persistence layer**: `?session=<id>` in the URL. Survives refresh,
 *   shareable, and lets two tabs of the dashboard show different sessions
 *   without fighting each other.
 *
 * - **Runtime layer**: this context. Components read `selectedId` from
 *   here, never from `useSearchParams` directly. That keeps the
 *   "everything reacts to the active session" plumbing in one place.
 *
 * - **Alias handling**: when claude --resume mints a new internal id
 *   mid-conversation, the sandbox emits `session-status` with
 *   `{ aliasFrom: oldId, sessionId: newId }`. We accept those whose
 *   `aliasFrom` matches the currently-selected id (or one of its known
 *   aliases) and widen the alias set. Out-of-band frames for other
 *   sessions are ignored — keeping the active set narrow prevents
 *   cross-session leakage into the transcript filter.
 */
export function SelectedSessionProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  const searchParams = useSearchParams();
  const urlSelected = searchParams?.get("session") ?? null;

  // A peer is locked to the session they were shared into — they can't switch.
  // Resolved SYNCHRONOUSLY (not in a mount effect) so `selectedId` is pinned to
  // the peer's bound session from the very first client render. The earlier
  // effect-based resolve left a window where `peerLock` was null: if anything
  // cleared `?session=` in that window (e.g. the dead-session guard bouncing on
  // a transient empty list while a dormant session re-keys), a peer fell through
  // to `urlSelected === null` and got shown the HOST create-session view.
  //
  // Hydration is safe: the meta tags live in the SSR'd <head>, and the join flow
  // already forces `?session=<peer.ses>` into the URL, so on the server
  // `selectedId` resolves via `urlSelected` to the same id the client computes
  // here — the rendered output matches either way.
  const [peerLock] = useState<string | null>(() =>
    isPeerClient() ? peerSessionId() : null,
  );
  const selectedId = peerLock ?? urlSelected;

  // If a peer somehow lands on a different ?session, normalize the URL to their
  // bound session so the address bar can't imply otherwise.
  useEffect(() => {
    if (peerLock && urlSelected !== peerLock) {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      params.set("session", peerLock);
      router.replace(`${pathname}?${params.toString()}`);
    }
  }, [peerLock, urlSelected, pathname, router, searchParams]);

  const [aliases, setAliases] = useState<string[]>([]);

  // Reset aliases whenever the canonical selection changes. The effect
  // ONLY runs when selectedId in the deps actually changes (React
  // reference equality), so no ref-comparison guard is needed inside.
  useEffect(() => {
    setAliases([]);
  }, [selectedId]);

  // Keep refs to selectedId, aliases, and searchParams so the SSE
  // handler and setSelected callback see the latest values without
  // re-subscribing / re-binding on every state change.
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  const aliasesRef = useRef(aliases);
  aliasesRef.current = aliases;
  const searchParamsRef = useRef(searchParams);
  searchParamsRef.current = searchParams;

  useSSE({
    "session-status": (data) => {
      const payload = data as {
        sessionId?: string;
        aliasFrom?: string;
      } | null;
      if (!payload?.aliasFrom || !payload.sessionId) return;
      const sid = selectedRef.current;
      if (!sid) return;
      const matchesActive =
        payload.aliasFrom === sid || aliasesRef.current.includes(payload.aliasFrom);
      if (!matchesActive) return;
      // Add the new canonical id to our alias set so downstream filters
      // accept events under it. We do NOT swap selectedId — the URL
      // stays anchored to whatever the user opened; if they reload,
      // sessionInfo.aliases on the server side resolves the lookup.
      const newId = payload.sessionId;
      if (newId === sid || aliasesRef.current.includes(newId)) return;
      setAliases((prev) => [...prev, newId]);
    },
  });

  // setSelected is identity-stable; it reads the latest searchParams
  // through a ref. Without this, two rapid clicks against the latest
  // closure could write a stale set of params (the second click would
  // use the searchParams snapshot captured at the moment of the first
  // render, racing with React's URL update).
  const peerLockRef = useRef(peerLock);
  peerLockRef.current = peerLock;
  const setSelected = useCallback(
    (id: string | null) => {
      // Peers are pinned to their shared session; switching is a no-op.
      if (peerLockRef.current) return;
      const sp = searchParamsRef.current;
      const params = new URLSearchParams(sp?.toString() ?? "");
      if (id) {
        params.set("session", id);
      } else {
        params.delete("session");
      }
      const qs = params.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname);
    },
    [router, pathname],
  );

  const value = useMemo<SelectedSessionValue>(
    () => ({ selectedId, aliases, setSelected }),
    [selectedId, aliases, setSelected],
  );

  return (
    <SelectedSessionContext.Provider value={value}>
      {children}
    </SelectedSessionContext.Provider>
  );
}

export function useSelectedSession(): SelectedSessionValue {
  const ctx = useContext(SelectedSessionContext);
  if (!ctx) {
    throw new Error(
      "useSelectedSession must be used inside <SelectedSessionProvider>",
    );
  }
  return ctx;
}
