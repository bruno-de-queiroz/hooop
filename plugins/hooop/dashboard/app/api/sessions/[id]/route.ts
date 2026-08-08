import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";
import { isHost } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_NAME_LEN = 200;

// Destroying or renaming a shared session is host-only: a guest may co-drive
// (turns/bash/approvals) but must not delete, end, or rename it. The
// participant header is injected (and any client value stripped) by middleware,
// so isHost() is trustworthy.
const HOST_ONLY = "this action is host-only";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isHost(req)) return errorResponse(HOST_ONLY, 403);
  const { id } = await params;
  try {
    const result = await client.deleteSession(id);
    return Response.json({ ok: true, ...result });
  } catch (e: any) {
    return errorResponse(e?.message ?? "delete failed", 500);
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!isHost(req)) return errorResponse(HOST_ONLY, 403);
  const { id } = await params;
  const { body, error } = await parseJsonBody<{ name?: unknown }>(req, { maxBytes: 4 * 1024 });
  if (error) return error;
  const name = boundedString(body.name, MAX_NAME_LEN);
  if (name == null) {
    return errorResponse("missing required field: name", 400);
  }
  const meta = await client.renameSession(id, name);
  if (!meta) {
    return errorResponse("session not found", 404);
  }
  return Response.json({ ok: true, meta });
}
