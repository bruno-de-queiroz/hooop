import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";
import { forwardedParticipant, canAccessSession, peerCapabilityOf, isPeer } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The front process owns cloudflared, so tunnel control lives on its own port. */
const FRONT = `http://127.0.0.1:${process.env.HOOOP_PORT || 7842}`;

/**
 * Take a preview from host-local to reachable by everyone in this session.
 *
 * ORDERING IS THE WHOLE POINT of this route. The sandbox cannot call the
 * dashboard — that arrow does not exist, and adding it would invert the trust
 * model — so the dashboard sequences the three steps itself:
 *
 *   1. start a cloudflared tunnel for this preview's slot (front process);
 *   2. record the resulting URL with the sandbox, which flips the preview to
 *      "shared" and puts a marker in the transcript;
 *   3. if this share is answering a pending `share_preview` permission card,
 *      approve it — and pass the URL as the decision `feedback`, which the
 *      existing relay hands straight to the model's parked tool call.
 *
 * Step 3 reuses `respondToPermission` verbatim rather than inventing a second
 * way to answer the gate.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pid: string }> },
) {
  const { id: sessionId, pid } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("out of session scope", 403);
  if (isPeer(req) && peerCapabilityOf(req) !== "full") {
    return errorResponse("only the host or a full-access peer can share a preview", 403);
  }

  const { body, error } = await parseJsonBody<{ slot?: unknown; requestId?: unknown; unshare?: unknown }>(
    req, { maxBytes: 4 * 1024 },
  );
  if (error) return error;

  const requestId = boundedString(body.requestId, 256);
  const participant = forwardedParticipant(req);

  // ── un-share ───────────────────────────────────────────────────────────────
  if (body.unshare === true) {
    const slot = typeof body.slot === "number" ? body.slot : null;
    if (slot !== null) {
      await fetch(`${FRONT}/api/preview-tunnel?slot=${slot}`, {
        method: "DELETE",
        headers: { cookie: req.headers.get("cookie") ?? "", host: req.headers.get("host") ?? "" },
      }).catch(() => { /* tunnel may already be gone; the sandbox is the record */ });
    }
    try {
      return Response.json(await client.setPreviewShared(sessionId, pid, null, participant));
    } catch (e: any) {
      return errorResponse(e?.message ?? "could not un-share", typeof e?.status === "number" ? e.status : 500);
    }
  }

  // ── share ──────────────────────────────────────────────────────────────────
  const slot = typeof body.slot === "number" ? body.slot : null;
  if (slot === null) return errorResponse("missing required field: slot", 400);

  let url: string;
  try {
    const r = await fetch(`${FRONT}/api/preview-tunnel?slot=${slot}`, {
      method: "POST",
      headers: { cookie: req.headers.get("cookie") ?? "", host: req.headers.get("host") ?? "" },
    });
    const payload = (await r.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!r.ok || !payload.url) {
      // Deny the model's parked call rather than leaving it to time out — a
      // gate timeout reads as a flat "denied by the operator", which would hide
      // the real reason (cloudflared could not start).
      if (requestId) {
        await client.respondToPermission(
          sessionId, requestId, "deny", participant, "once",
          `Sharing failed: ${payload.error ?? "could not start the tunnel"}. The preview is still running locally.`,
        ).catch(() => { /* the card may already be gone */ });
      }
      return errorResponse(payload.error ?? "could not start the preview tunnel", 502);
    }
    url = payload.url;
  } catch (e: any) {
    return errorResponse(`could not reach the tunnel controller: ${e?.message ?? e}`, 502);
  }

  let preview;
  try {
    const result = await client.setPreviewShared(sessionId, pid, url, participant);
    preview = result.preview;
  } catch (e: any) {
    return errorResponse(e?.message ?? "could not record the share", typeof e?.status === "number" ? e.status : 500);
  }

  if (requestId) {
    // The reason IS the model's tool result (see respondToPermission's relay).
    await client.respondToPermission(
      sessionId, requestId, "allow", participant, "once",
      `Preview "${preview.spec.name}" is now shared with this session at ${url}. Everyone in the session can open that URL.`,
    ).catch(() => { /* card already resolved; the share itself stands */ });
  }

  return Response.json({ ok: true, url, preview });
}
