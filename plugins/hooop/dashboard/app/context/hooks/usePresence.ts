"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSSE } from "@/app/components/useSSE";
import { myDisplayName } from "@/app/components/lib/participant";

export interface PresenceParticipant {
  participantId: string;
  name: string;
  kind: "host" | "peer";
  typing: boolean;
  lastSeen: number;
  /** Tab backgrounded or heartbeat stale — render the avatar dimmed. Never
   * means "left" (that's a durable transcript marker, not a presence state). */
  away?: boolean;
  /** Slug for `@mention` (see @shared/handles). Derived server-side from the
   * ordered roster so collisions are disambiguated consistently for everyone;
   * absent from an older frame, which just means that peer isn't mentionable
   * yet rather than that the roster is broken. */
  handle?: string;
}

const HEARTBEAT_MS = 10_000;
// While actively typing, re-assert typing:true on this cadence so the server's
// typing flag (which expires at TYPING_TTL_MS ≈ 6s) stays fresh through a long
// burst — the composer only signals the 0→1 transition once, so without a
// keepalive the flag would lapse between 10s heartbeats. Must be < TYPING_TTL_MS
// so one dropped keepalive is tolerated.
const TYPING_KEEPALIVE_MS = 3_000;

/**
 * Announces this viewer's presence on the selected session (heartbeat every
 * 10s + on typing changes) and tracks everyone else's via the `presence` SSE
 * event. Returns the live participant list and a `setTyping` signal.
 */
export function usePresence(sessionId: string | null): {
  participants: PresenceParticipant[];
  setTyping: (typing: boolean) => void;
  /** This viewer's own participant id ("host" or "peer:<shareId>"), learned
   *  from the first heartbeat response. Only the browser's cookie can say which
   *  peer it is, so the server has to tell us; used to find our own row (and
   *  therefore our own `@handle`) without matching on a display name. */
  me: string | null;
} {
  const [participants, setParticipants] = useState<PresenceParticipant[]>([]);
  const [me, setMe] = useState<string | null>(null);
  const typingRef = useRef(false);
  const typingKeepaliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The roster's single source of truth is the SSE `presence` frame — the
  // server emits one on every heartbeat/typing change and broadcasts it to all
  // viewers (including this one). We deliberately do NOT setParticipants from
  // our own POST responses: a slow heartbeat response could resolve after a
  // fresher SSE frame and overwrite it with stale data (visible as a flicker).
  useSSE({
    presence: (data) => {
      const p = data as { sessionId?: string; participants?: PresenceParticipant[] };
      if (!sessionId || p?.sessionId !== sessionId) return;
      setParticipants(p.participants ?? []);
    },
  });

  // Fire-and-forget presence write. Never touches participant state (see above).
  // Stable identity (refs/args only) so `setTyping` below can be a stable
  // useCallback — consumers memoize on it (e.g. ShellComposer).
  const post = useCallback((sid: string, typing: boolean) => {
    // "Active" has to mean LOOKING AT IT, which is visible AND focused.
    //
    // visibilityState alone was wrong in the case that matters most: an
    // installed PWA (or any window) sitting open behind other windows stays
    // `visible` forever, so the viewer counted as present indefinitely. Presence
    // suppresses push — the sandbox skips notifying anyone it believes is
    // watching — so a hooop window left open in the background silently disabled
    // every notification for that session, and the only way to receive one was
    // to minimise the app. Reported exactly that way: "the presence is always
    // active even when I'm not looking at the screen, should I minimize?"
    //
    // The suppression itself is right; the signal feeding it was too generous.
    // `hasFocus()` is what distinguishes a window you are using from one that
    // merely exists on screen behind your editor.
    const active = typeof document === "undefined"
      || (document.visibilityState === "visible" && document.hasFocus());
    fetch("/api/presence", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sid, name: myDisplayName(), typing, active }),
    })
      // Only `me` is taken from this response, never the roster — see above.
      // Identity can't go stale the way a participant list can: it is fixed for
      // the life of the tab, so a late reply can't overwrite anything fresher.
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { me?: string } | null) => {
        if (typeof b?.me === "string") setMe(b.me);
      })
      .catch(() => { /* transient */ });
  }, []);

  const stopKeepalive = useCallback(() => {
    if (typingKeepaliveRef.current) {
      clearInterval(typingKeepaliveRef.current);
      typingKeepaliveRef.current = null;
    }
  }, []);

  useEffect(() => {
    // New session: reset typing so a stale `true` from the previous session
    // doesn't make our first heartbeat here assert typing (and so the composer's
    // dedup, reset in parallel, can re-trigger).
    typingRef.current = false;
    stopKeepalive();

    if (!sessionId) {
      setParticipants([]);
      return;
    }
    const sid = sessionId;
    const beat = () => post(sid, typingRef.current);

    beat();
    const iv = setInterval(beat, HEARTBEAT_MS);

    // Beat immediately on foreground/background flips so the `away` (dimmed)
    // state updates at once instead of waiting up to a full (possibly
    // throttled) heartbeat interval. Focus changes count for the same reason and
    // matter more: alt-tabbing away should start letting notifications through
    // within a second, not up to ten.
    const onVisibility = () => beat();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onVisibility);
    window.addEventListener("blur", onVisibility);

    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onVisibility);
      window.removeEventListener("blur", onVisibility);
      stopKeepalive();
      // Best-effort leave so the others see us drop promptly.
      try {
        fetch("/api/presence", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionId: sid, leaving: true }),
          keepalive: true,
        }).catch(() => {});
      } catch { /* ignore */ }
    };
  }, [sessionId]);

  const setTyping = useCallback(
    (typing: boolean) => {
      if (typingRef.current === typing) return;
      typingRef.current = typing;
      if (!sessionId) return;
      const sid = sessionId;
      // Propagate the transition immediately.
      post(sid, typing);
      // While typing, re-assert on a keepalive so the server flag (TTL ≈ 6s)
      // survives a long burst; the composer only signals the 0→1 edge once.
      if (typing) {
        stopKeepalive();
        typingKeepaliveRef.current = setInterval(() => {
          if (typingRef.current) post(sid, true);
          else stopKeepalive();
        }, TYPING_KEEPALIVE_MS);
      } else {
        stopKeepalive();
      }
    },
    [sessionId, post, stopKeepalive],
  );

  return { participants, setTyping, me };
}
