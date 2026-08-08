import { client } from "@/lib/sandbox-client";
import { clampInt } from "@shared/clamp";
import { errorResponse, proxy } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Listing endpoint backing the @file autocomplete in the composer. Scoped
 * to the session's cwd (passed as a query param so the route is
 * stateless). The sandbox applies the same cwd policy used when
 * spawning a session, so an off-policy or non-existent path 400s.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) return errorResponse("missing required query param: cwd", 400);
  const q = url.searchParams.get("q") ?? undefined;
  const limit = clampInt(url.searchParams.get("limit"), { min: 1, max: 100, fallback: 20 });

  return proxy(
    () => client.listFiles({ cwd, q, limit }),
    (entries) => ({ entries }),
  );
}
