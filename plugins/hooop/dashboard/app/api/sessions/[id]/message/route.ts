import { NextRequest } from "next/server";
import { client, type TurnImage } from "@/lib/sandbox-client";
import { errorResponse, parseJsonBody } from "@/lib/api-helpers";
import { forwardedParticipant } from "@/lib/peer-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_MESSAGE_BYTES = 100_000;
// Turns may carry base64 images (vision). Match the sandbox's bounds so the
// dashboard rejects oversized payloads before proxying them over the socket.
const MAX_TURN_BYTES = 16 * 1024 * 1024;
const MAX_IMAGES = 8;
const MAX_IMAGE_B64 = 4 * 1024 * 1024;
const MAX_THUMBS_B64 = 512 * 1024; // total ≤512px thumbnails persisted in the event
const ALLOWED_MEDIA = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: sessionId } = await params;

  const { body, error } = await parseJsonBody<{ text?: unknown; images?: unknown }>(req, { maxBytes: MAX_TURN_BYTES + 1024 });
  if (error) return error;

  const text = typeof body.text === "string" ? body.text : "";
  if (text.length > MAX_MESSAGE_BYTES) {
    return errorResponse("text too long (>100kb)", 413);
  }

  const rawImages = Array.isArray(body.images) ? body.images : [];
  if (rawImages.length > MAX_IMAGES) return errorResponse(`too many images (max ${MAX_IMAGES})`, 413);
  const images: TurnImage[] = [];
  let thumbBytes = 0;
  for (const it of rawImages) {
    const o = it && typeof it === "object" ? (it as { media_type?: unknown; data?: unknown; thumb?: unknown }) : {};
    if (typeof o.media_type !== "string" || !ALLOWED_MEDIA.has(o.media_type)) return errorResponse("unsupported image media_type", 400);
    if (typeof o.data !== "string" || o.data.length === 0) return errorResponse("empty image data", 400);
    if (o.data.length > MAX_IMAGE_B64) return errorResponse("image too large", 413);
    const thumb = typeof o.thumb === "string" ? o.thumb : undefined;
    thumbBytes += (thumb ?? o.data).length;
    images.push({ media_type: o.media_type, data: o.data, ...(thumb ? { thumb } : {}) });
  }
  if (thumbBytes > MAX_THUMBS_B64) {
    return errorResponse(`image thumbnails too large for the transcript (max ${Math.floor(MAX_THUMBS_B64 / 1024)}KB total) — attach fewer or smaller images`, 413);
  }

  if (!text && images.length === 0) {
    return errorResponse("missing text or images", 400);
  }

  try {
    const result = await client.writeUserTurn(sessionId, text, forwardedParticipant(req), images.length ? images : undefined);
    return Response.json({ ok: true, sessionId: result.sessionId });
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "write failed", status);
  }
}
