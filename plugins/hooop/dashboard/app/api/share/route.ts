import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse } from "@/lib/api-helpers";
import { canAdmitPeers, canAccessSession, forwardedParticipant } from "@/lib/peer-auth";
import { signPeerToken, peerSigningSecret } from "@/lib/peer-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** List active shares. Host sees all; a full-capability peer sees only their own
 * session's (so they can manage/revoke co-guests). The sandbox scopes + re-checks. */
export async function GET(req: Request) {
  if (!canAdmitPeers(req)) return errorResponse("forbidden", 403);
  try {
    const result = await client.listShares(forwardedParticipant(req));
    return Response.json(result);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "list failed", status);
  }
}

interface CreateBody {
  sessionId?: string;
  /** Full public base URL of the host's tunnel, e.g. https://abc.trycloudflare.com */
  publicBaseUrl?: string;
  capability?: "full" | "drive" | "spectate";
  expiresInMs?: number | null;
  peerName?: string | null;
}

/**
 * Create a share grant and return a redeemable link. Host mints for any session;
 * a full-capability peer mints only for the session they're in (the sandbox
 * re-checks capability + scope). The sandbox stores the grant; we sign the
 * stateless peer token here (the dashboard holds the signing secret) and embed it
 * in the link FRAGMENT so it never reaches a server log or Referer.
 */
export async function POST(req: Request) {
  if (!canAdmitPeers(req)) return errorResponse("forbidden", 403);

  const secret = peerSigningSecret();
  if (!secret) {
    return errorResponse(
      "sharing is not configured (HOOOP_PEER_SIGNING_SECRET unset)",
      503,
    );
  }

  const { body, error } = await parseJsonBody<CreateBody>(req);
  if (error) return error;
  if (!body.sessionId) return errorResponse("missing required field: sessionId", 400);
  if (!body.publicBaseUrl) return errorResponse("missing required field: publicBaseUrl", 400);
  // A peer may only mint for their OWN session (first-line gate; sandbox re-checks).
  if (!canAccessSession(req, body.sessionId)) return errorResponse("forbidden", 403);

  let base: URL;
  try {
    base = new URL(body.publicBaseUrl);
  } catch {
    return errorResponse("publicBaseUrl is not a valid URL", 400);
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") {
    return errorResponse("publicBaseUrl must be http(s)", 400);
  }

  try {
    const record = await client.createShare({
      sessionId: body.sessionId,
      publicHost: base.host,
      capability: body.capability ?? "full",
      expiresInMs: body.expiresInMs ?? null,
      peerName: body.peerName ?? null,
    }, forwardedParticipant(req));

    const peerToken = await signPeerToken(
      {
        sid: record.shareId,
        ses: record.sessionId,
        cap: record.capability,
        host: record.publicHost,
        name: record.peerName,
        ...(record.expiresAt ? { exp: record.expiresAt } : {}),
      },
      secret,
    );

    // Token in the fragment (#) — never sent to the server, logs, or Referer.
    const origin = base.origin.replace(/\/$/, "");
    const link = `${origin}/join/${encodeURIComponent(record.shareId)}#k=${peerToken}`;

    return Response.json({
      shareId: record.shareId,
      sessionId: record.sessionId,
      capability: record.capability,
      publicHost: record.publicHost,
      peerName: record.peerName,
      expiresAt: record.expiresAt,
      link,
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "create failed", status);
  }
}
