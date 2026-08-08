import { NextRequest } from "next/server";
import { client } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody, boundedString } from "@/lib/api-helpers";
import { isHost, forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_GIT_REPO_LEN = 2048;
const MAX_LABEL_LEN = 200;
const MAX_NAME_LEN = 200;
const MAX_MODEL_LEN = 128;

export async function POST(req: NextRequest) {
  // Host-only: creating a session is not a co-drive action. A peer (any
  // capability) is bound to the one session they were admitted to and must
  // never spawn new ones. The sandbox re-checks this independently.
  if (!isHost(req)) return errorResponse("this action is host-only", 403);

  const { body, error } = await parseJsonBody<{ gitRepo?: unknown; label?: unknown; name?: unknown; model?: unknown }>(
    req,
    { maxBytes: 8 * 1024 }
  );
  if (error) return error;

  const gitRepo = boundedString(body.gitRepo, MAX_GIT_REPO_LEN);
  const label = boundedString(body.label, MAX_LABEL_LEN);
  const name = boundedString(body.name, MAX_NAME_LEN);
  const model = boundedString(body.model, MAX_MODEL_LEN);

  try {
    // Folder selection was removed: sessions run in the sandbox workspace, and
    // an optional gitRepo is cloned there on start (validated + cloned
    // server-side in the sandbox, which owns that filesystem).
    const { sessionId, meta } = await client.startNewConversation({
      gitRepo: gitRepo ?? undefined,
      label: label ?? undefined,
      name: name ?? undefined,
      model: model ?? undefined,
      via: "new-conversation",
    }, forwardedParticipant(req));
    return Response.json({ sessionId, meta });
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "spawn failed", status);
  }
}
