import { NextRequest, NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { participantOf, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The public VAPID key, which a browser needs before it can mint a push
 * subscription. Public by construction — the private half never leaves the
 * sandbox — but still participant-gated so an unauthenticated caller learns
 * nothing about the install.
 */
export async function GET(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);
  try {
    return NextResponse.json(await client.pushKey(forwardedParticipant(req)));
  } catch {
    return errorResponse("could not reach the sandbox", 502);
  }
}
