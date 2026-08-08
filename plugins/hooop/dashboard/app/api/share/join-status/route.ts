import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Poll a pending join's admission status. Reachable without a peer cookie
 * (the peer holds only the short-lived pending cookie at this stage) —
 * middleware-allowlisted. Returns only a coarse status; no share details.
 */
export async function GET(req: Request) {
  const ticketId = new URL(req.url).searchParams.get("ticket") ?? "";
  if (!ticketId) return errorResponse("missing ticket", 400);
  try {
    const r = await client.joinStatus(ticketId);
    return Response.json(r);
  } catch {
    // Treat any lookup failure as "gone" so the peer stops waiting.
    return Response.json({ status: "expired" });
  }
}
