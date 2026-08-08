import { client } from "@/lib/sandbox-client";
import { proxy, errorResponse } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const n = parseInt(id, 10);
  if (!Number.isFinite(n)) return errorResponse("invalid id", 400);

  return proxy(async () => {
    const run = await client.getAgentDetail(n);
    if (!run) throw Object.assign(new Error("not found"), { status: 404 });
    return run;
  });
}
