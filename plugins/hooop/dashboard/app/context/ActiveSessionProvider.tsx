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
import type { EventRow, TurnImage } from "@/lib/sandbox-client";
import type { SessionInfo } from "@/lib/types/session";
import { useSelectedSession } from "./SelectedSessionProvider";
import { useSessions } from "./SessionsProvider";
import { useCommands } from "./CommandsProvider";
import { myDisplayName, participantKind } from "@/app/components/lib/participant";
import { useTranscript } from "./hooks/useTranscript";
import { useSessionMeta, type SessionMeta } from "./hooks/useSessionMeta";
import { useSessionSummary, type UseSessionSummary } from "./hooks/useSessionSummary";
import { useSessionStats, type SessionStats } from "./hooks/useSessionStats";

export interface ActiveSessionValue {
  /** null when no session is selected. */
  session: SessionInfo | null;
  meta: SessionMeta;
  events: EventRow[];
  eventsLoading: boolean;
  hasMore: boolean;
  loadMore: () => Promise<void>;
  stats: SessionStats;
  summary: UseSessionSummary;
  /** True between Send and the first non-UserPromptSubmit event. */
  isWaiting: boolean;
  /** Last send error (e.g. policy reject); cleared on next successful send. */
  sendError: string | null;
  /** Surface a client-side error inline (same slot as `sendError`), without a
   * network round-trip — e.g. a malformed control command like `/auto-mode xyz`
   * that must NOT be forwarded to the model. */
  reportError: (message: string) => void;
  send: (text: string, images?: TurnImage[]) => Promise<void>;
  /** Participant-to-participant chat — broadcast to the session, never sent to
   * the model. Optional ≤512 image thumbnails. */
  chat: (text: string, images?: TurnImage[]) => Promise<void>;
  /** Interrupt the model's in-flight turn (`/stop`). */
  stop: () => Promise<void>;
  /** Switch the session's model (`/model <alias>`). Restarts the child on the
   * new model, aborting any in-flight turn. */
  setModel: (model: string) => Promise<void>;
  /** Toggle unattended auto-approval (auto mode). Effective on the next tool
   * ask; no child restart. Host / full-peer only (enforced server-side). */
  setAutoMode: (auto: boolean) => Promise<void>;
  /**
   * Direct bash execution (the `!cmd` shortcut). Goes through the sandbox's
   * dedicated bash endpoint, not the model. Errors surface via `sendError`
   * the same way `send` does so the composer can render them inline.
   */
  runBash: (command: string) => Promise<void>;
  rename: (name: string) => Promise<void>;
  remove: () => Promise<void>;
}

const ActiveSessionContext = createContext<ActiveSessionValue | null>(null);

/**
 * Translate a co-drive action failure into a message worth showing a peer.
 * The sandbox is the revocation authority, so when a peer's share has been
 * revoked or expired (it can vanish mid-session, after they already hold the
 * cookie), it answers 403 with a raw `share revoked or expired (rid=…)`
 * string. Surfacing that verbatim is noise for the guest — collapse it to a
 * plain sentence and drop the request id.
 */
function friendlySendError(status: number, raw: string | null): string {
  const msg = raw ?? `HTTP ${status}`;
  if (status === 403 && /revoked or expired/i.test(msg)) {
    return "This shared session has ended or the link was revoked. Ask the host for a fresh link.";
  }
  return msg;
}

/**
 * Hook types that represent the model producing output (or about to). Any of
 * these clears the "waiting for the answer" indicator. Everything else
 * (UserPromptSubmit echoes, SessionStart on wake, PreCompact, etc.) is
 * intentionally excluded — they fire on the wake path before the model has
 * said anything.
 */
const MODEL_OUTPUT_HOOKS = new Set([
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "Notification",
  "ToolUseConfirmation",
]);

/**
 * Composes the leaf hooks for the currently-selected session and exposes
 * the per-turn actions (send / rename / delete). Components NEVER fetch
 * `/api/events`, `/api/sessions/:id/*`, or `POST /message` directly —
 * everything routes through here so the regression guards live in one
 * place.
 */
export function ActiveSessionProvider({ children }: { children: React.ReactNode }) {
  const { selectedId, aliases, setSelected: _setSelected } = useSelectedSession();
  const { sessions, deleteSession, renameSession } = useSessions();

  const meta = useSessionMeta(selectedId, sessions, aliases);
  const transcript = useTranscript(selectedId, aliases);
  const summary = useSessionSummary(selectedId, aliases);
  const stats = useSessionStats(transcript.events, meta.session);

  const [isWaiting, setIsWaiting] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Clear waiting whenever the selection changes — a stale "thinking…"
  // dot on a freshly-selected session would be a lie.
  useEffect(() => {
    setIsWaiting(false);
    setSendError(null);
  }, [selectedId]);

  // Refs so the SSE handler captures the latest selection + aliases
  // without re-binding the subscription every alias-set change.
  const sidRef = useRef<string | null>(selectedId);
  sidRef.current = selectedId;
  const aliasesRef = useRef<readonly string[]>(aliases);
  aliasesRef.current = aliases;

  useSSE({
    event: (data) => {
      const row = data as { session_id?: string; hook_type?: string } | null;
      if (!row || !row.session_id || !row.hook_type) return;
      const sid = sidRef.current;
      if (!sid) return;
      if (row.session_id !== sid && !aliasesRef.current.includes(row.session_id)) return;
      // A user turn (from ANY participant — this client OR a peer sharing the
      // session) means the model is about to work. Show the "thinking…"
      // indicator on every connected client, not just the sender's: the local
      // sender flips it in send(), and this echo covers everyone else.
      if (row.hook_type === "UserPromptSubmit") {
        setIsWaiting(true);
        return;
      }
      // Allowlist: only clear "waiting" on events that mean the model has
      // actually started producing output. A bare denylist (clear unless
      // UserPromptSubmit) is wrong for the dormant-session wake path —
      // resuming claude fires a SessionStart hook before the model even
      // starts thinking, which used to flip the indicator off prematurely.
      if (!MODEL_OUTPUT_HOOKS.has(row.hook_type)) return;
      // NB: do NOT gate this on `waitingRef.current`. /stop (and /model) emit a
      // UserPromptSubmit command echo IMMEDIATELY followed by a synthesized Stop
      // in the same server call, which the client often receives in one SSE
      // batch. `waitingRef` only reflects the last *rendered* value, so within a
      // batch it's still stale when Stop lands — gating here let the preceding
      // UserPromptSubmit's `true` win and pinned the "thinking" indicator on
      // after a stop. Applying the clear unconditionally (React no-ops when
      // already false) makes the Stop authoritative regardless of batching.
      setIsWaiting(false);
    },
    // Stream gap (tab suspend, or a reconnect — see useSSE.ts). `isWaiting` is
    // LOCAL optimistic state that only ever clears on a live model-output frame,
    // so a Stop delivered while we were disconnected clears it never: the
    // indicator spins until the session is switched or the page reloaded.
    // Drop the optimistic bit and fall back to server truth — the exposed value
    // is `isWaiting || turnActive`, and SessionsProvider refetches on this same
    // frame, so a turn that really IS still running keeps the indicator up via
    // turnActive instead of via a local flag nothing can clear.
    resync: () => setIsWaiting(false),
  });

  // Keep pushOptimistic in a ref so `send` identity stays stable across
  // event arrivals. (transcript.pushOptimistic is stable per useCallback,
  // but transcript itself is also memoized — defending against future
  // refactors that might unmemo the return.)
  const pushOptimisticRef = useRef(transcript.pushOptimistic);
  pushOptimisticRef.current = transcript.pushOptimistic;
  const removeOptimisticRef = useRef(transcript.removeOptimistic);
  removeOptimisticRef.current = transcript.removeOptimistic;

  // Command corpus, mirrored into a ref so `send` can classify a slash-command
  // turn without re-binding on every corpus refetch. Used to seed the
  // optimistic row's `kind: "command"` so it renders as a command card
  // immediately (matching what the sandbox will stamp on the real frame) rather
  // than flashing an ordinary bubble first. See optimisticSendMeta.
  const { entries: commandEntries } = useCommands();
  const commandLabelsRef = useRef<Set<string>>(new Set());
  commandLabelsRef.current = useMemo(
    () => new Set(commandEntries.map((e) => e.label)),
    [commandEntries],
  );

  const send = useCallback(
    async (text: string, images?: TurnImage[]) => {
      const sid = sidRef.current;
      if (!sid) return;
      const hasImages = !!images && images.length > 0;
      if (!text && !hasImages) return;
      setSendError(null);
      // Seed the optimistic row's final layout so it doesn't flash the default
      // styling before the real frame reconciles. `kind` mirrors the sandbox's
      // authoritative command detection (writeUserTurn: a known slash command —
      // or the `/plan` intercept — becomes kind:"command", a command card);
      // `author` is our own participant identity so a peer's own turn renders
      // green (mine) instead of blue (theirs) from the first paint. A host has
      // no author (null → host-authored), matching the real frame.
      const commandName = /^\/([a-zA-Z][\w:-]*)/.exec(text.trimStart())?.[1] ?? null;
      const isCommand =
        commandName != null &&
        (commandName === "plan" || commandLabelsRef.current.has(commandName));
      const author = participantKind() === "peer" ? myDisplayName() : null;
      // Optimistic row: show the text, or an image marker for an image-only turn.
      const optimisticId = pushOptimisticRef.current(
        text || `🖼 ${images!.length} image${images!.length > 1 ? "s" : ""}`,
        { kind: isCommand ? "command" : null, author },
      );
      setIsWaiting(true);
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(hasImages ? { text, images } : { text }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setSendError(friendlySendError(r.status, body?.error ?? null));
          // The turn never reached the model — roll back the optimistic row so a
          // rejected message doesn't linger in the transcript.
          removeOptimisticRef.current(optimisticId);
          setIsWaiting(false);
        }
      } catch (e) {
        setSendError((e as { message?: string })?.message ?? "send failed");
        removeOptimisticRef.current(optimisticId);
        setIsWaiting(false);
      }
    },
    [],
  );

  const chat = useCallback(
    async (text: string, images?: TurnImage[]) => {
      const sid = sidRef.current;
      if (!sid) return;
      const hasImages = !!images && images.length > 0;
      if (!text.trim() && !hasImages) return;
      setSendError(null);
      // No optimistic row and no `isWaiting`: chat doesn't run the model. The
      // Chat event lands via SSE moments later, like a bash shortcut.
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(hasImages ? { text, images } : { text }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setSendError(friendlySendError(r.status, body?.error ?? null));
        }
      } catch (e) {
        setSendError((e as { message?: string })?.message ?? "chat failed");
      }
    },
    [],
  );

  const stop = useCallback(async () => {
    const sid = sidRef.current;
    if (!sid) return;
    setSendError(null);
    // Clear the local thinking indicator immediately; the model's Stop event
    // will confirm via SSE for every client.
    setIsWaiting(false);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/interrupt`, { method: "POST" });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setSendError(friendlySendError(r.status, body?.error ?? null));
      }
    } catch (e) {
      setSendError((e as { message?: string })?.message ?? "stop failed");
    }
  }, []);

  const setModel = useCallback(async (model: string) => {
    const sid = sidRef.current;
    if (!sid) return;
    const clean = model.trim();
    if (!clean) return;
    setSendError(null);
    // The switch restarts the child (like /stop), so clear the local thinking
    // indicator immediately; the synthesized Stop confirms via SSE for everyone.
    setIsWaiting(false);
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: clean }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setSendError(friendlySendError(r.status, body?.error ?? null));
      }
    } catch (e) {
      setSendError((e as { message?: string })?.message ?? "model switch failed");
    }
  }, []);

  const setAutoMode = useCallback(async (auto: boolean) => {
    const sid = sidRef.current;
    if (!sid) return;
    setSendError(null);
    // Unlike setModel this does NOT restart the child — auto mode is consumed
    // live by the sandbox on the next tool ask, so no thinking-indicator reset.
    try {
      const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/auto-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auto }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as { error?: string } | null;
        setSendError(friendlySendError(r.status, body?.error ?? null));
      }
    } catch (e) {
      setSendError((e as { message?: string })?.message ?? "auto-mode toggle failed");
    }
  }, []);

  // Synchronous inline error (no network) for client-rejected control commands.
  const reportError = useCallback((message: string) => setSendError(message), []);

  const runBash = useCallback(
    async (command: string) => {
      const sid = sidRef.current;
      if (!sid) return;
      if (!command) return;
      setSendError(null);
      // No optimistic row and no `isWaiting`: the POST returns immediately
      // (the sandbox emits a "running" BashShortcut snapshot and runs the
      // command in the background), and the transcript fills in live as
      // "running"→"done" snapshots land via SSE. Long processes no longer block.
      try {
        const r = await fetch(`/api/sessions/${encodeURIComponent(sid)}/bash`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command }),
        });
        if (!r.ok) {
          const body = (await r.json().catch(() => null)) as { error?: string } | null;
          setSendError(friendlySendError(r.status, body?.error ?? null));
        }
      } catch (e) {
        setSendError((e as { message?: string })?.message ?? "bash exec failed");
      }
    },
    [],
  );

  const rename = useCallback(
    async (name: string) => {
      const sid = sidRef.current;
      if (!sid) return;
      await renameSession(sid, name);
    },
    [renameSession],
  );

  // remove() is just a thin sugar for deleteSession(currentlySelectedId).
  // The URL-clearing concern lives inside SessionsProvider.deleteSession;
  // duplicating setSelected(null) here would mean two layers fighting
  // over the same transition.
  const remove = useCallback(async () => {
    const sid = sidRef.current;
    if (!sid) return;
    await deleteSession(sid);
  }, [deleteSession]);

  // We don't actually need setSelected on the value surface — keep the
  // destructure quiet for linters.
  void _setSelected;

  const value = useMemo<ActiveSessionValue>(
    () => ({
      session: meta.session,
      meta,
      events: transcript.events,
      eventsLoading: transcript.loading,
      hasMore: transcript.hasMore,
      loadMore: transcript.loadMore,
      stats,
      summary,
      // Show the "thinking" indicator if EITHER the local event-derived state
      // says so (fast, for clients present when the turn started) OR the
      // server's authoritative turnActive flag on the session row does (covers
      // late-joining peers, who never saw the UserPromptSubmit event).
      isWaiting: isWaiting || (meta.session?.turnActive ?? false),
      sendError,
      reportError,
      send,
      chat,
      stop,
      setModel,
      setAutoMode,
      runBash,
      rename,
      remove,
    }),
    [
      meta,
      transcript.events,
      transcript.loading,
      transcript.hasMore,
      transcript.loadMore,
      stats,
      summary,
      isWaiting,
      sendError,
      reportError,
      send,
      chat,
      stop,
      setModel,
      setAutoMode,
      runBash,
      rename,
      remove,
    ],
  );

  return (
    <ActiveSessionContext.Provider value={value}>{children}</ActiveSessionContext.Provider>
  );
}

export function useActiveSession(): ActiveSessionValue {
  const ctx = useContext(ActiveSessionContext);
  if (!ctx)
    throw new Error("useActiveSession must be used inside <ActiveSessionProvider>");
  return ctx;
}
