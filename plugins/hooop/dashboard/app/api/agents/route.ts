import { client } from "@/lib/sandbox-client";
import { clampInt } from "@shared/clamp";
import { proxy } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 500, fallback: 50 });
  return proxy(() => client.listAgentRuns(limit));
}
