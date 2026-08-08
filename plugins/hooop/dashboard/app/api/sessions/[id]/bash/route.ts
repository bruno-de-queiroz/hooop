import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody } from "@/lib/api-helpers";
import { forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_COMMAND_LEN = 16 * 1024;

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: sessionId } = await params;
  const { body, error } = await parseJsonBody<{ command?: unknown }>(req, { maxBytes: 32 * 1024 });
  if (error) return error;

  if (typeof body.command !== "string" || body.command.trim().length === 0) {
    return errorResponse("missing required field: command", 400);
  }
  if (body.command.length > MAX_COMMAND_LEN) {
    return errorResponse("command too long (>16kb)", 413);
  }

  try {
    const result = await client.runBashShortcut(sessionId, body.command, forwardedParticipant(req));
    return Response.json(result);
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "bash exec failed", status);
  }
}
