import { client } from "@/lib/sandbox-client";
import { parseJsonBody, errorResponse } from "@/lib/api-helpers";
import { isHost, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface CodeBody {
  /** Full public base URL of the tunnel, e.g. https://abc.trycloudflare.com */
  publicBaseUrl?: string;
  /** Label for the device list ("Pixel 8"). Optional; the phone can also name
   *  itself at enrollment, which wins. */
  label?: string | null;
  /** Lifetime of the resulting device grant. Sandbox clamps it. */
  ttlMs?: number | null;
  /** The session the host is looking at while adding this device. A wake hint
   *  only: a dormant session should be running by the time the device arrives.
   *  Devices are install-wide and never scoped to a session. */
  sessionId?: string | null;
}

/**
 * Mint a single-use enrollment code so the host can add one of their OWN devices.
 *
 * Host-only, and that is the whole security argument for the feature: the code
 * can only be asked for by somebody who already holds host authority, and it is
 * short-lived and single-use, so what the QR carries is a two-minute window to
 * become the host rather than standing permission to.
 *
 * The code comes back in the response body and goes nowhere else. It is not
 * logged, not put in a URL the server sees, and not stored by the dashboard —
 * exactly like a peer token, and for the same reason.
 */
export async function POST(req: Request) {
  if (!isHost(req)) return errorResponse("forbidden", 403);

  const { body, error } = await parseJsonBody<CodeBody>(req);
  if (error) return error;
  if (!body.publicBaseUrl) return errorResponse("missing required field: publicBaseUrl", 400);

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
    const { code, expiresAt, deviceTtlMs } = await client.createHostEnrollCode(
      base.host,
      body.label ?? null,
      body.ttlMs ?? null,
      forwardedParticipant(req),
      typeof body.sessionId === "string" && body.sessionId ? body.sessionId : null,
    );
    // Fragment, not a query param: the enrollment URL is a credential while the
    // code is alive, so it must not reach a server log or a Referer header. Same
    // rule the share link follows.
    const origin = base.origin.replace(/\/$/, "");
    return Response.json({
      code,
      expiresAt,
      deviceTtlMs,
      link: `${origin}/enroll#c=${encodeURIComponent(code)}`,
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "could not mint a code", status);
  }
}
