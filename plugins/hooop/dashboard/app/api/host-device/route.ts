import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost, forwardedParticipant, hostDeviceId } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The host's enrolled devices, for the list they revoke from.
 *
 * Host-only, and an enrolled device may read it too — it IS the host. `thisDevice`
 * marks the row the caller is currently using, so the UI can label it and warn
 * before somebody on their phone revokes the phone they are holding.
 */
export async function GET(req: Request) {
  if (!isHost(req)) return errorResponse("forbidden", 403);
  try {
    const { devices } = await client.listHostDevices(forwardedParticipant(req));
    return Response.json({ devices, thisDevice: hostDeviceId(req) });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    return errorResponse((e as { message?: string })?.message ?? "list failed", status);
  }
}
