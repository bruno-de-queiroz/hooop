import { client } from "@/lib/sandbox-client";
import { proxy, errorResponse } from "@/lib/api-helpers";
import { isHost, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/skill/[name]/run
 *
 * Proxies to sandbox POST /skill/:name/run, which launches the skill as a
 * REGULAR session and returns `{ sessionId }` synchronously; the dashboard
 * snaps to it. `proxy()` preserves the sandbox status — 429 stays 429, 404 404.
 */
export async function POST(req: Request, { params }: { params: Promise<{ name: string }> }) {
  // Host-only: launching a skill session is not a co-drive action. Peers must
  // never trigger it. The sandbox re-checks this independently (defense-in-depth).
  if (!isHost(req)) return errorResponse("this action is host-only", 403);

  const { name } = await params;

  let args: string | undefined;
  try {
    const body = await req.json().catch(() => null);
    if (body && typeof body === "object" && typeof (body as { args?: unknown }).args === "string") {
      args = (body as { args: string }).args;
    }
  } catch { /* empty body is fine */ }

  if (!client.isValidSkillName(name)) {
    return errorResponse("invalid skill name", 400);
  }

  return proxy(() => client.startSkillRun(name, args, forwardedParticipant(req)));
}
