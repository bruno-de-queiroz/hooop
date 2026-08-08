import { NextRequest, NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import { participantOf, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Read this viewer's mutes: a global flag plus the sessions they've silenced. */
export async function GET(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);
  try {
    return NextResponse.json(await client.pushMutes(forwardedParticipant(req)));
  } catch {
    return errorResponse("could not reach the sandbox", 502);
  }
}

/**
 * Mute or unmute. `sessionId: null` (or omitted) means everything for this
 * viewer. Mutes are per-participant, so one peer silencing a session never
 * affects the host or another peer; the sandbox scopes them by share and
 * refuses a peer muting a session they aren't in.
 */
export async function POST(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);

  const { body } = await parseJsonBody<{ sessionId?: unknown; muted?: unknown }>(req, { maxBytes: 4 * 1024 });
  if (typeof body?.muted !== "boolean") return errorResponse("missing required field: muted", 400);
  const sessionId = body.sessionId == null ? null : boundedString(body.sessionId, 200);
  if (body.sessionId != null && !sessionId) return errorResponse("invalid sessionId", 400);

  try {
    return NextResponse.json(await client.setPushMute(sessionId, body.muted, forwardedParticipant(req)));
  } catch {
    return errorResponse("could not reach the sandbox", 502);
  }
}
