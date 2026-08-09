import { EventEmitter } from "node:events";
import { deriveHandles } from "@shared/handles";

/**
 * Ephemeral, dashboard-local presence registry for shared sessions: who is
 * currently viewing a session and whether they're typing. Not durable, not in
 * the sandbox (it's UI awareness, not security state).
 *
 * Stashed on globalThis for the same reason the sandbox client is (Next
 * standalone can load a module in more than one graph; a plain module-level
 * singleton would not be shared between the /api/presence and /api/stream route
 * modules, and presence would silently never update).
 */

export interface PresenceEntry {
  participantId: string;        // "host" or a share id
  name: string;
  kind: "host" | "peer";
  typing: boolean;
  lastSeen: number;
  // Whether the viewer's tab is currently in the FOREGROUND. The client reports
  // this (from document.visibilityState, which flips instantly on
  // visibilitychange — before a backgrounded tab's timers get throttled). A
  // backgrounded-but-connected peer sets this false → shown as `away` (dimmed
  // avatar), never as "left".
  active: boolean;
  // When `typing` last went truthy (ms epoch), or 0 when not typing. Used to
  // auto-expire the typing flag independently of the whole-entry TTL — see
  // TYPING_TTL_MS. Not surfaced to clients (stripped in listPresence).
  typingSince: number;
}

interface PresenceState {
  bus: EventEmitter;
  // sessionId -> participantId -> entry
  bySession: Map<string, Map<string, PresenceEntry>>;
}

// A peer whose heartbeat hasn't been seen for this long (or who has reported
// its tab inactive) is shown as `away` — a DIMMED avatar, not a departure. A
// couple of missed 10s beats (backgrounded tab throttling its interval) is
// enough to dim; nothing durable happens.
const IDLE_MS = 25_000;
// Roster eviction backstop: an entry that stops beating entirely is silently
// dropped from the roster after this window (avatar disappears). This is NOT a
// departure — no "left" marker is emitted. A durable "left" has exactly ONE
// source: the explicit "Leave session" route. A merely backgrounded or
// disconnected peer just dims and, eventually, drops from the roster silently.
const EVICT_MS = 3 * 60_000;
// The `typing` flag expires on its own, much sooner than the whole entry. A
// client asserts typing:true on keystrokes and is supposed to send false when
// idle — but a backgrounded tab or dropped request can lose that false, which
// used to leave "X is typing…" stuck for up to the full 30s entry TTL. Reporting
// typing:false once the assertion is older than this window makes the indicator
// self-heal regardless. Comfortably longer than the composer's ~3s idle reset
// and shorter than the 10s heartbeat, so an actively-typing client (which
// re-asserts on each keystroke) never flickers.
const TYPING_TTL_MS = 6_000;

function state(): PresenceState {
  const g = globalThis as unknown as { __hooop_presence__?: PresenceState };
  if (!g.__hooop_presence__) {
    const bus = new EventEmitter();
    bus.setMaxListeners(100);
    g.__hooop_presence__ = { bus, bySession: new Map() };
  }
  return g.__hooop_presence__;
}

export function presenceBus(): EventEmitter {
  return state().bus;
}

function evictStale(map: Map<string, PresenceEntry>): void {
  const now = Date.now();
  for (const [id, e] of map) {
    if (now - e.lastSeen > EVICT_MS) map.delete(id);
  }
}

/** Record/refresh a participant's presence on a session and notify listeners. */
export function heartbeat(opts: {
  sessionId: string;
  participantId: string;
  name: string;
  kind: "host" | "peer";
  typing?: boolean;
  /** Whether the viewer's tab is in the foreground. Absent → treated as active
   * (back-compat: an older client that never reports this is assumed present). */
  active?: boolean;
}): void {
  const s = state();
  let map = s.bySession.get(opts.sessionId);
  if (!map) {
    map = new Map();
    s.bySession.set(opts.sessionId, map);
  }
  const now = Date.now();
  const typing = !!opts.typing;
  const active = opts.active !== false;
  // Refresh typingSince on every truthy assertion. The client re-asserts
  // typing:true on a keepalive interval shorter than TYPING_TTL_MS while the
  // user is actively typing, so this stays fresh during a long burst and goes
  // stale within the TTL once assertions stop (idle, tab backgrounded, dropped
  // request) — see listPresence.
  map.set(opts.participantId, {
    participantId: opts.participantId,
    name: opts.name,
    kind: opts.kind,
    typing,
    lastSeen: now,
    active,
    typingSince: typing ? now : 0,
  });
  evictStale(map);
  s.bus.emit("change", { sessionId: opts.sessionId });
}

/**
 * Explicitly drop a participant from the roster (e.g. tab close / navigate
 * away) and notify. This is a ROSTER-only operation — it never emits a "left"
 * marker. A durable "left" has exactly ONE source: the explicit "Leave session"
 * route, which emits its own marker immediately (and clears the peer's cookie).
 * A peer that merely closes a tab or backgrounds it just dims (away) and,
 * eventually, drops from the roster silently — no transcript marker.
 */
export function leave(sessionId: string, participantId: string): void {
  const s = state();
  const map = s.bySession.get(sessionId);
  const removed = map?.delete(participantId) ?? false;
  if (removed) s.bus.emit("change", { sessionId });
}

/** Current participants on a session, each tagged with `away` (dim the avatar:
 * the peer's tab is backgrounded or its heartbeat is stale, but it is NOT
 * gone). The `typing` flag is independently expired at TYPING_TTL_MS so a lost
 * `typing:false` can't leave an indicator stuck for the whole entry TTL. */
export function listPresence(
  sessionId: string,
): Array<PresenceEntry & { away: boolean; handle: string }> {
  const map = state().bySession.get(sessionId);
  if (!map) return [];
  evictStale(map);
  const now = Date.now();
  const rows = [...map.values()]
    .map((e) => ({
      ...e,
      typing: e.typing && e.typingSince > 0 && now - e.typingSince <= TYPING_TTL_MS,
      // Peers only: a backgrounded (inactive) or stale-heartbeat peer is shown
      // dimmed. Hosts are never dimmed (their idleness isn't surfaced).
      away: e.kind === "peer" && (!e.active || now - e.lastSeen > IDLE_MS),
    }))
    .sort((a, b) => a.participantId.localeCompare(b.participantId));
  // Derived AFTER the sort, never before: deriveHandles disambiguates
  // collisions positionally, so two participants with the same display name
  // would swap handles between frames under any unstable order — and an
  // `@mention` typed against one frame would then resolve to the other person.
  const handles = deriveHandles(rows.map((r) => r.name));
  return rows.map((r, i) => ({ ...r, handle: handles[i] }));
}
