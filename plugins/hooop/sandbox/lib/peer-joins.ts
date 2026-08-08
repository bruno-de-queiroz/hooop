import { randomUUID } from "node:crypto";

/**
 * Ephemeral "host admits each join" gate for peer co-drive.
 *
 * A redeemed share link does NOT grant access on its own. Redemption creates a
 * PENDING join ticket here; the peer waits while the host is shown an
 * Admit/Deny prompt. Only after the host admits is the durable peer cookie
 * issued (via the dashboard's claim step). So a leaked link redeemed by a
 * stranger surfaces as an unexpected join request the host simply denies —
 * and denial revokes the share (enforced by the caller in server.ts).
 *
 * In-memory and per-attempt by design: every fresh redeem is a new ticket, and
 * everything resets on sandbox restart. The sandbox is the authority — the
 * dashboard cannot self-admit.
 */

export type JoinStatus = "pending" | "admitted" | "denied";

interface JoinTicket {
  ticketId: string;
  /** Random secret bound to the redeeming browser (via an HttpOnly cookie), so
   * only the party that redeemed can claim an admitted ticket. */
  secret: string;
  shareId: string;
  sessionId: string;
  peerName: string | null;
  /** Best-effort public IP of the joiner (from the tunnel edge), shown to the
   * decider in the admit prompt. Informational only — never an auth input. */
  peerIp: string | null;
  /** Two-letter country of the joiner's IP (Cloudflare CF-IPCountry), or "T1"
   * for Tor. Informational, paired with peerIp. */
  peerCountry: string | null;
  status: JoinStatus;
  createdAt: number;
}

/** Pending tickets older than this are swept (host never responded). */
const PENDING_TTL_MS = 2 * 60_000;
/** An admitted ticket must be claimed within this window, else it's discarded. */
const ADMITTED_TTL_MS = 60_000;
/** Backstop so a flood of redeems can't grow the map without bound. */
const MAX_TICKETS = 100;

const tickets = new Map<string, JoinTicket>();

function isStale(t: JoinTicket, now: number): boolean {
  if (t.status === "pending") return now - t.createdAt > PENDING_TTL_MS;
  if (t.status === "admitted") return now - t.createdAt > PENDING_TTL_MS + ADMITTED_TTL_MS;
  return now - t.createdAt > PENDING_TTL_MS; // denied entries linger briefly for status reads
}

function sweep(): void {
  const now = Date.now();
  for (const [id, t] of tickets) {
    if (isStale(t, now)) tickets.delete(id);
  }
}

/** Create a pending join ticket for a redeemed share. Returns the ids the
 * dashboard needs: `ticketId` (client-visible, for polling) and `secret`
 * (stored in the peer's HttpOnly pending cookie, required to claim). */
export function createJoinTicket(opts: {
  shareId: string;
  sessionId: string;
  peerName: string | null;
  peerIp?: string | null;
  peerCountry?: string | null;
}): { ticketId: string; secret: string } {
  sweep();
  // Backstop: if we're at the cap, drop the oldest pending entry.
  if (tickets.size >= MAX_TICKETS) {
    const oldest = [...tickets.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) tickets.delete(oldest.ticketId);
  }
  const ticketId = randomUUID();
  const secret = randomUUID();
  tickets.set(ticketId, {
    ticketId,
    secret,
    shareId: opts.shareId,
    sessionId: opts.sessionId,
    peerName: opts.peerName,
    peerIp: opts.peerIp ?? null,
    peerCountry: opts.peerCountry ?? null,
    status: "pending",
    createdAt: Date.now(),
  });
  return { ticketId, secret };
}

/** Status for the peer's poll. "expired"/"unknown" both mean "get a new link". */
export function joinStatus(ticketId: string): JoinStatus | "expired" {
  sweep();
  const t = tickets.get(ticketId);
  return t ? t.status : "expired";
}

/** Non-consuming lookup used by the admit/deny authorization gate: resolve a
 * ticket's session (and share) so the caller can scope a full-capability peer
 * to admitting only joins for the session they're actually in. Returns null for
 * unknown/expired tickets. */
export function getJoinTicket(
  ticketId: string,
): { shareId: string; sessionId: string; peerName: string | null; status: JoinStatus } | null {
  sweep();
  const t = tickets.get(ticketId);
  if (!t) return null;
  return { shareId: t.shareId, sessionId: t.sessionId, peerName: t.peerName, status: t.status };
}

/** Host admits a pending join. No-op (false) if unknown/expired/not-pending. */
export function admitJoin(ticketId: string): { ok: boolean; ticket?: { shareId: string; sessionId: string; peerName: string | null } } {
  sweep();
  const t = tickets.get(ticketId);
  if (!t || t.status !== "pending") return { ok: false };
  t.status = "admitted";
  t.createdAt = Date.now(); // reset clock for the claim window
  return { ok: true, ticket: { shareId: t.shareId, sessionId: t.sessionId, peerName: t.peerName } };
}

/** Host denies a pending join. Returns the shareId so the caller can revoke it. */
export function denyJoin(ticketId: string): { ok: boolean; shareId?: string; peerName?: string | null } {
  sweep();
  const t = tickets.get(ticketId);
  if (!t || t.status !== "pending") return { ok: false };
  t.status = "denied";
  t.createdAt = Date.now();
  return { ok: true, shareId: t.shareId, peerName: t.peerName };
}

/**
 * Claim an admitted ticket: consumes it one-time. Requires the secret to match
 * (proves the caller is the browser that redeemed). Returns the grant so the
 * dashboard can issue the peer cookie, or null if not claimable.
 */
export function claimJoin(ticketId: string, secret: string): { shareId: string; sessionId: string; peerName: string | null } | null {
  sweep();
  const t = tickets.get(ticketId);
  if (!t || t.status !== "admitted") return null;
  if (t.secret !== secret) return null;
  tickets.delete(ticketId); // one-time
  return { shareId: t.shareId, sessionId: t.sessionId, peerName: t.peerName };
}

/** Pending joins for the host's Admit/Deny UI (no secrets). */
export function listPendingJoins(): Array<{ ticketId: string; shareId: string; sessionId: string; peerName: string | null; peerIp: string | null; peerCountry: string | null; createdAt: number }> {
  sweep();
  return [...tickets.values()]
    .filter((t) => t.status === "pending")
    .map(({ secret: _secret, status: _status, ...pub }) => pub);
}

/** Drop every ticket for a share (called when a share is revoked). */
export function dropJoinsForShare(shareId: string): void {
  for (const [id, t] of tickets) {
    if (t.shareId === shareId) tickets.delete(id);
  }
}
