import { client } from "@/lib/sandbox-client";
import { errorResponse } from "@/lib/api-helpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Raw image bytes for the file-preview dock. `path` is relative to the session
 * cwd; the sandbox enforces the cwd policy, the extension/magic-byte agreement
 * and the size cap (lib/files.ts `readImageWithinCwd`).
 *
 * Not `proxy()`: that helper answers JSON, and this route's whole point is to
 * hand the browser real bytes with an image Content-Type so `<img>` can cache
 * and decode them. The sandbox sends base64 because its client decodes every
 * response body as UTF-8 — that encoding stops here, so base64 never reaches
 * the page.
 *
 * Access matches `/api/files/preview` exactly, which is to say the sandbox's cwd
 * policy is the gate. There is no file-navigation capability on a share
 * (ShareRecord carries only full/drive/spectate) and none of the files routes
 * check the participant, so every peer can already read any file's text; images
 * expose nothing further. Tightening all of the files routes is worth doing, but
 * as its own change rather than a side effect of this one.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd");
  const path = url.searchParams.get("path");
  if (!cwd) return errorResponse("missing required query param: cwd", 400);
  if (!path) return errorResponse("missing required query param: path", 400);

  let raw: Awaited<ReturnType<typeof client.getFileRaw>>;
  try {
    raw = await client.getFileRaw(cwd, path);
  } catch (e: any) {
    const status = typeof e?.status === "number" ? e.status : 500;
    return errorResponse(e?.message ?? "image read failed", status);
  }

  // The media type is whatever the sandbox's allowlist agreed on; a value from
  // outside it means the two sides have drifted, and guessing would be worse
  // than refusing. Never derived from anything the caller sent.
  if (!RENDERABLE.has(raw.mediaType)) {
    return errorResponse(`unsupported media type: ${raw.mediaType}`, 400);
  }

  const bytes = Buffer.from(raw.base64, "base64");
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": raw.mediaType,
      "Content-Length": String(bytes.byteLength),
      // SVG is the reason for both of these. `nosniff` stops a browser
      // re-interpreting the response as HTML, and `inline` with an empty
      // filename keeps it out of a download path. Script inside an SVG loaded
      // through <img> does not execute, which is why the dock renders it that
      // way instead of inlining the markup.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      // Private: this is a file out of someone's working directory, so it must
      // not land in a shared cache. Revalidation is driven by the `v=<mtimeMs>`
      // the dock puts in the URL, so a changed image is a different URL.
      "Cache-Control": "private, max-age=300, must-revalidate",
      "ETag": `W/"${raw.size}-${raw.base64.length}"`,
    },
  });
}

/** Mirror of the sandbox's RENDERABLE_IMAGE_TYPES. Duplicated rather than
 * imported: the dashboard is a separate package that talks to the sandbox over a
 * socket and deliberately keeps no build-time dependency on its modules (see
 * lib/sandbox-types.ts). The sandbox stays authoritative — this is a second
 * closed door, not the lock. */
const RENDERABLE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/svg+xml",
]);
