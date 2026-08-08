import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./paths";
import { log } from "@shared/logger";

/**
 * Session share registry — the durable, AUTHORITATIVE source of truth for
 * "peer may co-drive session X" grants, and the single point of revocation.
 *
 * Auth split (see dashboard/lib/peer-token.ts + middleware.ts):
 *   - The DASHBOARD mints a stateless, HMAC-SIGNED peer token carrying
 *     {shareId, sessionId, capability, host, exp}. Edge middleware verifies the
 *     signature (no shared state needed) to authenticate a peer cheaply.
 *   - The SANDBOX owns the share record and is the revocation authority: every
 *     peer-context call the dashboard proxies carries the shareId, and the
 *     sandbox re-validates it here (not revoked, not expired, host + session +
 *     capability match) before acting. So revoking a share cuts access instantly
 *     for both reads and writes, and a compromised dashboard cannot invent or
 *     resurrect a grant — it can only present a shareId the sandbox still holds.
 *
 * The sandbox never sees the raw peer token (the dashboard signs it), so there
 * is nothing secret to store here — only the grant metadata, keyed by shareId.
 */

export type ShareCapability = "full" | "drive" | "spectate";

export interface ShareRecord {
  shareId: string;
  sessionId: string;
  capability: ShareCapability;
  /** Exact bare Host the peer's browser must present (the tunnel hostname). */
  publicHost: string;
  /** Optional display name shown in attribution/presence. */
  peerName: string | null;
  createdAt: number;
  /** epoch ms; null = no expiry. */
  expiresAt: number | null;
  revoked: boolean;
  /** True once a peer has actually CLAIMED this share at least once (i.e. really
   * entered — not merely admitted). Set at claim, never cleared. Closing the tab
   * doesn't revoke the share, so a later redemption of the same link is a
   * RETURN: the join gate re-triggers (host can still deny an impersonator) and
   * the admit/request markers say "rejoined" instead of "joined". */
  joinedBefore: boolean;
}

const SHARES_FILE = join(STATE_DIR, "shares.json");
const SHARES_TMP = SHARES_FILE + ".tmp";

/**
 * Revocation observers. A share dying has consequences beyond this registry —
 * push subscriptions authorised by it must die with it, or a revoked peer keeps
 * receiving session content with no way for the host to stop it.
 *
 * Wired as a listener rather than a direct call into the consumer for two
 * reasons. It keeps the dependency one-way (push.ts already needs this module,
 * so importing it back would close a cycle), and it means every revocation path
 * — explicit revoke, session delete, tunnel down, shutdown — fires it by
 * construction. A fifth path added later cannot forget to clean up, because the
 * notification lives inside the functions that do the revoking.
 */
type SharesRevokedListener = (shareIds: readonly string[]) => void;
const revokedListeners: SharesRevokedListener[] = [];

export function onSharesRevoked(fn: SharesRevokedListener): void {
  revokedListeners.push(fn);
}

function emitRevoked(shareIds: readonly string[]): void {
  if (shareIds.length === 0) return;
  for (const fn of revokedListeners) {
    // A misbehaving observer must never block revocation itself.
    try { fn(shareIds); } catch (err) { log.error("shares", "revocation listener failed", { err: String(err) }); }
  }
}

/** shareId -> record. Loaded once at boot, mutated in-process. */
const shares = new Map<string, ShareRecord>();
let _loaded = false;

interface SharesFile {
  version: 1;
  savedAt: string;
  shares: ShareRecord[];
}

export function bootShares(): void {
  if (_loaded) return;
  _loaded = true;
  // A share is bound to a specific tunnel hostname (publicHost), and the quick
  // tunnel mints a NEW random hostname on every start. So ANY share persisted
  // from a previous run is dangling by definition — its tunnel is gone. Discard
  // whatever is on disk at boot and start every run with zero shares. This is
  // the belt-and-suspenders guarantee: even after a hard crash (SIGKILL) where
  // the shutdown drainer's revokeAllShares() never ran, stale grants can never
  // be revived. Live shares are (re)created within the run against the current
  // tunnel; nothing valid is ever carried across a restart.
  const hadFile = existsSync(SHARES_FILE);
  shares.clear();
  if (hadFile) {
    log.info("shares", "discarding shares from previous run (tunnel host is per-run)");
  }
  persist();
}

/** Drop revoked/expired records so the file doesn't grow without bound. */
function pruneDead(): void {
  const now = Date.now();
  for (const [id, r] of shares) {
    if (r.revoked || (r.expiresAt != null && r.expiresAt <= now)) shares.delete(id);
  }
}

function activeRecords(): ShareRecord[] {
  const now = Date.now();
  return [...shares.values()].filter(
    (r) => !r.revoked && (r.expiresAt == null || r.expiresAt > now),
  );
}

function persist(): void {
  try {
    mkdirSync(dirname(SHARES_FILE), { recursive: true });
    const body: SharesFile = {
      version: 1,
      savedAt: new Date().toISOString(),
      shares: [...shares.values()],
    };
    writeFileSync(SHARES_TMP, JSON.stringify(body, null, 2), "utf-8");
    renameSync(SHARES_TMP, SHARES_FILE);
  } catch (err) {
    log.error("shares", "persist failed", { err: String(err) });
  }
}

/** Normalize a Host header to a bare lowercase hostname (strip port/brackets). */
export function normalizeHost(hostHeader: string): string {
  let h = hostHeader.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end >= 0 ? h.slice(0, end + 1) : h;
  }
  const colon = h.indexOf(":");
  if (colon >= 0) h = h.slice(0, colon);
  return h;
}

export function createShare(opts: {
  sessionId: string;
  publicHost: string;
  capability?: ShareCapability;
  expiresInMs?: number | null;
  peerName?: string | null;
}): ShareRecord {
  bootShares();
  const now = Date.now();
  const record: ShareRecord = {
    shareId: randomUUID(),
    sessionId: opts.sessionId,
    capability: opts.capability ?? "full",
    publicHost: normalizeHost(opts.publicHost),
    peerName: opts.peerName ?? null,
    createdAt: now,
    expiresAt: opts.expiresInMs ? now + opts.expiresInMs : null,
    revoked: false,
    joinedBefore: false,
  };
  shares.set(record.shareId, record);
  persist();
  return record;
}

/**
 * Set (or clear) a share's peer display name. Used when the joining peer picks
 * their own nickname — that name becomes authoritative for attribution (it's
 * what checkParticipant returns) and for the host's admit prompt. Bounded and
 * persisted. No-op for an unknown/dead share.
 */
export function setSharePeerName(shareId: string, name: string | null): { ok: boolean } {
  bootShares();
  const r = shares.get(shareId);
  if (!r || r.revoked) return { ok: false };
  const trimmed = name?.trim();
  r.peerName = trimmed ? trimmed.slice(0, 80) : null;
  persist();
  return { ok: true };
}

/**
 * Mark a share as having been successfully joined (claimed) at least once, so a
 * later redemption of the same link is recognized as a return ("rejoined").
 * Idempotent; no-op for an unknown/dead share.
 */
export function markShareJoined(shareId: string): { ok: boolean } {
  bootShares();
  const r = shares.get(shareId);
  if (!r || r.revoked) return { ok: false };
  if (!r.joinedBefore) {
    r.joinedBefore = true;
    persist();
  }
  return { ok: true };
}

export function revokeShare(shareId: string): { ok: boolean } {
  bootShares();
  const r = shares.get(shareId);
  if (!r) return { ok: false };
  // Drop immediately — the sandbox is the authoritative deny.
  shares.delete(shareId);
  persist();
  emitRevoked([shareId]);
  return { ok: true };
}

/**
 * Revoke EVERY share at once; returns the ids that were dropped so the caller
 * can also tear down their pending/admitted joins. Called when the tunnel goes
 * down or stops, and on shutdown: every share is bound to the (now-gone) tunnel
 * host, so the grants are dangling and must not linger. Critically, the peer
 * READ guard validates by shareId alone (no host check), so a lingering record
 * would otherwise stay a live read grant even after the tunnel host changed.
 */
export function revokeAllShares(): { revoked: string[] } {
  bootShares();
  const revoked = [...shares.keys()];
  if (revoked.length === 0) return { revoked };
  shares.clear();
  persist();
  emitRevoked(revoked);
  return { revoked };
}

/**
 * Revoke every share bound to a given session — pass the session's id and any
 * resume aliases (e.g. from `expandSessionIds`) so a share minted under a prior
 * id is caught too. Returns the dropped shareIds so the caller can also tear
 * down their pending/admitted joins. Called when a session is DELETED: the
 * conversation is gone, so any link pointing at it must die with it (otherwise a
 * peer holding the link would keep a live, now-orphaned read/drive grant, since
 * the peer guard validates by shareId alone). Idempotent.
 */
export function revokeSharesForSession(sessionIds: string | string[]): { revoked: string[] } {
  bootShares();
  const wanted = new Set(Array.isArray(sessionIds) ? sessionIds : [sessionIds]);
  const revoked: string[] = [];
  for (const [id, r] of shares) {
    if (wanted.has(r.sessionId)) {
      shares.delete(id);
      revoked.push(id);
    }
  }
  if (revoked.length > 0) {
    persist();
    emitRevoked(revoked);
  }
  return { revoked };
}

export function listShares(): ShareRecord[] {
  bootShares();
  pruneDead();
  return activeRecords();
}

/** Look up a live share by id (null if missing/revoked/expired). */
export function getShare(shareId: string): ShareRecord | null {
  bootShares();
  const r = shares.get(shareId);
  if (!r || r.revoked) return null;
  if (r.expiresAt != null && r.expiresAt <= Date.now()) return null;
  return r;
}

export interface ShareValidation {
  ok: boolean;
  reason?: string;
  record?: ShareRecord;
}

/**
 * Authoritative revocation/scope check, run sandbox-side on every peer-context
 * call. The dashboard has already verified the token signature; this confirms
 * the grant is still live and matches the host/session it claims.
 */
export function validateShareById(
  shareId: string,
  opts: { host?: string; sessionId?: string } = {},
): ShareValidation {
  const r = getShare(shareId);
  if (!r) return { ok: false, reason: "revoked or expired" };
  if (opts.host && r.publicHost !== normalizeHost(opts.host)) {
    return { ok: false, reason: "host mismatch" };
  }
  if (opts.sessionId && r.sessionId !== opts.sessionId) {
    return { ok: false, reason: "session mismatch" };
  }
  return { ok: true, record: r };
}

/** Capability gate: does this capability permit the given action class?
 *
 * "admit" (admit/deny a pending peer join, and see the pending-join list) is a
 * full-only action: it lets a trusted co-driver bring another peer into the
 * SAME session, mirroring the host's admit gate. drive/spectate can never
 * admit. Because "full" already permits every action, adding "admit" needs no
 * per-case branch — it's spelled out in the union so callers are explicit.
 *
 * "notify" (register for push notifications about this session) is the one
 * action EVERY capability permits, spectate included. Every other action here
 * is an input — it changes the session — whereas receiving a notification is
 * pure output about content the participant is already entitled to read. A
 * spectator who can watch the transcript live but cannot be told the agent
 * finished would be a strange gap, so this is deliberately open. What a
 * notification may CONTAIN is still gated separately: join-request
 * notifications are restricted to admit-capable recipients (see push.ts's
 * mayReceive), matching the "admit" rule above. */
export function capabilityAllows(
  capability: ShareCapability,
  action: "turn" | "bash" | "permission" | "admit" | "notify",
): boolean {
  if (action === "notify") return true;
  switch (capability) {
    case "full":
      return true;
    case "drive":
      return action === "turn";
    case "spectate":
    default:
      return false;
  }
}
