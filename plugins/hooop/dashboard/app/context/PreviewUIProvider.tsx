"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSelectedSession } from "./SelectedSessionProvider";
import { useSSE } from "@/app/components/useSSE";
import type { PreviewRecord, PreviewLog, PreviewSpec } from "@/lib/sandbox-types";

/**
 * Live-preview state for the selected session.
 *
 * Polling rather than pure SSE, deliberately. A preview's interesting state
 * lives in a container the sandbox only observes when asked — "which setup step
 * is running" changes continuously with no event to hang off — so the dock
 * polls while something is in flight and idles otherwise. Preview lifecycle
 * EVENTS (started/shared/failed) do arrive over the stream, and are used to
 * refetch immediately rather than wait for the next tick.
 */

interface PreviewUIValue {
  preview: PreviewRecord | null;
  slots: { total: number; used: number };
  /** False on installs whose containers predate previews. */
  available: boolean;
  /**
   * The spec this session last ran, kept after the preview is gone so the empty
   * state can offer a one-click restart instead of asking for it all again.
   */
  lastSpec: PreviewSpec | null;
  /**
   * Set only when the IDLE sweeper released the preview — never when someone
   * stopped it themselves. Drives whether the panel explains the absence.
   */
  lastStoppedReason: "idle" | null;
  loading: boolean;
  /** Set when an action failed, for display next to the buttons. */
  actionError: string | null;

  open: boolean;
  setOpen: (v: boolean) => void;

  /** Start a preview from the dashboard, so the operator need not ask the agent.
   *  Resolves true on success; on failure `actionError` carries the reason. */
  start: (spec: { name: string; run: string; setup?: string[]; workdir?: string | null }) => Promise<boolean>;
  starting: boolean;

  logs: PreviewLog[];
  logsLoading: boolean;
  loadLogs: () => Promise<void>;

  refresh: () => void;
  act: (action: "stop" | "restart" | "rebuild") => Promise<void>;
  share: () => Promise<void>;
  unshare: () => Promise<void>;
  /**
   * Mint this viewer's own link, redeeming the grant. Null when unavailable.
   *
   * Takes the id rather than reading the current preview so its identity is
   * stable across polls — a consumer keying an effect off it must not re-run
   * (and reload the iframe, losing the app's state) every refresh tick.
   */
  viewerLink: (previewId: string) => Promise<{
    url: string;
    origin: string;
    /** Redeemable tunnel link, for a new tab or to hand to someone. Null unshared. */
    publicUrl: string | null;
  } | null>;

  /**
   * Is the shared tunnel actually serving yet?
   *
   * A quick tunnel's hostname takes tens of seconds to propagate after
   * cloudflared prints it, so "shared" and "reachable" are different facts and
   * the UI has to be able to say which one it means. Null when nothing is shared.
   */
  publicReachable: boolean | null;
  /**
   * The tunnel was given up on — it never registered at all.
   *
   * Distinct from `publicReachable === false`, which used to mean both "still
   * propagating" and "stopped trying ninety seconds ago". They need different
   * words: one asks for patience, the other says the link is not coming and
   * something has to be done about it.
   */
  publicTunnelGaveUp: boolean;

  /**
   * Is the model acting inside the page right now?
   *
   * Drives the overlay that covers the iframe. It is not only an indicator: it
   * also stops a human's clicks racing the agent's, which on a stateful app
   * produces a board (or a form, or a cart) that neither of them intended.
   */
  driving: boolean;
  /**
   * Take the page back. Interrupts the turn and drops the overlay; the viewer's
   * own next click is what detaches their copy from the agent's fan-out.
   */
  takeControl: () => void;
}

const Ctx = createContext<PreviewUIValue | null>(null);

/** Poll fast while something is changing, slowly when it is settled. */
const POLL_ACTIVE_MS = 1500;
const POLL_IDLE_MS = 15000;
/**
 * How long after the agent's last action the page still counts as agent-driven.
 *
 * The gap it is allowed to leave between actions — think, then act — before the
 * humans get the page back.
 */
const DRIVING_DECAY_MS = 10_000;

export function PreviewUIProvider({ children }: { children: React.ReactNode }) {
  const { selectedId: sessionId } = useSelectedSession();
  const [preview, setPreview] = useState<PreviewRecord | null>(null);
  const [slots, setSlots] = useState({ total: 3, used: 0 });
  const [available, setAvailable] = useState(true);
  const [lastSpec, setLastSpec] = useState<PreviewSpec | null>(null);
  const [lastStoppedReason, setLastStoppedReason] = useState<"idle" | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<PreviewLog[]>([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  // The agent is "driving" for a while after each action rather than only during
  // one. A click takes milliseconds; an overlay that appeared and vanished that
  // fast would read as a glitch, and it would drop between the actions of a
  // sequence — exactly when a human must not reach in and fight it.
  const [driving, setDriving] = useState(false);
  const decayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearDecay = () => {
    if (decayRef.current) { clearTimeout(decayRef.current); decayRef.current = null; }
  };
  /**
   * Has the viewer of THIS browser taken control of their copy?
   *
   * The agent runs for the session, and "the agent is acting" is broadcast to
   * everyone in it — but the agent acts on FOLLOWING pages only. Once this
   * viewer takes control, every subsequent action is happening in somebody
   * else's window, and covering this one with "the agent is using this page"
   * is simply false: they are using it, they just took it.
   *
   * A ref, not state: markDriving reads it from inside a timer-driven callback,
   * and a stale closure here would put the overlay back over a page its owner
   * has already claimed.
   */
  const detachedRef = useRef(false);

  const markDriving = useCallback(() => {
    // Somebody else's window. Nothing to say here.
    if (detachedRef.current) return;
    setDriving(true);
    clearDecay();
    decayRef.current = setTimeout(() => setDriving(false), DRIVING_DECAY_MS);
  }, []);
  /** Somebody reached in: stop claiming the agent has the page. */
  const takeControl = useCallback(() => {
    detachedRef.current = true;
    clearDecay();
    setDriving(false);
  }, []);
  useEffect(() => clearDecay, []);

  // A different session means a different preview and a different page, so this
  // browser is not holding anything any more. In an effect rather than beside
  // the setDriving above, which runs during render: a render React discards
  // (Strict Mode, or an interrupted one) would still have mutated the ref, and
  // that silently hands the overlay back over a page somebody had taken.
  useEffect(() => { detachedRef.current = false; }, [sessionId]);

  // The other way a viewer takes control: clicking INSIDE the frame, once the
  // overlay has decayed. We cannot see that — the preview is a separate origin
  // on purpose — so the injected driver tells us. Without it the next action
  // covers a page the agent can no longer touch with "the agent is using this
  // page", over an interrupt-the-turn button, for a page the human already has.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { source?: string; type?: string } | null;
      if (d?.source !== "hooop-preview-driver") return;
      if (d.type === "detached") {
        detachedRef.current = true;
        clearDecay();
        setDriving(false);
        return;
      }
      // A fresh document, following again — the only way back in is a reload,
      // and the page announces itself when it loads. Without this the overlay
      // would stay suppressed for the rest of the session once anyone had ever
      // taken control, which is the same bug pointing the other way.
      if (d.type === "following") detachedRef.current = false;
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Switching sessions must not show the previous session's preview for even a
  // frame — the dock is session-scoped like the files dock. Adjusted during
  // render rather than in an effect so there is no frame where the old
  // session's preview is on screen under the new session's header.
  const [shownFor, setShownFor] = useState(sessionId);
  if (shownFor !== sessionId) {
    setShownFor(sessionId);
    setPreview(null);
    setLogs([]);
    setActionError(null);
    // Another session's agent driving must not put an overlay on this one's page.
    setDriving(false);
  }

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      // Derived from THIS response rather than from state: reading it back out
      // of React would give the previous tick's value and settle the poll into
      // the slow interval while setup is still running.
      let busy = false;
      try {
        const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/previews`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (cancelled) return;
        const next = (data.previews ?? [])[0] ?? null;
        busy = next?.state === "starting";
        setAvailable(data.available !== false);
        setSlots(data.slots ?? { total: 3, used: 0 });
        setPreview(next);
        setLastSpec(data.lastSpec ?? null);
        setLastStoppedReason(data.lastStoppedReason ?? null);
      } catch {
        // A transient failure must not blank a preview the user is watching.
      } finally {
        if (!cancelled) {
          setLoading(false);
          timer = setTimeout(tick, busy ? POLL_ACTIVE_MS : POLL_IDLE_MS);
        }
      }
    };

    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [sessionId, nonce]);

  // A lifecycle event is a reason to look now rather than at the next tick.
  useSSE({
    event: (row: unknown) => {
      const e = row as { hook_type?: string; session_id?: string } | null;
      if (!e?.hook_type?.startsWith("Preview")) return;
      if (e.session_id && e.session_id !== sessionId) return;
      refresh();
    },
    // The model acting inside the page. Not a poll and not an ingested event:
    // a click lands in well under the idle poll interval, and putting every one
    // of them in the transcript would bury the conversation in furniture.
    "preview-drive": (row: unknown) => {
      const d = row as { sessionId?: string } | null;
      if (!d || d.sessionId !== sessionId) return;
      markDriving();
    },
  });


  const loadLogs = useCallback(async () => {
    if (!sessionId || !preview) return;
    setLogsLoading(true);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(preview.previewId)}/logs`,
      );
      setLogs(res.ok ? (await res.json()).logs ?? [] : []);
    } catch {
      setLogs([]);
    } finally {
      setLogsLoading(false);
    }
  }, [sessionId, preview]);

  const act = useCallback(async (action: "stop" | "restart" | "rebuild") => {
    if (!sessionId || !preview) return;
    setActionError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(preview.previewId)}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body.error ?? `${action} failed`);
      }
    } catch (e) {
      setActionError(String(e));
    } finally {
      refresh();
    }
  }, [sessionId, preview, refresh]);

  const [starting, setStarting] = useState(false);
  const start = useCallback(async (spec: {
    name: string; run: string; setup?: string[]; workdir?: string | null;
  }) => {
    if (!sessionId) return false;
    setActionError(null);
    setStarting(true);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(spec),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body.error ?? "could not start the preview");
        return false;
      }
      return true;
    } catch (e) {
      setActionError(String(e));
      return false;
    } finally {
      setStarting(false);
      refresh();
    }
  }, [sessionId, refresh]);

  const share = useCallback(async () => {
    if (!sessionId || !preview) return;
    setActionError(null);
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(preview.previewId)}/share`,
        // The header is required, not decorative: parseJsonBody rejects
        // anything that isn't application/json with a 415, and fetch stamps a
        // string body as text/plain by default — so omitting it made every
        // share fail with "Content-Type must be application/json".
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: preview.slot }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setActionError(body.error ?? "could not share the preview");
      }
    } catch (e) {
      setActionError(String(e));
    } finally {
      refresh();
    }
  }, [sessionId, preview, refresh]);

  const unshare = useCallback(async () => {
    if (!sessionId || !preview) return;
    setActionError(null);
    try {
      await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(preview.previewId)}/share`,
        // Same route, same 415 — see share() above.
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: preview.slot, unshare: true }),
        },
      );
    } catch (e) {
      setActionError(String(e));
    } finally {
      refresh();
    }
  }, [sessionId, preview, refresh]);

  const viewerLink = useCallback(async (previewId: string) => {
    if (!sessionId || !previewId) return null;
    try {
      const res = await fetch(
        `/api/sessions/${encodeURIComponent(sessionId)}/previews/${encodeURIComponent(previewId)}/link`,
      );
      if (!res.ok) return null;
      const data = await res.json();
      return {
        url: data.url as string,
        origin: data.origin as string,
        publicUrl: (data.publicUrl ?? null) as string | null,
      };
    } catch {
      return null;
    }
  }, [sessionId]);

  // Poll the front process for tunnel propagation while a share is waiting on it.
  // Host-only (the endpoint is), and only while shared-but-not-yet-reachable, so
  // it stops on its own the moment the answer settles.
  const [publicReachable, setPublicReachable] = useState<boolean | null>(null);
  const [publicTunnelGaveUp, setPublicTunnelGaveUp] = useState(false);
  const shareSlot = preview?.publicUrl ? preview.slot : null;
  useEffect(() => {
    if (shareSlot == null) { setPublicReachable(null); setPublicTunnelGaveUp(false); return; }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const res = await fetch(`/api/preview-tunnel?slot=${shareSlot}`);
        if (cancelled) return;
        // A peer gets 403 here; treat "cannot know" as "do not claim", not as
        // "unreachable" — otherwise the panel would nag them about a tunnel
        // they are already successfully looking at.
        if (!res.ok) { setPublicReachable(null); return; }
        const data = await res.json();
        setPublicReachable(!!data.reachable);
        setPublicTunnelGaveUp(!data.reachable && data.probing === false);
        // Only while it might still change. Polling a settled answer every three
        // seconds forever was the mechanism by which the panel kept insisting a
        // dead link was on its way.
        if (!data.reachable && data.probing !== false) timer = setTimeout(tick, 3000);
      } catch {
        if (!cancelled) setPublicReachable(null);
      }
    };
    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [shareSlot]);

  // Opening is automatic the first time a session's preview appears, so the
  // agent saying "it's running" is immediately backed by something on screen.
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (preview && seen.current !== preview.previewId) {
      seen.current = preview.previewId;
      setOpen(true);
    }
    if (!preview) seen.current = null;
  }, [preview]);

  const value = useMemo<PreviewUIValue>(() => ({
    preview, slots, available, loading, actionError, lastSpec, lastStoppedReason,
    // Deliberately NOT `open && !!preview`. The rail's globe is permanent now,
    // so "open" has to be able to mean "the browser panel is showing" even when
    // no app is running — that is the panel that explains there is nothing to
    // show. Gating it on a preview existing made the always-visible control a
    // no-op in exactly the case a first-time user clicks it. The dock renders
    // its own empty state; consumers must not assume `open` implies `preview`.
    open, setOpen,
    start, starting,
    logs, logsLoading, loadLogs,
    refresh, act, share, unshare, viewerLink, publicReachable, publicTunnelGaveUp,
    driving, takeControl,
  }), [preview, slots, available, loading, actionError, lastSpec, lastStoppedReason, open, start, starting, logs, logsLoading, loadLogs, refresh, act, share, unshare, viewerLink, publicReachable, publicTunnelGaveUp, driving, takeControl]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePreviewUI(): PreviewUIValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePreviewUI must be used inside a PreviewUIProvider");
  return v;
}
