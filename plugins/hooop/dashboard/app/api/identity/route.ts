import { client } from "@/lib/sandbox-client";
import { proxy, errorResponse } from "@/lib/api-helpers";
import { isPeer } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/identity
 *
 * Thin proxy to the sandbox's /identity endpoint. The sandbox owns the
 * canonical view of who the user is — it reads `~/.claude.json` and
 * `~/.claude/hooop/profile.md` from inside its own profile, which is
 * where the launcher seeds OAuth state and where `hooop:setup` writes
 * the user-confirmed identity fields.
 */
export async function GET(req: Request) {
  // The host's identity (name/role/email/org) is private — never expose it to
  // a shared-session guest.
  if (isPeer(req)) return errorResponse("forbidden", 403);
  return proxy(() => client.getIdentity());
}
