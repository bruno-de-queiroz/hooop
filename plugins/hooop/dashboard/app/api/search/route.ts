import { client } from "@/lib/sandbox-client";
import type { SearchType } from "@/lib/sandbox-types";
import { parseJsonBody, errorResponse } from "@/lib/api-helpers";
import { clampInt } from "@shared/clamp";
import { peerSessionId } from "@/lib/peer-auth";
import { peerShareGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_Q = 1024;
const MAX_BODY = 64 * 1024;
const VALID_TYPES: SearchType[] = ["bm25", "semantic", "hybrid"];

function normalizeType(v: unknown): SearchType {
  if (typeof v === "string" && (VALID_TYPES as string[]).includes(v)) return v as SearchType;
  return "bm25";
}

export async function POST(request: Request) {
  const revoked = await peerShareGuard(request);
  if (revoked) return revoked;

  const { body, error } = await parseJsonBody<{
    q?: unknown;
    type?: unknown;
    mode?: unknown;
    limit?: unknown;
  }>(request, { maxBytes: MAX_BODY });
  if (error) return error;

  if (typeof body.q !== "string") {
    return errorResponse("q must be a string", 400);
  }
  if (body.q.length > MAX_Q) {
    return errorResponse(`q too long (max ${MAX_Q})`, 400);
  }

  const type = normalizeType(body.type ?? body.mode);
  const limit = clampInt(body.limit, { min: 1, max: 200, fallback: 20 });

  // Search spans every session's events, so an unscoped query would let a peer
  // surface activity from sessions they were never shared into. Pin a peer's
  // search to their bound session (the sandbox expands aliases and filters in
  // SQL, so ranking/limit apply within their session). Host: unscoped.
  const session = peerSessionId(request) ?? undefined;

  const result = await client.search(body.q, type, limit, session);
  return Response.json(result);
}
