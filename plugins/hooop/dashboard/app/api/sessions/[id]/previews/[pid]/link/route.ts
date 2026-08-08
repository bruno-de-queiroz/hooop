import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { forwardedParticipant, canAccessSession, participantOf } from "@/lib/peer-auth";
import { peerSigningSecret } from "@/lib/peer-token";
import {
  signPreviewToken,
  normalizePreviewHost,
  PREVIEW_AUTH_PREFIX,
  PREVIEW_TOKEN_TTL_MS,
} from "@/lib/preview-token";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Mint this viewer's own link to a preview.
 *
 * ON DEMAND, per participant — which is what makes a mid-session joiner work.
 * A grant is not handed out once when the preview is shared and then passed
 * around; anyone who passes the session's ordinary scope check can ask for one
 * at any time, so a peer admitted an hour later simply fetches a link. No
 * re-approval, no host action, nothing to re-run.
 *
 * The grant is not the authorization either. It names the share behind it, and
 * the front process re-checks that share against the sandbox on every request —
 * so revoking access cuts the preview within seconds even though the token in
 * the peer's cookie is still cryptographically valid.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pid: string }> },
) {
  const { id: sessionId, pid } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("out of session scope", 403);

  const secret = peerSigningSecret();
  if (!secret) return errorResponse("sharing is not configured on this install", 503);

  // Read through the sandbox so the preview's existence, session scope and
  // capability are checked by the authority rather than assumed here.
  let preview;
  try {
    const { previews } = await client.listPreviews(sessionId, forwardedParticipant(req));
    preview = previews.find((p) => p.previewId === pid);
  } catch (e: any) {
    return errorResponse(e?.message ?? "could not read previews", typeof e?.status === "number" ? e.status : 500);
  }
  if (!preview) return errorResponse("unknown preview", 404);

  const who = participantOf(req);
  const isHost = who.kind === "host";

  // A peer can only be sent to the tunnel hostname; a loopback port is
  // meaningless from another machine. Conversely the host does not need a
  // tunnel at all, which is why a solo preview never starts one.
  //
  // The host's slot port is published on whatever interface the DASHBOARD is
  // published on, so the only hostname guaranteed to reach it is the one this
  // viewer just used to reach us. Hardcoding 127.0.0.1 assumed the browser runs
  // on the same machine as Docker, which breaks the moment it doesn't: over an
  // SSH tunnel, from another machine on HOOOP_BIND_ADDR=0.0.0.0, or from a
  // container via host.docker.internal, `127.0.0.1:<slot>` resolves to the
  // VIEWER's own loopback and the iframe just reports "refused to connect".
  // Reflecting the Host header keeps the rule "if you can reach :7842 this way,
  // you can reach :<slot> the same way" true by construction.
  //
  // This is also what keeps the token honest: `host` below is derived from
  // `target`, and the front process rejects any mismatch against the request's
  // Host header (see server.mjs, "wrong-host"). So the grant stays pinned to a
  // single hostname — now the correct one instead of a guessed one.
  // Once SHARED, everyone — the host included — goes through the tunnel. The
  // host opening their published app in a new tab should see the same URL, on
  // the same origin, that they just handed to everyone else; a private local
  // address there means the thing they are looking at is not the thing they
  // shared. This requires authorizePreview to accept a host grant over the
  // tunnel, which it now does (see server.mjs) — until it did, this exact line
  // produced the "Not available" page for the person who published the preview.
  //
  // UNSHARED, the host gets the direct slot port on whatever hostname they
  // reached us on. Not a hardcoded 127.0.0.1: that assumed the browser runs on
  // the Docker host, which breaks over an SSH tunnel, from another machine on
  // HOOOP_BIND_ADDR=0.0.0.0, or from a container via host.docker.internal.
  const viewerHost = normalizePreviewHost(req.headers.get("host")) || "127.0.0.1";
  const localTarget = `http://${viewerHost}:${preview.slotPort}`;

  // FRAMING and SHARING are different questions, and answering them with one URL
  // is what broke the host's own panel.
  //
  // The grant is a cookie, and a cookie in a cross-site IFRAME is not the same
  // animal as one in a top-level tab. `SameSite=Lax` is withheld from any
  // request whose site differs from the TOP-LEVEL site — so framing the tunnel
  // origin inside a dashboard served from another site redeemed the grant
  // successfully (claim → 200) and was then refused on the very next request
  // (GET / → 401), which is the "Not available" page appearing in the panel
  // while the identical URL worked in a new tab.
  //
  // So the host frames the slot port on the hostname they reached us on: a
  // different ORIGIN (which is what isolates preview JS from the hooop API) but
  // the same SITE, so the cookie travels. Sharing no longer changes what the
  // host frames — it only adds a second, public URL to hand out.
  //
  // A peer has no same-site option: their dashboard and the preview are on two
  // different `*.trycloudflare.com` hostnames, and that domain is on the Public
  // Suffix List, so those are separate sites by definition. Their iframe is
  // unavoidably third-party, which is why the cookie is issued with
  // `SameSite=None; Secure; Partitioned` for HTTPS viewers (see server.mjs).
  const frameTarget = isHost ? localTarget : preview.publicUrl;
  if (!frameTarget) {
    return errorResponse(
      "this preview has not been shared yet, so it is only reachable by the host",
      409,
    );
  }

  // Each grant is pinned to ONE hostname (the front process rejects a mismatch
  // against the request's Host header), so a viewer who gets both a framed URL
  // and a public one needs a token for each. Two signatures, same authority.
  const mint = (target: string) =>
    signPreviewToken(
      {
        pv: preview.previewId,
        ses: preview.sessionId,
        sid: who.kind === "peer" ? who.shareId : "host",
        host: normalizePreviewHost(new URL(target).host),
        exp: Date.now() + PREVIEW_TOKEN_TTL_MS,
      },
      secret,
    );

  // The grant rides in the URL FRAGMENT: browsers never send it to a server, so
  // it stays out of Cloudflare's access logs and out of `Referer`. The listener
  // serves a tiny shell at this path that reads the hash and exchanges it for a
  // host-bound cookie. Same shape as the peer /join redemption.
  const redeemUrl = (target: string, token: string) =>
    `${target}${PREVIEW_AUTH_PREFIX}/preview-auth#${token}`;

  const frameUrl = redeemUrl(frameTarget, await mint(frameTarget));

  // The public link, for the new-tab affordance and for anything the host hands
  // to someone else. Only ever the tunnel — a loopback port means nothing on
  // another machine — and null until the preview is shared.
  const publicUrl = preview.publicUrl
    ? redeemUrl(preview.publicUrl, await mint(preview.publicUrl))
    : null;

  return Response.json({
    url: frameUrl,
    // For the iframe: once the cookie is set, the plain origin is what to load.
    origin: frameTarget,
    publicUrl,
    shared: !!preview.publicUrl,
  });
}
