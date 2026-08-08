import { client } from "@/lib/sandbox-client";
import { errorResponse, proxy } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Single-file preview backing the file-preview dock: git status + parsed diff
 * (or an all-adds diff for new files) + capped/binary-guarded content. `path`
 * is relative to the session cwd; both are query params so the route is
 * stateless. The sandbox enforces the cwd policy and the content read cap.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const path = url.searchParams.get("path");
  if (!cwd) return errorResponse("missing required query param: cwd", 400);
  if (!path) return errorResponse("missing required query param: path", 400);
  return proxy(() => client.getFilePreview(cwd, path));
}
