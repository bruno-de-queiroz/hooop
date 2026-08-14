import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAccessSession, forwardedParticipant } from "@/lib/peer-auth";
import { revokedGrantGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Cancel a session's burn-after-use flag. One-way by design: burn is ARMED at
 * creation (see /api/sessions/new, host-only) and this route can only turn it
 * off. `burn: true` is rejected here as well as sandbox-side, because the
 * capability this route grants (host OR full-access peer, inherited from the
 * auto-mode pattern) is the wrong bar for arming self-destruction on a session
 * you do not own — a co-driver could otherwise schedule the deletion of the
 * host's transcript, workspace, events and shares.
 *
 * The sandbox is authoritative on capability, but we still scope-check +
 * share-guard here first (defense in depth, matching the auto-mode route).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("forbidden: out of session scope", 403);
  const revoked = await revokedGrantGuard(req);
  if (revoked) return revoked;
  const body = (await req.json().catch(() => null)) as { burn?: unknown } | null;
  if (typeof body?.burn !== "boolean") return errorResponse("missing required field: burn (boolean)", 400);
  if (body.burn) {
    return errorResponse("burn-after-use can only be armed when the session is created", 400);
  }
  try {
    const res = await client.setSessionBurnAfterUse(sessionId, body.burn, forwardedParticipant(req));
    return Response.json(res);
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "burn-after-use toggle failed", status);
  }
}
