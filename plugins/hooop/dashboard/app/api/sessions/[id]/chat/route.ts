import { NextRequest } from "next/server";
import { client, type TurnImage } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody } from "@/lib/api-helpers";
import { forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Chat carries ≤512 image thumbnails (never a full-res copy — there's no model
// on this path), so the whole payload stays small. Bounds mirror the sandbox.
const MAX_TURN_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 10_000;
const MAX_IMAGES = 8;
const MAX_IMAGES_B64 = 512 * 1024;
const ALLOWED_MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  const { body, error } = await parseJsonBody<{ text?: unknown; images?: unknown }>(req, { maxBytes: MAX_TURN_BYTES + 1024 });
  if (error) return error;

  const text = typeof body.text === "string" ? body.text.slice(0, MAX_TEXT) : "";
  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES) return errorResponse(`too many images (max ${MAX_IMAGES})`, 413);
  const images: TurnImage[] = [];
  let bytes = 0;
  for (const it of rawImages) {
    const o = it && typeof it === "object" ? (it as { media_type?: unknown; data?: unknown }) : {};
    if (typeof o.media_type !== "string" || !ALLOWED_MEDIA.has(o.media_type)) return errorResponse("unsupported image media_type", 400);
    if (typeof o.data !== "string" || o.data.length === 0) return errorResponse("empty image data", 400);
    bytes += o.data.length;
    images.push({ media_type: o.media_type, data: o.data });
  }
  if (bytes > MAX_IMAGES_B64) return errorResponse(`chat images too large (max ${Math.floor(MAX_IMAGES_B64 / 1024)}KB total)`, 413);
  if (!text.trim() && images.length === 0) return errorResponse("empty chat message", 400);

  try {
    await client.sendChat(sessionId, text, images.length ? images : undefined, forwardedParticipant(req));
    return Response.json({ ok: true });
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "chat failed", status);
  }
}
