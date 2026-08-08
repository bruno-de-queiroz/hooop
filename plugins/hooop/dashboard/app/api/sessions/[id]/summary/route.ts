import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAccessSession } from "@/lib/peer-auth";
import { peerShareGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("forbidden: out of session scope", 403);
  const revoked = await peerShareGuard(req);
  if (revoked) return revoked;
  return Response.json(await client.getSessionSummary(sessionId));
}
