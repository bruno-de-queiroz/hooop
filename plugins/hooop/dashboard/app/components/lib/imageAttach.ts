import type { TurnImage } from "@/lib/sandbox-client";

// Image attachment pipeline for the composer: File → { media_type, full base64,
// ≤512px thumbnail }. The model-send path keeps the full-res data; the chat
// path (peers, no model) only needs the thumbnail. Bounds mirror the sandbox's
// chat limits so an attachment that would be rejected server-side is dropped
// here first. Ported from the legacy Composer so the shell shares one pipeline.

export interface AttachedImage {
  id: string;
  name: string;
  media_type: string;
  data: string; // full base64, no data-URL prefix
  thumb?: string; // ≤512px JPEG base64, no prefix
}

export const ALLOWED_IMAGE_MEDIA = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);
export const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // decoded; base64 stays under the 4MB server cap
const THUMB_MAX_DIM = 512;

/** Downscale a data-URL image to a ≤512px JPEG; base64 only (no prefix). Null
 * when the browser can't decode — caller keeps the full data. */
function makeThumb(dataUrl: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onerror = () => resolve(null);
    img.onload = () => {
      const scale = Math.min(1, THUMB_MAX_DIM / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(img, 0, 0, w, h);
      const out = canvas.toDataURL("image/jpeg", 0.8);
      const comma = out.indexOf(",");
      resolve(comma >= 0 ? out.slice(comma + 1) : null);
    };
    img.src = dataUrl;
  });
}

/** FileReader → AttachedImage (prefix stripped, thumbnail attached). Null for
 * disallowed media types, oversized files, or a decode failure. */
export function readImage(file: File): Promise<AttachedImage | null> {
  return new Promise((resolve) => {
    if (!ALLOWED_IMAGE_MEDIA.has(file.type) || file.size > MAX_IMAGE_BYTES) return resolve(null);
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = async () => {
      const url = typeof reader.result === "string" ? reader.result : "";
      const comma = url.indexOf(",");
      const data = comma >= 0 ? url.slice(comma + 1) : "";
      if (!data) return resolve(null);
      const thumb = await makeThumb(url);
      resolve({
        id: `${file.name}-${file.size}-${Math.round(file.lastModified)}`,
        name: file.name,
        media_type: file.type,
        data,
        ...(thumb ? { thumb } : {}),
      });
    };
    reader.readAsDataURL(file);
  });
}

/** Read a batch of files, keeping only decodable images, capped to the room
 * left under MAX_ATTACHMENTS. */
export async function readImages(files: File[], alreadyAttached: number): Promise<AttachedImage[]> {
  const room = Math.max(0, MAX_ATTACHMENTS - alreadyAttached);
  if (room === 0) return [];
  const imgs = files.filter((f) => f.type.startsWith("image/")).slice(0, room);
  const read = await Promise.all(imgs.map(readImage));
  return read.filter((a): a is AttachedImage => a != null);
}

/** Model-send payload: full-res `data` for the model (no dimension cap there),
 * plus the ≤512px `thumb` that gets persisted to the event stream and broadcast
 * to peers. Omitting the thumb makes the sandbox fall back to validating the
 * full image against the tighter thumbnail dimension cap — which rejects any
 * image wider/taller than 1024px ("thumbnail rejected"). */
export function toSendImages(atts: AttachedImage[]): TurnImage[] {
  return atts.map((a) => ({
    media_type: a.media_type,
    data: a.data,
    ...(a.thumb ? { thumb: a.thumb } : {}),
  }));
}

/** Thumbnail payload for a chat broadcast (no model on this path). */
export function toChatImages(atts: AttachedImage[]): TurnImage[] {
  return atts.map((a) => ({
    media_type: a.thumb ? "image/jpeg" : a.media_type,
    data: a.thumb ?? a.data,
  }));
}

/** A displayable data URL for an attachment's preview thumbnail. */
export function previewUrl(a: AttachedImage): string {
  return `data:${a.thumb ? "image/jpeg" : a.media_type};base64,${a.thumb ?? a.data}`;
}
