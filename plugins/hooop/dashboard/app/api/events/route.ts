import { client } from "@/lib/sandbox-client";
import { clampInt } from "@shared/clamp";
import { proxy, errorResponse } from "@/lib/api-helpers";
import { peerSessionId } from "@/lib/peer-auth";
import { peerShareGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const revoked = await peerShareGuard(request);
  if (revoked) return revoked;

  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 1000, fallback: 200 });
  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw != null ? parseInt(beforeRaw, 10) : undefined;
  const hook = url.searchParams.get("hook");
  const tool = url.searchParams.get("tool");
  let session = url.searchParams.get("session");

  // A peer may only read events for the session they were shared into. The
  // unscoped feed (no `session`) is the host-only global event history — a peer
  // requesting it would be reaching for other sessions' activity, so refuse it
  // outright rather than silently narrowing. Any explicit `session` must match
  // their bound session. The transcript always passes `session`, so this only
  // blocks the host-only Events panel/drawer, never a legitimate peer read.
  const peerSes = peerSessionId(request);
  if (peerSes) {
    if (!session) {
      return errorResponse("forbidden: event history is host-only", 403);
    }
    if (session !== peerSes) {
      return errorResponse("forbidden: out of session scope", 403);
    }
  }

  return proxy(() =>
    client.listEvents({
      limit,
      before: Number.isFinite(before) ? before : undefined,
      hook: hook ?? undefined,
      tool: tool ?? undefined,
      session: session ?? undefined,
    }),
  );
}
