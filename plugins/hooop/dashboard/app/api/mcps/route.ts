import { client } from "@/lib/sandbox-client";
import { proxy } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return proxy(() => client.listMcps());
}
