import { client } from "@/lib/sandbox-client";
import { proxy, errorResponse } from "@/lib/api-helpers";
import { peerSessionId } from "@/lib/peer-auth";
import { peerShareGuard } from "@/lib/peer-live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const revoked = await peerShareGuard(request);
  if (revoked) return revoked;

  const { id: rawId } = await params;
  const id = parseInt(rawId, 10);
  if (!Number.isFinite(id)) return errorResponse("invalid id", 400);

  // A peer may only fetch a single event if it belongs to the session they were
  // shared into. Forward their bound session so the sandbox enforces ownership
  // (with alias expansion for `claude --resume` cycles) and returns 404 for
  // anything out of scope — this is what backs the scoped search-result detail
  // without leaking event bodies from other sessions. Host: no scope, full read.
  const peerSes = peerSessionId(request);

  return proxy(async () => {
    const row = await client.getEvent(id, peerSes ? { session: peerSes } : undefined);
    if (!row) throw Object.assign(new Error("not found"), { status: 404 });
    return row;
  });
}
