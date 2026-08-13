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
import { useSSE } from "@/app/components/useSSE";
import type { SessionInfo } from "@/lib/types/session";
import { isPeerClient } from "@/app/components/lib/participant";
import { useSelectedSession } from "./SelectedSessionProvider";

export interface SessionsValue {
  sessions: SessionInfo[];
  loading: boolean;
  refresh: () => Promise<void>;
  /**
   * Optimistically removes the row and POSTs DELETE. When the deleted
   * session is currently selected, clears the URL so the active-session
   * frame returns to its empty state in the same render.
   */
  deleteSession: (sessionId: string) => Promise<void>;
  /**
   * POSTs the new session, refreshes the list, and selects the new
   * session id so the active-session frame snaps to it immediately.
   * Returns just the sessionId — callers that need the full row should
   * read it from `sessions` after the next render, which `refresh` has
   * already triggered. (Returning a SessionInfo here would expose a
   * stale read because the `setSessions` from refresh hasn't flushed
   * into `sessions` yet at the moment `createSession` resolves.)
   * Throws on policy / cap errors so callers can surface them inline.
   */
  createSession: (opts: {
    name?: string;
    model?: string;
    gitRepo?: string;
    /** Per-session idle-dormancy window. null = install default, 0 = never
     * go dormant, positive = this session's own window in ms. */
    idleTtlMs?: number | null;
    /** Arm burn-after-use at creation; can only be cancelled later. */
    burnAfterUse?: boolean;
  }) => Promise<{ sessionId: string }>;
  /**
   * PATCHes a new name onto the session. Optimistic local update; if
   * the server rejects, the optimistic value is rolled back and the
   * error is rethrown for the caller to surface.
   */
  renameSession: (sessionId: string, name: string) => Promise<void>;
}

const SessionsContext = createContext<SessionsValue | null>(null);

// Collapse a burst of `sessions` SSE pings during a single turn into one
// refetch. 150ms is below the human flicker threshold; matches the value
// the previous build settled on.
const SSE_DEBOUNCE_MS = 150;

// Identity-relevant signature for `lastStats`. Bare-minimum fields the
// stats strip + model badge react to. Without these in the diff,
// shallowEqual eats every end-of-turn update and the strip stops moving.
function statsSignature(ls: SessionInfo["lastStats"] | undefined): string {
  if (!ls) return "";
  const t = ls.totals;
  const u = ls.usage;
  return [
    ls.model ?? "",
    ls.mode ?? "",
    ls.turnEndedAt ?? 0,
    ls.contextWindow ?? 0,
    ls.autoCompactWindow ?? 0,
    ls.autoCompactPct ?? 0,
    t?.input_tokens ?? 0,
    t?.output_tokens ?? 0,
    t?.cache_read_input_tokens ?? 0,
    t?.cache_creation_input_tokens ?? 0,
    t?.turns ?? 0,
    // The "ctx %" meter reads the per-turn `usage`, not `totals`, so a
    // usage-only change (e.g. the compaction reset that zeroes usage between
    // turns) must be in the signature or shallowEqual dedupes it and the bar
    // never drops until the next turn bumps totals.
    u?.input_tokens ?? 0,
    u?.cache_read_input_tokens ?? 0,
    u?.cache_creation_input_tokens ?? 0,
  ].join("|");
}

function shallowEqual(a: SessionInfo[], b: SessionInfo[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (
      x.id !== y.id ||
      x.sessionId !== y.sessionId ||
      x.lifecycle !== y.lifecycle ||
      x.displayName !== y.displayName ||
      x.skill !== y.skill ||
      x.status !== y.status ||
      x.entrypoint !== y.entrypoint ||
      x.cwd !== y.cwd ||
      // Streams during provisioning (git-clone progress). Only mutates in that
      // short-lived state, so it can't drive a steady-state re-render storm —
      // but omitting it dedupes away every progress update and freezes the
      // clone-progress frame on its first (empty) value.
      x.cloneProgress !== y.cloneProgress ||
      // turnActive drives the "running" pulse; updatedAt is the activity clock
      // the sidebar's unseen/recently-active cue reads. A model-free `!bash` /
      // `>chat` bumps ONLY updatedAt (via the registry's lastSeenAt) — omitting
      // it here is the same "nothing visible changed" trap that once ate
      // end-of-turn lastStats: the refresh lands but is deduped away, so the
      // session never reads as active. NB updatedAt is coarse (turn boundaries
      // + side-channel activity), not claude's chatty file mtime, so this can't
      // reintroduce the per-write re-render storm the raw mtime tick caused.
      (x.turnActive ?? false) !== (y.turnActive ?? false) ||
      // Auto mode drives the header pill. It can flip with NO other change (the
      // off-switch when no turn is running), so without it here the refetch lands
      // but is deduped away and the pill never clears until a reload.
      (x.autoMode ?? false) !== (y.autoMode ?? false) ||
      (x.updatedAt ?? 0) !== (y.updatedAt ?? 0) ||
      statsSignature(x.lastStats) !== statsSignature(y.lastStats)
    ) {
      return false;
    }
    const ax = x.aliases ?? [];
    const ay = y.aliases ?? [];
    if (ax.length !== ay.length) return false;
    for (let j = 0; j < ax.length; j++) if (ax[j] !== ay[j]) return false;
  }
  return true;
}

// How long after selecting a dormant session we guard its label against
// regressing to a null-displayName transient during the resume id-swap.
const WAKE_SETTLE_MS = 1500;

// Grace window before treating a `?session=<id>` that matches no known session
// as dead and bouncing back to the create-session flow. A freshly-spawned
// session is selected by its (real) id the instant `createSession` /
// `startSkillRun` resolves — a beat before it lands in the `/api/sessions`
// list — so we can't redirect on a single missing read. We wait, and the
// timer callback re-checks the freshest list: if the row arrived (SSE refresh),
// no redirect; if it never shows, the id is stale/nonexistent → clear it.
const MISSING_SESSION_GRACE_MS = 2500;

export function SessionsProvider({ children }: { children: React.ReactNode }) {
  const { selectedId, setSelected } = useSelectedSession();
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const sessionsRef = useRef<SessionInfo[]>([]);
  sessionsRef.current = sessions;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Wake-settle: when the user selects a dormant session, `claude --resume`
  // mints a new id and there's a brief window where the sessions payload can
  // carry an undecorated (null displayName) row for that conversation. The
  // server already suppresses the orphan row; this is the client-side
  // belt-and-suspenders so the selected session's NAME never regresses to a
  // cwd-basename / id-slice fallback mid-wake. We keep the single sessions
  // array as the one source both the sidebar and the frame read.
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  const wakeSettleUntilRef = useRef(0);

  const matchesSelected = useCallback((s: SessionInfo, sel: string): boolean => {
    return s.sessionId === sel || (s.aliases ?? []).includes(sel);
  }, []);

  // Arm the settle window when the selection moves to a dormant row.
  useEffect(() => {
    if (!selectedId) return;
    const cur = sessionsRef.current.find((s) => matchesSelected(s, selectedId));
    if (cur?.lifecycle === "dormant") {
      wakeSettleUntilRef.current = Date.now() + WAKE_SETTLE_MS;
    }
  }, [selectedId, matchesSelected]);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/sessions");
      if (!r.ok) {
        setLoading(false);
        return;
      }
      let next = (await r.json()) as SessionInfo[];

      // During the wake-settle window, don't let the selected session's label
      // regress: if the incoming row lost its displayName but the row we're
      // already showing has one, carry the name forward (lifecycle/other
      // fresh fields still update). Only patches the selected conversation.
      const sel = selectedIdRef.current;
      if (sel && Date.now() < wakeSettleUntilRef.current) {
        const prev = sessionsRef.current.find((s) => matchesSelected(s, sel));
        if (prev?.displayName) {
          next = next.map((s) =>
            matchesSelected(s, sel) && !s.displayName
              ? { ...s, displayName: prev.displayName }
              : s,
          );
        }
      }

      // Skip the state update if nothing visible changed. This kills the
      // sidebar re-render on the every-turn mtime tick — without this
      // the row hover/selection state strobes whenever an event lands.
      if (!shallowEqual(sessionsRef.current, next)) {
        setSessions(next);
      }
    } finally {
      setLoading(false);
    }
  }, [matchesSelected]);

  // Initial fetch — one concern per effect so refactors don't accidentally
  // unmount the debounce timer when refresh's identity changes.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Debounce-timer lifecycle. Lives on its own so callers can rely on
  // the timer being cleared exactly when the provider unmounts.
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    };
  }, []);

  const refreshDebounced = useCallback(() => {
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
    debounceTimerRef.current = setTimeout(() => {
      debounceTimerRef.current = null;
      refresh();
    }, SSE_DEBOUNCE_MS);
  }, [refresh]);

  useSSE({
    sessions: () => refreshDebounced(),
    // Backfill after a stream gap (tab suspend, or a reconnect — see useSSE.ts).
    // The `sessions` pings that fired while we were disconnected are gone, so
    // without this the list keeps whatever it last saw: a `turnActive` that is
    // still true from the turn's START (pinning the "thinking" indicator) and a
    // pre-compaction `lastStats` (freezing the ctx meter). Both are read off
    // this list, which is why one dropped socket froze both at once.
    resync: () => refreshDebounced(),
  });

  // Dead-session guard: if the URL points at a `?session=<id>` that resolves to
  // no known session, bounce to the create-session flow (`setSelected(null)`
  // clears the param → ShellCenterPane renders ShellNewSession).
  //
  // HOST-ONLY. A peer has no create-session flow to land on — bouncing one to a
  // null selection drops them onto the host create view (the reported bug when a
  // shared session goes dormant: the sandbox re-keys on resume and the peer's
  // filtered `/api/sessions` row transiently vanishes, tripping this guard).
  // A peer is pinned to their bound session; a missing row is a transient the
  // next refresh reconciles, never a reason to clear their selection. We gate
  // explicitly here rather than leaning on `setSelected` being a no-op under the
  // peer lock, so the protection can't regress if that lock ever fails to
  // resolve.
  //
  // Race-safety: this arms a single grace timer per selection (deps are the
  // selection + load state only, never `sessions`, so an SSE refresh storm
  // can't keep resetting it). The callback re-reads the freshest list and
  // selection through refs, so a session that lands mid-grace (freshly created
  // / skill-spawned) cancels the bounce naturally. If the list hasn't finished
  // its first load when the timer fires we bail; the `loading` dep re-arms a
  // fresh window once it settles.
  const redirectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (redirectTimerRef.current) {
      clearTimeout(redirectTimerRef.current);
      redirectTimerRef.current = null;
    }
    if (!selectedId) return;
    if (isPeerClient()) return; // never bounce a peer to the create view
    redirectTimerRef.current = setTimeout(() => {
      redirectTimerRef.current = null;
      if (loadingRef.current) return; // list not authoritative yet
      const sel = selectedIdRef.current;
      if (!sel) return;
      const exists = sessionsRef.current.some((s) => matchesSelected(s, sel));
      if (!exists) setSelected(null);
    }, MISSING_SESSION_GRACE_MS);
    return () => {
      if (redirectTimerRef.current) {
        clearTimeout(redirectTimerRef.current);
        redirectTimerRef.current = null;
      }
    };
  }, [selectedId, loading, matchesSelected, setSelected]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      // Optimistic local remove. The /sessions SSE will reconcile if
      // anything went wrong server-side.
      setSessions((prev) =>
        prev.filter(
          (s) => s.sessionId !== sessionId && !(s.aliases ?? []).includes(sessionId),
        ),
      );
      // If we just deleted the active selection, clear the URL in the
      // same transition — no broken-selection flash.
      if (sessionId === selectedId) {
        setSelected(null);
      }
      try {
        await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "DELETE",
        });
      } catch {
        // ignore; server is the source of truth, next refresh reconciles
      }
    },
    [selectedId, setSelected],
  );

  const createSession = useCallback(
    async (opts: {
      name?: string;
      model?: string;
      gitRepo?: string;
      idleTtlMs?: number | null;
      burnAfterUse?: boolean;
    }): Promise<{ sessionId: string }> => {
      const r = await fetch("/api/sessions/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: opts.name,
          model: opts.model,
          gitRepo: opts.gitRepo,
          idleTtlMs: opts.idleTtlMs,
          burnAfterUse: opts.burnAfterUse,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { sessionId: string };
      // Refresh so the new row lands in `sessions` on the next render,
      // then snap selection to it. We don't return the SessionInfo —
      // sessionsRef.current is still the pre-refresh value at this
      // point (React commits setState on the next render), so any
      // synthetic we built here would mislead the caller.
      await refresh();
      setSelected(body.sessionId);
      return { sessionId: body.sessionId };
    },
    [refresh, setSelected],
  );

  const renameSession = useCallback(
    async (sessionId: string, name: string) => {
      const trimmed = name.trim();
      // Snapshot the previous displayName for rollback. We rollback on
      // both network failure and 4xx so optimistic UI doesn't lie.
      const prevName = sessionsRef.current.find(
        (s) => s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId),
      )?.displayName;
      setSessions((prev) =>
        prev.map((s) =>
          s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId)
            ? { ...s, displayName: trimmed || null }
            : s,
        ),
      );
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!r.ok) {
          // Rollback.
          setSessions((prev) =>
            prev.map((s) =>
              s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId)
                ? { ...s, displayName: prevName ?? null }
                : s,
            ),
          );
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${r.status}`);
        }
      } catch (e) {
        // Network failure: rollback + rethrow so callers can surface.
        setSessions((prev) =>
          prev.map((s) =>
            s.sessionId === sessionId || (s.aliases ?? []).includes(sessionId)
              ? { ...s, displayName: prevName ?? null }
              : s,
          ),
        );
        throw e;
      }
    },
    [],
  );

  const value = useMemo<SessionsValue>(
    () => ({ sessions, loading, refresh, deleteSession, createSession, renameSession }),
    [sessions, loading, refresh, deleteSession, createSession, renameSession],
  );

  return (
    <SessionsContext.Provider value={value}>{children}</SessionsContext.Provider>
  );
}

export function useSessions(): SessionsValue {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used inside <SessionsProvider>");
  return ctx;
}
