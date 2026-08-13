import { existsSync, mkdirSync, writeFileSync, renameSync, readFileSync, chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import webpush from "web-push";
import { STATE_DIR } from "./paths";
import { onSharesRevoked, type ShareCapability } from "./shares";
import { onHostDevicesRevoked } from "./host-devices";
import { eventBus } from "./ingestor";
import { classifyEvent, type NotifyCategory } from "@shared/notifiable";
import { toHandle } from "@shared/handles";
import { log } from "@shared/logger";

/**
 * Web-push delivery for session activity.
 *
 * Why push at all, when the sidebar already shows an unseen dot: the dot is
 * computed in the page. `useSSE.ts` documents that a backgrounded mobile tab
 * gets suspended — its WebSocket silently killed and its JS timers frozen — so
 * for a peer co-driving from a phone (the case pairing exists for) nothing in
 * the page runs. A blocking AskUserQuestion or permission ask would sit there
 * until the gate times out. A push notification is delivered by the browser's
 * push service independent of the page, so it is the only thing that reaches a
 * sleeping tab.
 *
 * Ownership: the VAPID private key and the subscription registry live HERE, in
 * the sandbox, not in the dashboard. Per the README's architecture the
 * dashboard is the untrusted view and "holds no secrets"; it only proxies.
 *
 * LIFETIME — the load-bearing design decision. A peer's subscription is bound
 * to the cloudflared tunnel origin they subscribed from, and `shares.ts`
 * deliberately discards every share at boot because that hostname is new on
 * every run. Rather than fight that, peer subscriptions are given exactly the
 * same lifetime as the share that authorised them:
 *   - dropped wholesale at boot (see bootPush), and
 *   - dropped the instant the share is revoked (see the onSharesRevoked hook).
 * The second is a security property, not tidiness: a revoked peer who kept a
 * live subscription would keep receiving session content — message bodies and
 * all — with no way for the host to stop it.
 *
 * A host DEVICE subscription (the operator's own phone) gets the peer treatment
 * rather than the host one, because it has the peer's lifetime: it was minted on
 * the tunnel origin and its grant is revocable. Only the host at the machine
 * persists across restarts, because localhost:7842 is a stable origin.
 */

const PUSH_FILE = join(STATE_DIR, "push.json");
const PUSH_TMP = PUSH_FILE + ".tmp";
const VAPID_FILE = join(STATE_DIR, "vapid.json");
const VAPID_TMP = VAPID_FILE + ".tmp";

/**
 * Contact URI baked into the VAPID JWT's `sub`. The spec allows mailto: or
 * https:, and some push services validate it — a made-up address like
 * `mailto:hooop@localhost` is not routable and risks rejections that would only
 * ever show up in the field, never locally. The project URL is a real,
 * reachable contact point and needs no per-install configuration.
 */
const VAPID_SUBJECT = process.env.HOOOP_VAPID_SUBJECT || "https://github.com/bruno-de-queiroz/hooop";

/**
 * How long a participant's last presence beat keeps them counted as "here".
 *
 * Mirrors the dashboard's own IDLE_MS, so the rule is easy to state and easy to
 * reason about: **if presence would show you as away, you get notified.** The
 * client beats every ~10s, so this tolerates two misses.
 *
 * Suppressing because we think someone is watching is the one failure mode that
 * loses information — miss a blocking question and the turn stalls until the
 * gate times out — so this expires quickly and fails toward notifying.
 */
const PRESENCE_TTL_MS = 25_000;

export type PushOwnerKind = "host" | "peer";

/** Thrown when a caller touches a subscription endpoint they don't own. */
export class PushOwnershipError extends Error {
  constructor() {
    super("that subscription belongs to another participant");
    this.name = "PushOwnershipError";
  }
}

export interface PushSubscriptionRecord {
  id: string;
  ownerKind: PushOwnerKind;
  /** Peer only — the share that authorised this subscription. */
  shareId: string | null;
  /**
   * Peer only — the session they are locked to. Host subscriptions are null
   * because the host receives every session's activity.
   */
  sessionId: string | null;
  /**
   * Snapshotted at subscribe time rather than looked up at send time, so
   * delivery never has to reach back into the share registry (which would make
   * this module and shares.ts mutually dependent).
   */
  displayName: string | null;
  capability: ShareCapability | null;
  /**
   * Host only — WHICH of the host's screens this is, when it is one of their
   * enrolled devices rather than the machine itself (null for the machine).
   *
   * Recorded for exactly one reason, and it is the same reason a peer's row
   * carries its shareId: a revoked credential must not keep receiving session
   * content. Without it, a phone's subscription is indistinguishable from the
   * laptop's, so revoking the phone would leave it being delivered message
   * bodies with no way for the host to stop it — the leak the share path is
   * careful to close.
   *
   * It does NOT scope delivery. A device is the host, so it hears about every
   * session and shares the host's mutes; this is only a handle to revoke by.
   */
  deviceId: string | null;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAt: number;
}

/**
 * Who is currently here — recorded per screen, answered per participant.
 *
 * Fed from the dashboard's existing presence heartbeat — the same signal that
 * dims an avatar — rather than a second mechanism of our own. The client
 * already beats every ~10s reporting `document.visibilityState`; duplicating
 * that with a parallel keepalive meant two timers answering the same question
 * with timings that could disagree.
 *
 * Per PARTICIPANT, not per subscription, and that's the useful granularity: if
 * you're actively watching the session on your laptop, your phone shouldn't
 * buzz either.
 *
 * Which is why the map is keyed per SCREEN and read per participant, rather than
 * holding one slot per participant. One slot made the newest beat the only truth,
 * so the phone going into your pocket ("I'm not looking") erased the laptop
 * sitting in front of you ("I am"), and the phone then buzzed about the message
 * you were reading — the precise outcome the paragraph above says we want to
 * avoid. `isWatching` answers "is ANY of their screens on it", so a person is
 * away only once all of their screens are.
 *
 * Decided server-side rather than in the service worker because
 * `userVisibleOnly` obliges a subscription to show something for every message
 * it receives — a worker that routinely stays silent earns the browser's own
 * "site updated in the background" notice. Not sending is the only clean
 * suppression.
 */
const activeViewers = new Map<string, { ownerKey: string; sessionId: string; at: number }>();

/** Key for one screen of one participant. A client that reports no viewer id
 *  gets a single shared slot, which is exactly the old behaviour. */
function viewerSlot(ownerKey: string, viewerId?: string | null): string {
  return `${ownerKey}\u0000${viewerId || "-"}`;
}

export interface MuteRecord {
  /** "host" | `peer:<shareId>` */
  ownerKey: string;
  /** null = mute everything for this owner. */
  sessionId: string | null;
  mutedAt: number;
}

interface PushFile {
  version: 1;
  savedAt: string;
  subscriptions: PushSubscriptionRecord[];
  mutes: MuteRecord[];
}

const subscriptions = new Map<string, PushSubscriptionRecord>(); // endpoint -> record
const mutes = new Map<string, MuteRecord>(); // muteKey(ownerKey, sessionId) -> record
let _loaded = false;
let _wired = false;

/** Owner key for a participant, used to scope mutes. */
export function ownerKeyFor(ownerKind: PushOwnerKind, shareId: string | null): string {
  return ownerKind === "host" ? "host" : `peer:${shareId ?? ""}`;
}

/**
 * Composite map key for a mute row. JSON rather than a delimiter-joined string:
 * it distinguishes a null sessionId (the global mute) from the string "null"
 * without a sentinel, and it cannot be broken by whatever characters end up in
 * an id. In-memory only — the persisted rows carry ownerKey/sessionId as real
 * fields, so this format is free to change.
 */
function muteKey(ownerKey: string, sessionId: string | null): string {
  return JSON.stringify([ownerKey, sessionId]);
}

/**
 * Session-id equivalence. `claude --resume` swaps a session's canonical id
 * mid-life, so a peer's subscription (bound to the id their share was created
 * under) must still match events arriving under the new id.
 *
 * Injected rather than imported: resolving it needs the active-session
 * registry, and active-sessions already reaches shares.ts, so importing it here
 * would close a cycle. server.ts wires the real resolver at boot; tests and any
 * caller that skips wiring get identity, which is correct for a non-resumed
 * session.
 */
let resolveCanonical: (id: string) => string = (id) => id;
export function setCanonicalResolver(fn: (id: string) => string): void {
  resolveCanonical = fn;
}

function persist(): void {
  try {
    mkdirSync(dirname(PUSH_FILE), { recursive: true });
    const body: PushFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      subscriptions: [...subscriptions.values()],
      mutes: [...mutes.values()],
    };
    writeFileSync(PUSH_TMP, JSON.stringify(body, null, 2), "utf-8");
    renameSync(PUSH_TMP, PUSH_FILE);
  } catch (err) {
    log.error("push", "persist failed", { err: String(err) });
  }
}

/**
 * Load host state and discard every per-run trace from the previous run.
 *
 * Peer rows are dropped rather than validated because there is nothing left to
 * validate against: bootShares() has already cleared the share registry, so no
 * peer subscription can still be authorised. Keeping them would leave endpoints
 * we would happily deliver session content to, owned by nobody.
 *
 * A host DEVICE row goes for the same reason. Its subscription was minted on the
 * tunnel origin, which is gone, and bootHostDevices() has already cleared the
 * device registry — so it is a subscription owned by nobody too. Only the host at
 * the machine survives a restart, because localhost:7842 is a stable origin.
 */
export function bootPush(): void {
  if (_loaded) return;
  _loaded = true;
  subscriptions.clear();
  mutes.clear();

  if (existsSync(PUSH_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(PUSH_FILE, "utf-8")) as Partial<PushFile>;
      let droppedSubs = 0;
      for (const s of parsed.subscriptions ?? []) {
        if (!s || typeof s.endpoint !== "string" || !s.endpoint) continue;
        if (s.ownerKind !== "host") { droppedSubs++; continue; }
        if (s.deviceId) { droppedSubs++; continue; }
        subscriptions.set(s.endpoint, { ...s, ownerKind: "host", shareId: null, sessionId: null, deviceId: null } as PushSubscriptionRecord);
      }
      let droppedMutes = 0;
      for (const m of parsed.mutes ?? []) {
        if (!m || typeof m.ownerKey !== "string") continue;
        // A peer mute is keyed by a shareId that no longer exists.
        if (m.ownerKey !== "host") { droppedMutes++; continue; }
        mutes.set(muteKey(m.ownerKey, m.sessionId ?? null), m);
      }
      if (droppedSubs || droppedMutes) {
        log.info("push", "discarded per-run state from previous run (shares and devices are per-run)", { droppedSubs, droppedMutes });
      }
    } catch (err) {
      log.warn("push", "unreadable push.json — starting empty", { err: String(err) });
    }
  }

  // Drop a peer's subscriptions the moment their share dies, wherever that
  // happens (explicit revoke, session delete, tunnel down, shutdown). Wiring it
  // to the registry's own notification rather than to each call site is what
  // makes it impossible to add a fourth revocation path that forgets.
  if (!_wired) {
    _wired = true;
    onSharesRevoked((shareIds) => { dropSubscriptionsForShares(shareIds); });
    // Same hook for the host's own enrolled devices: revoking a phone has to take
    // its notifications with it, or the screen we just cut off keeps being handed
    // message bodies.
    onHostDevicesRevoked((deviceIds) => { dropSubscriptionsForDevices(deviceIds); });
  }

  persist();
}

// ---------- VAPID ----------

let _vapid: { publicKey: string; privateKey: string } | null = null;

/**
 * The VAPID keypair, generated once and reused. Persisted 0600 — it is the
 * credential that authenticates this server to the push services, so a leak
 * would let someone else deliver notifications to our subscribers.
 */
function vapid(): { publicKey: string; privateKey: string } {
  if (_vapid) return _vapid;
  if (existsSync(VAPID_FILE)) {
    try {
      const parsed = JSON.parse(readFileSync(VAPID_FILE, "utf-8"));
      if (typeof parsed?.publicKey === "string" && typeof parsed?.privateKey === "string") {
        _vapid = { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
        return _vapid;
      }
    } catch { /* fall through and regenerate */ }
  }
  const generated = webpush.generateVAPIDKeys();
  _vapid = { publicKey: generated.publicKey, privateKey: generated.privateKey };
  try {
    mkdirSync(dirname(VAPID_FILE), { recursive: true });
    writeFileSync(VAPID_TMP, JSON.stringify(_vapid, null, 2), { encoding: "utf-8", mode: 0o600 });
    // writeFileSync's mode is subject to umask; chmod is not.
    chmodSync(VAPID_TMP, 0o600);
    renameSync(VAPID_TMP, VAPID_FILE);
  } catch (err) {
    log.error("push", "could not persist VAPID keys — they will regenerate next boot", { err: String(err) });
  }
  return _vapid;
}

/** The public half, handed to browsers so they can mint a subscription. */
export function vapidPublicKey(): string {
  return vapid().publicKey;
}

// ---------- Subscriptions ----------

export function addSubscription(opts: {
  ownerKind: PushOwnerKind;
  shareId: string | null;
  sessionId: string | null;
  displayName: string | null;
  capability: ShareCapability | null;
  /** Host only: the enrolled device this subscription belongs to, if any. */
  deviceId?: string | null;
  endpoint: string;
  keys: { p256dh: string; auth: string };
}): PushSubscriptionRecord {
  bootPush();
  // Keyed by endpoint: a browser re-subscribing with the same endpoint is the
  // same device, so this is an upsert rather than a duplicate delivery.
  const existing = subscriptions.get(opts.endpoint);
  // ...but only the device's own owner may upsert it. Without this, a peer who
  // learned another participant's endpoint could re-register it under their own
  // identity and session, quietly re-scoping (and effectively hijacking) someone
  // else's device. Endpoints are unguessable, so this is defence in depth rather
  // than a plugged hole — but "unguessable" is not an authorisation check.
  if (existing) {
    const mine = ownerKeyFor(opts.ownerKind, opts.shareId);
    const theirs = ownerKeyFor(existing.ownerKind, existing.shareId);
    if (mine !== theirs) throw new PushOwnershipError();
  }
  const record: PushSubscriptionRecord = {
    id: existing?.id ?? randomUUID(),
    ownerKind: opts.ownerKind,
    shareId: opts.ownerKind === "peer" ? opts.shareId : null,
    sessionId: opts.ownerKind === "peer" ? opts.sessionId : null,
    displayName: opts.displayName,
    capability: opts.ownerKind === "peer" ? opts.capability : null,
    deviceId: opts.ownerKind === "host" ? opts.deviceId ?? null : null,
    endpoint: opts.endpoint,
    keys: opts.keys,
    createdAt: existing?.createdAt ?? Date.now(),
  };
  subscriptions.set(record.endpoint, record);
  persist();
  return record;
}

/**
 * Remove a device's subscription. `ownerKey` is required, not optional: keying
 * solely on the endpoint let any authenticated participant delete anyone else's
 * subscription — silently silencing them — if they ever learned the URL.
 */
export function removeSubscription(endpoint: string, ownerKey: string): { ok: boolean } {
  bootPush();
  const existing = subscriptions.get(endpoint);
  if (!existing) return { ok: false };
  if (ownerKeyFor(existing.ownerKind, existing.shareId) !== ownerKey) return { ok: false };
  subscriptions.delete(endpoint);
  persist();
  return { ok: true };
}

/**
 * Record a participant's presence beat: they are here and foregrounded on this
 * session, or `null` when their tab went to the background or they left.
 *
 * The ownerKey is derived from the trusted participant header by the caller, so
 * a participant can only ever assert their own presence. Not persisted — this
 * is ephemeral and worthless across a restart.
 */
export function setParticipantActive(
  ownerKey: string,
  sessionId: string | null,
  viewerId?: string | null,
): { ok: boolean } {
  bootPush();
  const slot = viewerSlot(ownerKey, viewerId);
  if (sessionId) {
    activeViewers.set(slot, { ownerKey, sessionId: resolveCanonical(sessionId), at: Date.now() });
  } else {
    // Only THIS screen goes away. The participant is still watching from
    // anywhere else that is still beating.
    activeViewers.delete(slot);
  }
  return { ok: true };
}

/**
 * Drop every subscription belonging to any of these enrolled devices. The exact
 * counterpart of dropSubscriptionsForShares, wired the same way (a revocation
 * listener rather than a direct call), so every path that kills a device — one
 * revoke, revoke-all, tunnel down, shutdown — cleans up by construction.
 *
 * Mutes are NOT touched: they are keyed "host" and belong to the person, not the
 * screen. Losing your phone should not un-mute the sessions you silenced.
 */
export function dropSubscriptionsForDevices(deviceIds: readonly string[]): { dropped: number } {
  bootPush();
  const wanted = new Set(deviceIds);
  let dropped = 0;
  for (const [endpoint, r] of subscriptions) {
    if (r.ownerKind === "host" && r.deviceId && wanted.has(r.deviceId)) {
      subscriptions.delete(endpoint);
      dropped++;
    }
  }
  if (dropped > 0) {
    log.info("push", "dropped subscriptions for revoked devices", { dropped });
    persist();
  }
  return { dropped };
}

/** Drop every subscription authorised by any of these shares. */
export function dropSubscriptionsForShares(shareIds: readonly string[]): { dropped: number } {
  bootPush();
  const wanted = new Set(shareIds);
  let dropped = 0;
  for (const [endpoint, r] of subscriptions) {
    if (r.ownerKind === "peer" && r.shareId && wanted.has(r.shareId)) {
      subscriptions.delete(endpoint);
      dropped++;
    }
  }
  // Their mutes are keyed by the same dead shareId.
  for (const [k, m] of mutes) {
    for (const id of wanted) {
      if (m.ownerKey === `peer:${id}`) { mutes.delete(k); break; }
    }
  }
  if (dropped > 0) {
    log.info("push", "dropped subscriptions for revoked shares", { dropped });
    persist();
  }
  return { dropped };
}

export function listSubscriptions(): PushSubscriptionRecord[] {
  bootPush();
  return [...subscriptions.values()];
}

// ---------- Mutes ----------

/** Mute (or unmute) a session for one participant; sessionId null = everything. */
export function setMute(ownerKey: string, sessionId: string | null, muted: boolean): void {
  bootPush();
  // Normalise on the way IN. isMuted resolves the incoming event's id forward,
  // so storing a raw alias here produced an asymmetry: mute under the alias,
  // and an event arriving under the canonical id would miss the row entirely
  // (the canonical resolves to itself, so the alias branch never fires).
  if (sessionId) sessionId = resolveCanonical(sessionId);
  const k = muteKey(ownerKey, sessionId);
  if (muted) mutes.set(k, { ownerKey, sessionId, mutedAt: Date.now() });
  else mutes.delete(k);
  persist();
}

export function listMutes(ownerKey: string): MuteRecord[] {
  bootPush();
  return [...mutes.values()].filter((m) => m.ownerKey === ownerKey);
}

/** A global mute outranks everything; otherwise check this specific session. */
export function isMuted(ownerKey: string, sessionId: string | null): boolean {
  bootPush();
  if (mutes.has(muteKey(ownerKey, null))) return true;
  if (!sessionId) return false;
  if (mutes.has(muteKey(ownerKey, sessionId))) return true;
  // Match through a resumed session's alias too, so muting a session doesn't
  // silently un-mute itself when claude swaps the canonical id.
  const canonical = resolveCanonical(sessionId);
  return canonical !== sessionId && mutes.has(muteKey(ownerKey, canonical));
}

// ---------- Delivery ----------

/** Categories only a participant who can admit peers should ever receive. */
function requiresAdmitRights(category: NotifyCategory): boolean {
  return category === "join-request";
}

/**
 * Is this participant present and foregrounded on the session the event belongs
 * to? If so their screen already shows the message, the permission card, the
 * admit toast — notifying would be telling them about what they're looking at.
 * The server-side counterpart of the unseen dot skipping the selected session.
 *
 * Fails toward notifying: a tab that backgrounded, slept, crashed or lost the
 * network stops beating and is "away" within PRESENCE_TTL_MS.
 */
function isWatching(ownerKey: string, sessionId: string): boolean {
  const canonical = resolveCanonical(sessionId);
  const now = Date.now();
  // ANY of their screens counts. Scanning is fine: this map holds one entry per
  // open tab in the session, which is single digits.
  for (const seen of activeViewers.values()) {
    if (seen.ownerKey !== ownerKey) continue;
    if (now - seen.at > PRESENCE_TTL_MS) continue;
    if (seen.sessionId === canonical) return true;
  }
  return false;
}

function mayReceive(r: PushSubscriptionRecord, category: NotifyCategory, sessionId: string): boolean {
  if (requiresAdmitRights(category)) {
    // Mirrors capabilityAllows(…, "admit"): host always, peers only with "full".
    if (r.ownerKind === "peer" && r.capability !== "full") return false;
  }
  if (r.ownerKind === "host") return true;
  // A peer only ever hears about the one session their share is bound to.
  if (!r.sessionId) return false;
  return resolveCanonical(r.sessionId) === resolveCanonical(sessionId);
}

/**
 * Whether this event came from the recipient themselves. Host events carry
 * author "host"; a peer's carry the display name they chose at join — the same
 * comparison UnseenProvider makes client-side.
 *
 * Scope matters: "self-authored" means "do not echo my own MESSAGE back at me".
 * It must not be applied to an event that is ADDRESSED to me, and every
 * permission ask is — see notifyForEvent, where attention/join-request skip this
 * check entirely.
 */
function isSelfAuthored(r: PushSubscriptionRecord, author: string | null | undefined): boolean {
  if (!author) return false;
  return r.ownerKind === "host" ? author === "host" : author === r.displayName;
}

/**
 * Categories that reach their own author anyway, because for these the author is
 * the person who most needs to hear it.
 *
 * The self-authored filter means "do not echo my own message back at me", and
 * for chat that is right. Applied wholesale it swallowed exactly the events that
 * matter:
 *
 *   - `attention` — a permission ask, plan review or question carries the author
 *     of the turn that provoked it, which is nearly always the person who has to
 *     answer it. The agent is blocked, waiting on you, and the reason it is
 *     waiting on YOU is that you started the turn. Reported as "a few permission
 *     bubbles never notified me"; it was in fact every ask on a turn you drove.
 *   - `join-request` — names the guest as author, but is addressed to whoever
 *     can admit them.
 *   - `preview` — the completion of something you started and then walked away
 *     from. Notifying only OTHER people that your app came up would be useless.
 *
 * Still filtered by `isWatching`, so none of these buzz you about a session you
 * are looking at right now.
 */
const DELIVER_TO_AUTHOR_TOO: ReadonlySet<NotifyCategory> = new Set<NotifyCategory>([
  "attention",
  "join-request",
  "preview",
]);

export interface OutgoingNotification {
  title: string;
  body: string;
  category: NotifyCategory;
  sessionId: string;
}

/**
 * Classify one ingest event and deliver it to every participant who should hear
 * about it. Best-effort by design: a push failure must never disturb ingestion.
 */
export async function notifyForEvent(event: {
  session_id?: string | null;
  hook_type?: string | null;
  tool_name?: string | null;
  author?: string | null;
  text?: string | null;
  agent_id?: string | null;
  kind?: string | null;
}): Promise<{ sent: number }> {
  bootPush();
  const classified = classifyEvent(event);
  if (!classified) return { sent: 0 };
  // A turn-complete with no text is a bare lifecycle marker. countsAsUnseen
  // already refuses to raise a dot for it ("nothing to read on arrival"); the
  // same judgement has to apply here, or the two disagree on exactly the case
  // the shared module exists to keep aligned — and every finished turn buzzes
  // a phone with an empty notification.
  if (classified.category === "turn-complete" && !classified.body) return { sent: 0 };
  const sessionId = event.session_id as string;

  const payload: OutgoingNotification = {
    title: classified.title,
    body: classified.body,
    category: classified.category,
    sessionId,
  };

  // Was THIS subscriber named in the message? Handles are derived from the
  // display name snapshotted at subscribe time, so no lookup into the roster is
  // needed here (and this module stays independent of shares.ts).
  //
  // Known limit: toHandle can't disambiguate two participants with the SAME
  // display name the way the roster's deriveHandles does — the roster would
  // call them "sam" and "sam-2", while both subscriptions compute "sam". So the
  // second Sam isn't reachable by handle, and the first is pinged for either.
  // Rare, cosmetic, and it fails toward notifying rather than staying silent.
  const mentioned = (r: PushSubscriptionRecord): boolean =>
    classified.mentions.length > 0
    && !!r.displayName
    && classified.mentions.includes(toHandle(r.displayName));

  const targets = [...subscriptions.values()].filter((r) => {
    const ownerKey = ownerKeyFor(r.ownerKind, r.shareId);
    if (!mayReceive(r, classified.category, sessionId)) return false;
    if (!DELIVER_TO_AUTHOR_TOO.has(classified.category) && isSelfAuthored(r, event.author)) return false;
    // Still suppressed while they are looking at the session: a mention is
    // louder than a message, not louder than the screen it's already on.
    if (isWatching(ownerKey, sessionId)) return false;
    // A mute silences the room, not your name being called.
    if (isMuted(ownerKey, sessionId) && !mentioned(r)) return false;
    return true;
  });
  if (targets.length === 0) return { sent: 0 };

  const { publicKey, privateKey } = vapid();
  const results = await Promise.all(targets.map(async (r) => {
    // Per-recipient: the same event is a "mention" for the people it names and
    // an ordinary "chat" for everyone else, so the payload is built here rather
    // than once above.
    const forThem: OutgoingNotification = mentioned(r)
      ? {
          ...payload,
          category: "mention",
          title: event.author ? `${event.author} mentioned you` : "You were mentioned",
        }
      : payload;
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: r.keys },
        JSON.stringify(forThem),
        {
          vapidDetails: { subject: VAPID_SUBJECT, publicKey, privateKey },
          TTL: 600,
          // web-push sets no timeout of its own, so an unresponsive push
          // service would leave one pending request per event forever.
          timeout: 10_000,
        },
      );
      return true;
    } catch (err: unknown) {
      const status = (err as { statusCode?: number })?.statusCode;
      // 404/410 is the push service telling us this endpoint is permanently
      // gone (tab uninstalled the SW, browser rotated it). Anything else may be
      // transient, so we keep the record and let the next event retry.
      if (status === 404 || status === 410) {
        subscriptions.delete(r.endpoint);
        persist();
      } else {
        log.warn("push", "delivery failed", { status: status ?? null });
      }
      return false;
    }
  }));

  return { sent: results.filter(Boolean).length };
}

/**
 * Subscribe to the ingest bus. Called once at boot from server.ts. Uses the
 * documented `eventBus.on("event")` extension point rather than editing the
 * ingest path, so a push failure cannot affect persistence.
 */
export function startPushNotifier(): void {
  bootPush();
  eventBus.on("event", (e: unknown) => {
    void notifyForEvent(e as Parameters<typeof notifyForEvent>[0]).catch((err) => {
      log.warn("push", "notify failed", { err: String(err) });
    });
  });
}

/**
 * Test seam: forget in-memory state so the next bootPush() re-reads from disk —
 * i.e. simulate a restart without paying to reload the module graph.
 *
 * Deliberately leaves `_wired` set. The revocation listener closes over the
 * module-level maps (which survive this reset), so it stays correct, and
 * re-registering it on every reset would stack duplicate listeners.
 */
export function __resetPushForTests(): void {
  subscriptions.clear();
  mutes.clear();
  activeViewers.clear();
  _loaded = false;
  _vapid = null;
  resolveCanonical = (id) => id;
}
