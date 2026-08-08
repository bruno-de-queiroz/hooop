import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAdmitPeers, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Pending peer joins awaiting Admit/Deny. Host sees all; a full-capability
 * peer sees only their own session's (the sandbox scopes + re-validates). */
export async function GET(req: Request) {
  if (!canAdmitPeers(req)) return errorResponse("forbidden", 403);
  try {
    return Response.json(await client.listPendingJoins(forwardedParticipant(req)));
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "list failed", status);
  }
}
