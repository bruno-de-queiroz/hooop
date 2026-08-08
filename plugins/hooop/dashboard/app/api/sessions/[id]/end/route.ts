import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { isHost } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/sessions/[id]/end
 *
 * Closes the controllable subprocess gracefully (5s grace, then SIGTERM)
 * and removes the session from the registry + checkpoint. The transcript on
 * disk and in events.db is preserved. Host-only: a guest must not end a
 * shared session out from under the host.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isHost(req)) return errorResponse("this action is host-only", 403);
  const { id } = await params;
  try {
    await client.endSession(id);
    return Response.json({ ok: true });
  } catch (e: any) {
    return errorResponse(e?.message ?? "end failed", 500);
  }
}
