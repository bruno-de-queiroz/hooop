"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

/**
 * Web-notification enrolment + per-viewer mute state.
 *
 * One provider rather than a hook per surface because two places read the same
 * state — the bell in the session header (mute this session) and the switch in
 * settings (enrol / mute everything). Fetching independently would let them
 * disagree the moment either one toggled.
 *
 * The sandbox is authoritative for mutes; this keeps an optimistic local copy so
 * the toggle responds immediately, and rolls back if the write fails.
 */

export type PushState =
  /** No service worker / PushManager, or an insecure origin. */
  | "unsupported"
  /** The user blocked notifications at the browser level; we can't re-ask. */
  | "denied"
  /** Supported and permitted, but this browser isn't subscribed. */
  | "off"
  /** Subscribed — notifications will arrive. */
  | "on"
  | "busy";

export interface NotificationsValue {
  state: PushState;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  /** True when this viewer has muted everything. */
  globalMuted: boolean;
  /** Is this specific session muted (directly or by the global mute)? */
  isMuted: (sessionId: string | null | undefined) => boolean;
  setSessionMuted: (sessionId: string, muted: boolean) => Promise<void>;
  setGlobalMuted: (muted: boolean) => Promise<void>;
  /** Last failure, for surfacing why enrolment didn't take. */
  error: string | null;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

/**
 * The VAPID key travels as base64url text but `pushManager.subscribe` wants raw
 * bytes. Standard conversion — pad back to a multiple of 4 and swap the URL-safe
 * alphabet before decoding.
 */
function vapidKeyToBytes(base64Url: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  // Returned as the ArrayBuffer rather than the view: `applicationServerKey`
  // takes a BufferSource, and a bare Uint8Array no longer satisfies it since TS
  // began distinguishing ArrayBuffer from SharedArrayBuffer backing stores.
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return buf;
}

/**
 * Some Chromium rebuilds ship without a working push-service backend and
 * `pushManager.subscribe` just hangs forever instead of rejecting — leaving
 * the toggle stuck on "busy" with no way to know why. Give the post-permission
 * steps a hard deadline so a dead browser API surfaces as an error instead.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window &&
    // Push requires a secure context. localhost counts; a plain-http tunnel
    // would not, which is worth failing clearly rather than mysteriously.
    window.isSecureContext
  );
}

export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PushState>("unsupported");
  const [globalMuted, setGlobalMutedState] = useState(false);
  const [mutedSessions, setMutedSessions] = useState<ReadonlySet<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);

  // Resolve the current state without prompting: an existing subscription means
  // this browser already enrolled (subscriptions outlive a reload).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!pushSupported()) return setState("unsupported");
      if (Notification.permission === "denied") return setState("denied");
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        if (!cancelled) setState(sub ? "on" : "off");
      } catch {
        if (!cancelled) setState("off");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Mutes are per-participant and live sandbox-side, so they follow the viewer
  // across devices rather than being a local preference.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/push/mute");
        if (!res.ok) return;
        const body = (await res.json()) as { global?: boolean; sessions?: string[] };
        if (cancelled) return;
        setGlobalMutedState(!!body.global);
        setMutedSessions(new Set(body.sessions ?? []));
      } catch { /* leave defaults — muting is not load-bearing for the page */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // NOTE: "don't notify me about the session I'm looking at" is NOT handled
  // here. It rides the existing presence heartbeat (usePresence → /api/presence),
  // which already reports document.visibilityState every ~10s and is what dims
  // an away avatar. That route relays the beat to the sandbox, which owns the
  // suppression decision. A second keepalive from this provider would be two
  // timers answering the same question with timings that could disagree.

  const enable = useCallback(async () => {
    setError(null);
    if (!pushSupported()) { setState("unsupported"); return; }
    setState("busy");
    try {
      // Must be called from a user gesture; the caller wires this to a click.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "off");
        return;
      }
      // Each step gets its own timeout and message rather than one wrapping the
      // whole sequence: "the server didn't respond" and "this browser's push
      // backend is broken" need different fixes, and a single blanket timeout
      // can't tell them apart.
      const reg = await withTimeout(
        navigator.serviceWorker.register("/sw.js"),
        5_000,
        "Registering the service worker timed out.",
      );
      // A freshly registered worker may still be installing; subscribing before
      // it's active throws.
      await withTimeout(
        navigator.serviceWorker.ready,
        5_000,
        "The service worker never became active.",
      );

      const keyRes = await withTimeout(
        fetch("/api/push/key"),
        5_000,
        "Fetching the notification key timed out — the server may be unreachable.",
      );
      if (!keyRes.ok) throw new Error("could not fetch the notification key");
      const { publicKey } = (await keyRes.json()) as { publicKey: string };

      const sub = await withTimeout(
        (async () =>
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({
            // Required by Chrome: every push must result in a visible notification.
            userVisibleOnly: true,
            applicationServerKey: vapidKeyToBytes(publicKey),
          })))(),
        8_000,
        "This browser's push service didn't respond — it may not support Web Push. Try a different browser, like Chrome or Firefox.",
      );

      const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
      const res = await withTimeout(
        fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }),
        }),
        5_000,
        "Saving the subscription timed out — the server may be unreachable.",
      );
      if (!res.ok) throw new Error("the sandbox rejected the subscription");
      setState("on");
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not enable notifications");
      setState("off");
    }
  }, []);

  const disable = useCallback(async () => {
    setError(null);
    setState("busy");
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        // Tell the sandbox first: if the local unsubscribe succeeded but the
        // server still held the row, it would keep sending to a dead endpoint.
        await fetch("/api/push/subscribe", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setState("off");
    } catch {
      setState("off");
    }
  }, []);

  const writeMute = useCallback(async (sessionId: string | null, muted: boolean) => {
    const res = await fetch("/api/push/mute", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId, muted }),
    });
    if (!res.ok) throw new Error("could not save that preference");
  }, []);

  const setSessionMuted = useCallback(async (sessionId: string, muted: boolean) => {
    const prev = mutedSessions;
    const next = new Set(prev);
    if (muted) next.add(sessionId); else next.delete(sessionId);
    setMutedSessions(next);
    try {
      await writeMute(sessionId, muted);
    } catch (e) {
      setMutedSessions(prev); // roll back so the UI never lies about what's saved
      setError(e instanceof Error ? e.message : "could not save that preference");
    }
  }, [mutedSessions, writeMute]);

  const setGlobalMuted = useCallback(async (muted: boolean) => {
    const prev = globalMuted;
    setGlobalMutedState(muted);
    try {
      await writeMute(null, muted);
    } catch (e) {
      setGlobalMutedState(prev);
      setError(e instanceof Error ? e.message : "could not save that preference");
    }
  }, [globalMuted, writeMute]);

  const isMuted = useCallback(
    (sessionId: string | null | undefined) =>
      globalMuted || (!!sessionId && mutedSessions.has(sessionId)),
    [globalMuted, mutedSessions],
  );

  const value = useMemo<NotificationsValue>(
    () => ({ state, enable, disable, globalMuted, isMuted, setSessionMuted, setGlobalMuted, error }),
    [state, enable, disable, globalMuted, isMuted, setSessionMuted, setGlobalMuted, error],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

/** Tolerates use outside the provider (isolated tests) by reporting "off". */
export function useNotifications(): NotificationsValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) {
    return {
      state: "unsupported",
      enable: async () => {},
      disable: async () => {},
      globalMuted: false,
      isMuted: () => false,
      setSessionMuted: async () => {},
      setGlobalMuted: async () => {},
      error: null,
    };
  }
  return ctx;
}
