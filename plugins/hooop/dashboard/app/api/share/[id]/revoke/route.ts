import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAdmitPeers, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Revoke a share. Host (any session) or a full-capability peer (only their own
 * session). The sandbox is the authoritative deny AND re-checks capability +
 * scope: revoking cuts the peer's co-drive (and their view) instantly. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!canAdmitPeers(req)) return errorResponse("forbidden", 403);
  const { id } = await params;
  try {
    const result = await client.revokeShare(id, forwardedParticipant(req));
    if (!result.ok) return errorResponse("unknown share", 404);
    return Response.json({ ok: true });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "revoke failed", status);
  }
}
