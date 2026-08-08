import { NextRequest, NextResponse } from "next/server";
import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse, boundedString } from "@/lib/api-helpers";
import { participantOf, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Register (POST) or drop (DELETE) this browser's push subscription.
 *
 * The caller supplies only the endpoint and keys their browser minted. WHO they
 * are and WHICH session they may hear about come from the trusted participant
 * headers and, for a peer, from the share record sandbox-side — never from the
 * request body. So a peer cannot subscribe themselves to another session.
 */
export async function POST(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);

  const { body } = await parseJsonBody<{ endpoint?: unknown; keys?: unknown }>(req, { maxBytes: 8 * 1024 });
  const endpoint = boundedString(body?.endpoint, 2048);
  // A subscription endpoint is always an https URL supplied by the browser's
  // push service; anything else is a malformed or hand-rolled payload.
  if (!endpoint || !/^https:\/\//i.test(endpoint)) return errorResponse("invalid endpoint", 400);

  const keys = body?.keys as { p256dh?: unknown; auth?: unknown } | undefined;
  const p256dh = boundedString(keys?.p256dh, 256);
  const auth = boundedString(keys?.auth, 256);
  if (!p256dh || !auth) return errorResponse("missing subscription keys", 400);

  try {
    const r = await client.pushSubscribe({ endpoint, keys: { p256dh, auth } }, forwardedParticipant(req));
    return NextResponse.json(r);
  } catch {
    return errorResponse("could not reach the sandbox", 502);
  }
}

export async function DELETE(req: NextRequest) {
  const who = participantOf(req);
  if (who.kind === "none") return errorResponse("forbidden", 403);

  const { body } = await parseJsonBody<{ endpoint?: unknown }>(req, { maxBytes: 8 * 1024 });
  const endpoint = boundedString(body?.endpoint, 2048);
  if (!endpoint) return errorResponse("invalid endpoint", 400);

  try {
    return NextResponse.json(await client.pushUnsubscribe(endpoint, forwardedParticipant(req)));
  } catch {
    return errorResponse("could not reach the sandbox", 502);
  }
}
