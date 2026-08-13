"use client";
import { useEffect, useRef } from "react";

// Live event channel. Despite the name, the transport is a WebSocket (`/api/ws`),
// not Server-Sent Events: SSE is buffered to death by Cloudflare quick tunnels
// (the whole `text/event-stream` response is held and never flushed), so a
// remote co-driving peer never received live events. WebSockets are an upgrade
// protocol, not a buffered HTTP response, and pass through CF tunnels live.
//
// The public API is unchanged — `useSSE({ <type>: handler })` — so every
// consumer (transcript, presence, selection, …) is untouched. The server sends
// `{ type, data }` JSON frames; we dispatch `data` to the handlers registered
// for that `type`.

type Handler = (data: unknown) => void;
type Handlers = Record<string, Handler>;

let socket: WebSocket | null = null;
const handlersByType = new Map<string, Set<Handler>>();
let refCount = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let backoff = 250;
let closedByUs = false;
// Has a socket ever been open? Distinguishes the FIRST connect (consumers just
// mounted and fetched their own initial state — nothing to backfill) from a
// RE-connect (there is a gap, and every frame in it is gone for good).
let everConnected = false;

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/ws`;
}

function dispatch(type: string, data: unknown) {
  const set = handlersByType.get(type);
  if (!set || set.size === 0) return;
  for (const h of set) {
    try { h(data); } catch { /* a bad handler must not kill the socket */ }
  }
}

function connect() {
  if (socket || closedByUs) return;
  let ws: WebSocket;
  try { ws = new WebSocket(wsUrl()); } catch { scheduleReconnect(); return; }
  socket = ws;

  ws.onopen = () => {
    backoff = 250;
    // A RE-connect means frames were dropped while we were down, and the stream
    // only ever delivers forward — so consumers must backfill exactly as they do
    // after a mobile tab suspend. Previously `resync` fired ONLY from
    // onForeground (visibility/focus/online), which never runs when the socket
    // dies under a tab that stays in the foreground the whole time: the sandbox
    // container being recreated (`hooop rebuild`), a server restart, a brief
    // network blip. Anything that landed in that window — including a turn's
    // terminating Stop — was lost with no path to recover it, which is how the
    // "thinking" indicator and the ctx meter got stuck until a manual reload.
    if (everConnected) dispatch("resync", { source: "reconnect" });
    everConnected = true;
  };
  ws.onmessage = (e) => {
    let frame: { type?: string; data?: unknown };
    try { frame = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
    if (frame && typeof frame.type === "string") dispatch(frame.type, frame.data);
  };
  ws.onclose = (e) => {
    if (socket === ws) socket = null;
    // 4403 = the server cut this feed because the credential behind it was
    // revoked. Stop reconnecting (a revoked grant can't re-open the channel) and
    // tell the UI so it can take over with an "access ended" state.
    //
    // The close REASON matters now: it is "share revoked" for a guest, and
    // "device revoked" for the host on one of their own enrolled devices. Those
    // two people need different sentences — telling the host to ask the host for
    // a fresh link is nonsense — so pass it through rather than assuming.
    if (e.code === 4403) {
      closedByUs = true;
      dispatch("revoked", { reason: e.reason || "share revoked" });
      return;
    }
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch { /* ignore */ } };
}

function scheduleReconnect() {
  if (closedByUs || refCount <= 0 || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoff);
  backoff = Math.min(backoff * 2, 5000);
}

// Foreground resync. Mobile browsers suspend a backgrounded tab: its WebSocket
// can be silently killed (or left a half-open zombie) and its JS timers frozen,
// so the `onclose`→reconnect path may never run and live frames simply stop
// arriving. When the tab returns to the foreground (or the window regains focus,
// or the network comes back) we (a) force an immediate reconnect if the socket
// isn't cleanly OPEN, and (b) tell consumers to backfill whatever they missed
// during the gap via a synthetic `resync` frame (SSE only delivers events going
// forward, so a reconnect alone can't recover the ones dropped while suspended).
function onForeground(source: string) {
  if (closedByUs || refCount <= 0) return;
  const healthy = socket ? socket.readyState === WebSocket.OPEN : false;
  if (!healthy) {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const dead = socket;
    socket = null;
    if (dead) { try { dead.close(); } catch { /* ignore */ } }
    backoff = 250;
    connect();
  }
  dispatch("resync", { source });
}

let foregroundBound = false;
function onVisibility() { if (document.visibilityState === "visible") onForeground("visibility"); }
function onFocus() { onForeground("focus"); }
function onOnline() { onForeground("online"); }

function bindForeground() {
  if (foregroundBound || typeof window === "undefined") return;
  foregroundBound = true;
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onOnline);
}

function unbindForeground() {
  if (!foregroundBound || typeof window === "undefined") return;
  foregroundBound = false;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("focus", onFocus);
  window.removeEventListener("online", onOnline);
}

function teardown() {
  closedByUs = true;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const s = socket;
  socket = null;
  if (s) { try { s.close(); } catch { /* ignore */ } }
  handlersByType.clear();
  unbindForeground();
}

function subscribe(type: string, h: Handler) {
  let set = handlersByType.get(type);
  if (!set) { set = new Set(); handlersByType.set(type, set); }
  set.add(h);
}

function unsubscribe(type: string, h: Handler) {
  const set = handlersByType.get(type);
  if (!set) return;
  set.delete(h);
  if (set.size === 0) handlersByType.delete(type);
}

/**
 * Shared live-channel hook. Multiple components mount/unmount independently but
 * share one WebSocket; it reconnects with backoff and closes when the last
 * subscriber unmounts.
 */
export function useSSE(handlers: Handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    closedByUs = false;
    refCount += 1;
    connect();
    bindForeground();

    const bound: Array<[string, Handler]> = [];
    for (const type of Object.keys(handlersRef.current)) {
      const h: Handler = (data) => handlersRef.current[type]?.(data);
      subscribe(type, h);
      bound.push([type, h]);
    }

    return () => {
      for (const [t, h] of bound) unsubscribe(t, h);
      refCount -= 1;
      if (refCount <= 0) {
        refCount = 0;
        teardown();
      }
    };
  }, []);
}
