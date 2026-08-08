import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAdmitPeers, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Admit a pending peer join. Host (any session) or a full-capability peer
 * (only into the session they're in). The peer's claim then issues the peer
 * cookie and they enter the session. The sandbox re-checks capability + scope
 * independently, so this route guard is defense in depth, not the sole gate. */
export async function POST(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  if (!canAdmitPeers(req)) return errorResponse("forbidden", 403);
  const { ticket } = await params;
  try {
    const result = await client.admitJoin(ticket, forwardedParticipant(req));
    if (!result.ok) return errorResponse("unknown or already-resolved join", 404);
    return Response.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "admit failed", status);
  }
}
