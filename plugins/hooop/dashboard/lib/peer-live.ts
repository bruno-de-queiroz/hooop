import { client } from "@/lib/sandbox-client";
import { participantOf } from "@/lib/peer-auth";
import { errorResponse } from "@/lib/api-helpers";

/**
 * Revocation guard for READ paths — for every credential that can be revoked.
 *
 * Write actions are re-validated sandbox-side on every call, so revoking cuts
 * them instantly. Reads (events, session list, summary, …) only checked the token
 * and scope — and a signed token stays cryptographically valid after revocation —
 * so a revoked participant kept *seeing* the session. This closes that: ask the
 * sandbox, which is the authority, whether the grant is still live before serving.
 *
 * There are TWO revocable kinds now, and the second is why this is no longer
 * called `peerShareGuard`:
 *   - a PEER's share.
 *   - the host's own enrolled DEVICE. It used to pass here unchecked, because
 *     "host" meant "the machine, authenticated by hostname, with nothing to
 *     revoke". A device breaks that assumption: it is a revocable bearer grant on
 *     a public URL. Letting it through meant a revoked phone kept reading the
 *     session list, the transcript and search for as long as its token had left —
 *     worse than a revoked peer, who is at least confined to one session.
 *
 * The host AT THE MACHINE still passes untouched: their authority is the install
 * cookie, which has no revocation to check.
 *
 * A tiny TTL cache keeps a polling client from adding a sandbox round-trip to
 * every read; revocation lands within the TTL. Only an explicit "grant is gone"
 * (404) blocks — transient sandbox errors are allowed through so a blip doesn't
 * wrongly lock out a legitimate participant (their reads would be empty anyway if
 * the sandbox is truly down).
 */
const TTL_MS = 3000;
const cache = new Map<string, { live: boolean; at: number }>();

/** Returns a 403 Response when the caller's grant has been revoked, else null
 * (the local host and unauthenticated callers always pass).
 * Use: `const g = await revokedGrantGuard(req); if (g) return g;` */
export async function revokedGrantGuard(req: Request): Promise<Response | null> {
  const p = participantOf(req);

  if (p.kind === "peer") {
    return check(
      `peer:${p.shareId}`,
      async () => !!(await client.validateShare(p.shareId, {})),
      "share revoked",
    );
  }
  // A device rather than the machine — `deviceId` present is exactly that
  // distinction, and the only case where "host" is something that can be taken
  // away.
  if (p.kind === "host" && p.deviceId) {
    const deviceId = p.deviceId;
    return check(
      `host:${deviceId}`,
      async () => !!(await client.hostDeviceLive(deviceId)),
      "device revoked",
    );
  }
  return null;
}

async function check(
  key: string,
  probe: () => Promise<boolean>,
  message: string,
): Promise<Response | null> {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) {
    return hit.live ? null : errorResponse(message, 403);
  }

  let live: boolean;
  try {
    live = await probe(); // false = 404 = revoked/expired
  } catch {
    live = true; // transient error → don't over-block; the next read re-checks
  }
  cache.set(key, { live, at: now });
  return live ? null : errorResponse(message, 403);
}
