import { client } from "@/lib/sandbox-client";
import { errorResponse, proxy } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Git-decorated file tree for the Files navigator. Scoped to the session's cwd
 * (passed as a query param so the route stays stateless). The sandbox applies
 * the same cwd policy used when spawning a session, so an off-policy or
 * non-existent path 400s.
 *
 * Optional `path` (cwd-relative): fetches the on-demand subtree for a `lazy`
 * node the initial tree left unwalked (e.g. `node_modules`) instead of the
 * whole-cwd tree. Optional `max` caps that subtree's node count — the
 * navigator sends the room left in its accumulated tree; the sandbox clamps
 * it to its own ceiling, so anything malformed or oversized is harmless.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const cwd = params.get("cwd");
  if (!cwd) return errorResponse("missing required query param: cwd", 400);
  const path = params.get("path") ?? undefined;
  const rawMax = params.get("max");
  const max = rawMax && /^\d+$/.test(rawMax) ? Number(rawMax) : undefined;
  return proxy(() => client.getFileTree(cwd, path, max));
}
