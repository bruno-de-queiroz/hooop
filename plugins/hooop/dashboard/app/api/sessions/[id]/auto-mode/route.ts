import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";
import { canAccessSession, forwardedParticipant } from "@/lib/peer-auth";
import { revokedGrantGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Toggle unattended auto-approval (auto mode). The sandbox is authoritative on
 * capability — only the host or a full-access peer may change it — but we still
 * scope-check + share-guard here first (defense in depth, matching the model route).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  if (!canAccessSession(req, sessionId)) return errorResponse("forbidden: out of session scope", 403);
  const revoked = await revokedGrantGuard(req);
  if (revoked) return revoked;
  const body = (await req.json().catch(() => null)) as { auto?: unknown } | null;
  if (typeof body?.auto !== "boolean") return errorResponse("missing required field: auto (boolean)", 400);
  try {
    const res = await client.setSessionAutoMode(sessionId, body.auto, forwardedParticipant(req));
    return Response.json(res);
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "auto-mode toggle failed", status);
  }
}
