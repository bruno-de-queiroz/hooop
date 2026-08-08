import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { forwardedParticipant, canAccessSession } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Per-step output for one preview. `?step=N` for a single step; -1 is `run`. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; pid: string }> },
) {
  const { id: sessionId, pid } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("out of session scope", 403);

  const raw = req.nextUrl.searchParams.get("step");
  let step: number | undefined;
  if (raw !== null) {
    step = parseInt(raw, 10);
    if (!Number.isFinite(step)) return errorResponse("step must be an integer", 400);
  }
  try {
    return Response.json(await client.previewLogs(sessionId, pid, step, forwardedParticipant(req)));
  } catch (e: any) {
    return errorResponse(e?.message ?? "could not read preview logs", typeof e?.status === "number" ? e.status : 500);
  }
}
