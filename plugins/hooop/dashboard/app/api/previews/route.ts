import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isPeer } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every preview across every session. HOST ONLY.
 *
 * The per-session route answers "what is running for the session I am looking
 * at", which is the wrong question when three slots are shared install-wide: a
 * preview held by a session you are not viewing is invisible, so the only way to
 * find out why "all slots are in use" was to visit each session in turn. This is
 * the operator's inventory.
 *
 * A peer is deliberately refused rather than filtered: the answer names other
 * people's sessions, and a peer is scoped to one.
 */
export async function GET(req: NextRequest) {
  if (isPeer(req)) return errorResponse("host only", 403);
  try {
    return Response.json(await client.listAllPreviews());
  } catch (e: any) {
    return errorResponse(e?.message ?? "could not list previews", typeof e?.status === "number" ? e.status : 500);
  }
}
