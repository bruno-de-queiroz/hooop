import { client } from "@/lib/sandbox-client";
import { proxy } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/stack
 *
 * Thin proxy to the sandbox's /stack endpoint. The sandbox enumerates its
 * own installed_plugins.json + install-log.md (both inside the sandbox
 * profile) and returns the rolled-up StackResponse.
 */
export async function GET() {
  return proxy(() => client.getStack());
}
