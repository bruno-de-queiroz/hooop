import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const cwd = req.nextUrl.searchParams.get("cwd") ?? undefined;
  return Response.json(await client.listSlashCommands({ cwd }));
}
