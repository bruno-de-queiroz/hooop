/**
 * Validation for peer-supplied image byte arrays. Images arrive as base64 from
 * ANY turn-capable participant (host or peer), go to the model, and — as a
 * thumbnail — are broadcast to every other participant's browser. So the bytes
 * are untrusted. This guard enforces, dependency-free:
 *
 *   1. valid base64 (charset + padding) — nothing but base64 reaches stdin/JSON;
 *   2. magic-byte match — the declared media_type MUST match the real bytes, so
 *      a peer can't smuggle SVG/HTML/script/binary under an image/png label;
 *   3. a dimension cap — a small base64 can decode to a huge bitmap
 *      (decompression bomb); we reject those before they DoS a viewer's browser.
 *
 * Note: SVG is intentionally not an accepted type (it can carry script); the
 * only accepted types are raster formats that <img> never executes.
 */

const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

type Media = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

function signatureMatches(b: Buffer, mt: string): boolean {
  switch (mt) {
    case "image/png":
      return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
        b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
    case "image/jpeg":
      return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    case "image/gif":
      return b.length >= 6 && /^GIF8[79]a$/.test(b.toString("ascii", 0, 6));
    case "image/webp":
      return b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP";
    default:
      return false;
  }
}

/** Best-effort dimensions; null when a format isn't parsed here (webp) or the
 * header is malformed — the signature check has already confirmed the type. */
function dimensions(b: Buffer, mt: string): { width: number; height: number } | null {
  try {
    if (mt === "image/png" && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (mt === "image/gif" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    if (mt === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        // Start-of-frame markers carry the dimensions (skip DHT/JPG/DAC).
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + b.readUInt16BE(i + 2); // skip this segment
      }
    }
  } catch { /* malformed header → treat as unknown dims */ }
  return null;
}

export interface ImageGuardResult {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a base64 image against its declared media type and a max dimension.
 * `maxDim` guards against decompression bombs (esp. for broadcast thumbnails).
 */
export function validateImageBase64(b64: string, declared: string, maxDim: number): ImageGuardResult {
  if (typeof b64 !== "string" || !B64_RE.test(b64) || b64.length % 4 !== 0) {
    return { ok: false, reason: "image data is not valid base64" };
  }
  const buf = Buffer.from(b64, "base64");
  if (buf.length === 0) return { ok: false, reason: "empty image" };
  if (!signatureMatches(buf, declared)) {
    return { ok: false, reason: `image bytes do not match declared type ${declared}` };
  }
  const dim = dimensions(buf, declared as Media);
  if (dim && (dim.width > maxDim || dim.height > maxDim || dim.width < 1 || dim.height < 1)) {
    return { ok: false, reason: `image dimensions ${dim.width}x${dim.height} exceed ${maxDim}px` };
  }
  return { ok: true };
}
