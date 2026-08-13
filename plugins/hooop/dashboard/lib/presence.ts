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
  /**
   * Which SCREEN this beat came from — one browser tab, not one person.
   *
   * The roster is a list of people, but the thing that beats is a tab, and one
   * person now routinely has several: the host on their laptop and their phone
   * (an enrolled device beats as `host` from both), a peer who re-opened their
   * link on a second device (same share id, so the same participantId), or
   * simply somebody with two tabs open. Keyed by participantId alone, those
   * collapsed into one slot and fought: the backgrounded phone reported
   * `active:false` and dimmed the laptop, and each tab's `typing:false`
   * cancelled the other's `typing:true`.
   *
   * So entries are stored per viewer and AGGREGATED into one roster row per
   * participantId (see listPresence). Identity stays exactly as coarse as it was
   * — one person, one row, one `@handle` — while liveness gets counted per
   * screen, which is where it actually happens.
   */
  viewerId: string;
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
  // sessionId -> viewerKey -> entry, where viewerKey is participantId + viewerId
  // (see viewerKey below). One entry per screen; one ROSTER ROW per participant.
  bySession: Map<string, Map<string, PresenceEntry>>;
}

/** Single-screen fallback for a client that doesn't report a viewer id. Behaves
 *  exactly like the old one-entry-per-participant registry did, so an older tab
 *  still shows up (it just can't be told apart from another of its own). */
const DEFAULT_VIEWER = "-";

/** Map key. The separator is a NUL so it can't occur in either half — a share id
 *  is a uuid and a viewer id is random hex, but a key scheme that only works
 *  because of what today's inputs happen to look like is a bug waiting for a
 *  rename. */
function viewerKey(participantId: string, viewerId: string): string {
  return `${participantId}\u0000${viewerId}`;
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

/** Record/refresh ONE SCREEN's presence on a session and notify listeners. Other
 *  screens belonging to the same participant are left alone — that is the point
 *  (see PresenceEntry.viewerId). */
export function heartbeat(opts: {
  sessionId: string;
  participantId: string;
  /** This tab. Absent → a single shared slot, i.e. the old behaviour. */
  viewerId?: string;
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
  const viewerId = opts.viewerId || DEFAULT_VIEWER;
  map.set(viewerKey(opts.participantId, viewerId), {
    participantId: opts.participantId,
    viewerId,
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
 * Explicitly drop ONE SCREEN from the roster (e.g. tab close / navigate away)
 * and notify. This is a ROSTER-only operation — it never emits a "left" marker.
 * A durable "left" has exactly ONE source: the explicit "Leave session" route,
 * which emits its own marker immediately (and clears the peer's cookie). A peer
 * that merely closes a tab or backgrounds it just dims (away) and, eventually,
 * drops from the roster silently — no transcript marker.
 *
 * Returns `gone: true` only when that was the participant's LAST screen. Callers
 * that announce a departure must gate on it: closing the tab on your phone while
 * your laptop is still open is not leaving, and saying so in the transcript would
 * be telling the room something untrue.
 *
 * Omitting `viewerId` drops every screen for that participant. That is the right
 * default for a caller acting on the identity (a revoked share) rather than on a
 * tab, and it is also what an older client that reports no viewer id gets.
 */
export function leave(
  sessionId: string,
  participantId: string,
  viewerId?: string,
): { gone: boolean } {
  const s = state();
  const map = s.bySession.get(sessionId);
  if (!map) return { gone: true };
  let removed = false;
  if (viewerId) {
    removed = map.delete(viewerKey(participantId, viewerId));
  } else {
    for (const [key, e] of map) {
      if (e.participantId === participantId) {
        map.delete(key);
        removed = true;
      }
    }
  }
  if (removed) s.bus.emit("change", { sessionId });
  // Count what's LEFT for this participant, after the removal and after evicting
  // corpses — a dead tab that never beat again must not keep somebody's departure
  // silent for the full eviction window.
  evictStale(map);
  let remaining = 0;
  for (const e of map.values()) if (e.participantId === participantId) remaining++;
  return { gone: remaining === 0 };
}

/**
 * Current PEOPLE on a session — one row per participant, whatever number of
 * screens they are watching from.
 *
 * Each row is tagged with `away` (dim the avatar: every one of their tabs is
 * backgrounded or stale, but they are NOT gone) and `viewers` (how many screens,
 * so the UI can say "also on their phone"). The `typing` flag is independently
 * expired at TYPING_TTL_MS so a lost `typing:false` can't leave an indicator
 * stuck for the whole entry TTL.
 *
 * Aggregation is deliberately optimistic on liveness — typing if ANY screen is
 * typing, present if ANY screen is present. The pessimistic reading would let a
 * forgotten background tab speak for a person who is right there, which is the
 * exact bug that made one shared slot per participant unworkable.
 */
export function listPresence(
  sessionId: string,
): Array<Omit<PresenceEntry, "viewerId" | "typingSince"> & { away: boolean; handle: string; viewers: number }> {
  const map = state().bySession.get(sessionId);
  if (!map) return [];
  evictStale(map);
  const now = Date.now();

  // Fold the per-screen entries into one row per participant.
  const byParticipant = new Map<string, PresenceEntry[]>();
  for (const e of map.values()) {
    const list = byParticipant.get(e.participantId);
    if (list) list.push(e);
    else byParticipant.set(e.participantId, [e]);
  }

  const rows = [...byParticipant.entries()]
    .map(([participantId, screens]) => {
      // Freshest screen wins the display name. They should agree, but a tab left
      // open from before a rename would otherwise get a vote on what somebody is
      // called purely by being first in the map.
      const freshest = screens.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a));
      const lastSeen = Math.max(...screens.map((e) => e.lastSeen));
      const typing = screens.some(
        (e) => e.typing && e.typingSince > 0 && now - e.typingSince <= TYPING_TTL_MS,
      );
      const present = screens.some((e) => e.active && now - e.lastSeen <= IDLE_MS);
      return {
        participantId,
        name: freshest.name,
        kind: freshest.kind,
        typing,
        lastSeen,
        active: screens.some((e) => e.active),
        // Peers only: a peer with no live foreground screen is shown dimmed.
        // Hosts are never dimmed (their idleness isn't surfaced).
        away: freshest.kind === "peer" && !present,
        viewers: screens.length,
      };
    })
    .sort((a, b) => a.participantId.localeCompare(b.participantId));
  // Derived AFTER the sort, never before: deriveHandles disambiguates
  // collisions positionally, so two participants with the same display name
  // would swap handles between frames under any unstable order — and an
  // `@mention` typed against one frame would then resolve to the other person.
  const handles = deriveHandles(rows.map((r) => r.name));
  return rows.map((r, i) => ({ ...r, handle: handles[i] }));
}
