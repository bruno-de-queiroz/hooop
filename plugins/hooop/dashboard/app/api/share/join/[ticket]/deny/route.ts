import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAdmitPeers, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Deny a pending peer join. Host (any session) or a full-capability peer
 * (only their own session). Denial is treated as hostile: the sandbox revokes
 * the whole share, so the link dies. The sandbox re-checks capability + scope. */
export async function POST(req: Request, { params }: { params: Promise<{ ticket: string }> }) {
  if (!canAdmitPeers(req)) return errorResponse("forbidden", 403);
  const { ticket } = await params;
  try {
    const result = await client.denyJoin(ticket, forwardedParticipant(req));
    if (!result.ok) return errorResponse("unknown or already-resolved join", 404);
    return Response.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "deny failed", status);
  }
}
