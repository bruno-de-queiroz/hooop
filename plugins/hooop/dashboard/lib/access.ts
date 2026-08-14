import { client } from "@/lib/sandbox-client";

/**
 * Is the grant behind this participant still live?
 *
 * ONE place, called from ONE caller: the proxy. This is the whole revocation
 * mechanism for reads, and it has to be, because nothing else can do the job:
 *
 *   - Writes are re-validated sandbox-side on every call, so revoking kills them
 *     instantly whatever the dashboard thinks.
 *   - Reads are not. A peer token and a device token stay cryptographically valid
 *     after the grant behind them is revoked, so a signature check cannot tell a
 *     live participant from an ejected one. Only the sandbox knows, and only if
 *     somebody asks it.
 *
 * It used to be asked per route, by a helper each route had to remember to call —
 * which two thirds of them did not, so a revoked peer kept reading files,
 * previews, skills and agents, and a revoked device kept reading everything. That
 * is not a bug you fix route by route; it is a bug you fix by not having a rule
 * that can be forgotten. The proxy sees every request by construction (see its
 * matcher), so the check lives there and nowhere else.
 *
 * Two revocable kinds:
 *   - `peer:<shareId>` — a guest's share.
 *   - `host:<deviceId>` — the host's own enrolled device. Revocable because it is
 *     a bearer grant on a public URL, unlike the host at the machine, whose
 *     authority is the install cookie and has nothing to revoke.
 *
 * A short TTL cache keeps a polling client from adding a round trip to every
 * request; revocation lands within the TTL, which is the same few seconds the
 * live-feed reaper takes. Transient sandbox errors are treated as LIVE so a local
 * socket blip cannot evict a legitimate participant — their reads would be empty
 * anyway if the sandbox were truly down, and the next request re-checks.
 *
 * THREE things do not pass through the proxy, and each carries its own equivalent
 * check rather than a copy of this one, because each speaks a different protocol:
 *   - the live WebSocket feed and the tunnel/preview controls, handled by the front
 *     process before Next ever sees them (server.mjs: `deviceLive`, `shareLive`,
 *     plus a 5s reaper that closes an already-open feed);
 *   - preview traffic, which lands on its own ports (server.mjs
 *     `authorizePreview`, re-deriving access per request);
 *   - the sandbox itself, which re-validates every write against its own registry
 *     and would refuse a revoked grant even if everything here were bypassed.
 */
const TTL_MS = 3000;
const cache = new Map<string, { live: boolean; at: number }>();

/** Exported for tests; a live process never needs to drop it. */
export function __resetAccessCacheForTests(): void {
  cache.clear();
}

/**
 * `false` when this participant's grant has been revoked or expired.
 *
 * Takes the trusted participant STRING (what the proxy resolved and is about to
 * forward), not a Request, so there is no way to accidentally pass it something
 * client-controlled.
 */
export async function grantIsLive(participant: string): Promise<boolean> {
  const probe = probeFor(participant);
  if (!probe) return true; // "host" (the machine) and "none" have nothing to check

  const now = Date.now();
  const hit = cache.get(participant);
  if (hit && now - hit.at < TTL_MS) return hit.live;

  let live: boolean;
  try {
    live = await probe();
  } catch {
    live = true; // transient — don't over-block; the next request re-checks
  }
  cache.set(participant, { live, at: now });
  return live;
}

function probeFor(participant: string): (() => Promise<boolean>) | null {
  if (participant.startsWith("peer:")) {
    const shareId = participant.slice("peer:".length);
    if (!shareId) return null;
    return async () => !!(await client.validateShare(shareId, {}));
  }
  if (participant.startsWith("host:")) {
    const deviceId = participant.slice("host:".length);
    if (!deviceId) return null;
    return async () => !!(await client.hostDeviceLive(deviceId));
  }
  return null;
}

/** How a revoked participant is described to the person holding it. */
export function revokedReason(participant: string): "share revoked" | "device revoked" {
  return participant.startsWith("host:") ? "device revoked" : "share revoked";
}
