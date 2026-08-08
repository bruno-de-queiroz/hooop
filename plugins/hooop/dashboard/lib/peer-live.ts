import { client } from "@/lib/sandbox-client";
import { participantOf } from "@/lib/peer-auth";
import { errorResponse } from "@/lib/api-helpers";

/**
 * Revocation guard for peer READ paths.
 *
 * Peer write actions (turn/bash/permission) are re-validated sandbox-side on
 * every call, so revoking cuts them instantly. Reads (events, session list,
 * summary, …) only checked the token + session scope — and the signed token
 * stays cryptographically valid after revocation — so a revoked peer kept
 * *seeing* the session. This closes that: for a peer, confirm the share is
 * still live (sandbox is the authority) before serving.
 *
 * A tiny TTL cache keeps a polling peer from adding a sandbox round-trip on
 * every read; revocation lands within the TTL. Only an explicit "share gone"
 * (validateShare → null / 404) blocks — transient sandbox errors are allowed
 * through so a blip doesn't wrongly lock out a legitimate peer (their reads
 * would be empty anyway if the sandbox is truly down).
 */
const TTL_MS = 3000;
const cache = new Map<string, { live: boolean; at: number }>();

/** Returns a 403 Response if the caller is a peer whose share was revoked,
 * else null (host/none always pass). Use: `const g = await peerShareGuard(req); if (g) return g;` */
export async function peerShareGuard(req: Request): Promise<Response | null> {
  const p = participantOf(req);
  if (p.kind !== "peer") return null;

  const now = Date.now();
  const hit = cache.get(p.shareId);
  if (hit && now - hit.at < TTL_MS) {
    return hit.live ? null : errorResponse("share revoked", 403);
  }

  let live: boolean;
  try {
    const rec = await client.validateShare(p.shareId, {});
    live = !!rec; // null = 404 = revoked/expired
  } catch {
    live = true; // transient error → don't over-block; next read re-checks
  }
  cache.set(p.shareId, { live, at: now });
  return live ? null : errorResponse("share revoked", 403);
}
