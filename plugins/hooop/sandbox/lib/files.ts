import { open, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import { canonicalize, isAllowedCwd } from "./cwd-policy";

export interface FileEntry {
  /**
   * Path relative to the request `cwd`. For nested-path queries (e.g.
   * `q="docs/READ"`) this is the matched item under `docs/`, returned
   * as `docs/README.md` so the dashboard inserts the full mention.
   */
  name: string;
  isDir: boolean;
}

export class CwdPolicyError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CwdPolicyError";
  }
}

/**
 * List entries under `cwd`, optionally filtered by `q`.
 *
 * The query supports two shapes:
 *   - `"foo"` — substring match on basenames in the cwd root.
 *   - `"sub/foo"` — descend into `sub/` (must be within the cwd) and
 *     substring-match on basenames there. The returned `name` includes
 *     the prefix so the caller inserts the full path (`sub/foo.md`).
 *
 * Directories sort first, then files, each group alphabetical. Hidden
 * entries (`.`-prefixed) are omitted unless the last query segment
 * starts with `.`.
 *
 * `cwd` is validated against the same policy as session creation. An
 * out-of-policy / non-existent / escaping path throws `CwdPolicyError`.
 */
export async function listFiles(opts: {
  cwd: string;
  q?: string;
  limit?: number;
}): Promise<FileEntry[]> {
  const policy = isAllowedCwd(opts.cwd);
  if (!policy.ok) throw new CwdPolicyError(policy.reason ?? "cwd not allowed");

  const limit = Math.max(1, Math.min(opts.limit ?? 20, 100));
  const rawQuery = opts.q ?? "";

  // Split the query into "subpath/" + "leaf-query". Everything up to the
  // final `/` is interpreted as a literal subdirectory path under cwd;
  // the trailing segment is the substring matcher applied to entry names
  // at that depth.
  const slashIdx = rawQuery.lastIndexOf("/");
  const subRel = slashIdx >= 0 ? rawQuery.slice(0, slashIdx) : "";
  const leafQuery = (slashIdx >= 0 ? rawQuery.slice(slashIdx + 1) : rawQuery).toLowerCase();
  const showHidden = leafQuery.startsWith(".");

  // Resolve the target directory and reject paths that escape cwd.
  const targetDir = subRel ? join(opts.cwd, subRel) : opts.cwd;
  const normalized = normalize(targetDir);
  if (!isWithin(opts.cwd, normalized)) {
    throw new CwdPolicyError("path escapes cwd");
  }

  let raw: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    raw = (await readdir(normalized, { withFileTypes: true })) as unknown as typeof raw;
  } catch (e: any) {
    throw new CwdPolicyError(`cwd unreadable: ${e?.message ?? normalized}`);
  }

  const entries: FileEntry[] = [];
  for (const d of raw) {
    const baseName = String(d.name);
    if (!showHidden && baseName.startsWith(".")) continue;
    if (leafQuery && !baseName.toLowerCase().includes(leafQuery)) continue;
    const fullName = subRel ? `${subRel}/${baseName}` : baseName;
    entries.push({ name: fullName, isDir: d.isDirectory() });
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return entries.slice(0, limit);
}

function isWithin(parent: string, child: string): boolean {
  const p = normalize(parent).replace(/\/+$/, "");
  const c = normalize(child).replace(/\/+$/, "");
  return c === p || c.startsWith(p + "/");
}

// Resolve a path relative to cwd, joining safely. Exported so the route
// handler can compose nested listings later if needed; for v1 we only
// list the cwd root.
export function resolveUnder(cwd: string, sub: string): string {
  return join(cwd, sub);
}

/**
 * Hard cap on how many bytes of a file we ever read into memory for a preview.
 * The diff navigator and numbered viewer need the whole buffer in memory to
 * render, so a cap (not chunked streaming) is the memory-safe choice; the UI
 * surfaces truncation to the user. 512 KB comfortably covers source files.
 */
export const PREVIEW_MAX_BYTES = 512 * 1024;

// A NUL byte in the first chunk is a strong binary signal (text files don't
// contain them); we refuse to render binary as text.
const BINARY_SNIFF_BYTES = 8 * 1024;

export interface CappedRead {
  /** UTF-8 text of the first ≤maxBytes; null when the file looks binary. */
  content: string | null;
  /** True on-disk size in bytes (not the truncated read length). */
  size: number;
  /** True when the file is larger than what we read (`size > maxBytes`). */
  truncated: boolean;
  binary: boolean;
}

/**
 * Cap for an image the preview will RENDER. Separate from PREVIEW_MAX_BYTES on
 * purpose, and deliberately not shared with the composer's upload limits
 * (dashboard app/components/lib/imageAttach.ts: MAX_IMAGE_BYTES 3 MB,
 * THUMB_MAX_DIM 512) — those bound what a user sends to the model, this bounds
 * what we read off disk to display. Changing one must not move the other.
 *
 * An image is read WHOLE or refused: unlike text, a truncated image decodes to
 * garbage or not at all, so there is no useful "first 512 KB of a PNG".
 */
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Extensions the preview will render, mapped to the Content-Type the raw route
 * is allowed to serve.
 *
 * NOT the same set as the composer's ALLOWED_IMAGE_MEDIA (png/jpeg/webp/gif).
 * Reading a file off disk to display it and accepting an upload to send to the
 * model are different trust decisions with different formats: svg/avif/bmp/ico
 * belong here and must NOT become uploadable as a side effect. Kept apart so
 * neither list can drift into the other.
 */
const IMAGE_TYPES_BY_EXT = new Map<string, string>([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["avif", "image/avif"],
  ["bmp", "image/bmp"],
  ["ico", "image/x-icon"],
  ["svg", "image/svg+xml"],
]);

/** Media types the raw route may put on the wire — the allowlist's value set, so
 * a Content-Type can never be anything a client asked for. */
export const RENDERABLE_IMAGE_TYPES = new Set(IMAGE_TYPES_BY_EXT.values());

/** Enough leading bytes to identify every format above. */
const IMAGE_SNIFF_BYTES = 64;

function extensionOf(p: string): string {
  const base = p.slice(p.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot + 1).toLowerCase();
}

/**
 * The media type the LEADING BYTES say this is, or null if they say nothing we
 * render. Extension alone must never decide: a `.png` holding a script would
 * otherwise dictate `Content-Type: image/png` for arbitrary content, and the
 * only reason that is not immediately dangerous is `nosniff` — belt and braces
 * is cheaper than relying on one header.
 */
export function sniffImageType(buf: Buffer): string | null {
  const b = buf;
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 6 && (b.subarray(0, 6).toString("latin1") === "GIF87a" || b.subarray(0, 6).toString("latin1") === "GIF89a")) {
    return "image/gif";
  }
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    return "image/webp";
  }
  // ISO-BMFF: `....ftyp<brand>`; avif/avis are the AVIF brands.
  if (b.length >= 12 && b.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = b.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return "image/bmp";
  // ICO: reserved 0x0000, type 0x0001 (little-endian).
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return "image/x-icon";
  // SVG is text, so there is no magic number — look for the root element (or an
  // XML prolog) in the leading bytes.
  const head = b.subarray(0, Math.min(b.length, IMAGE_SNIFF_BYTES)).toString("utf-8").trimStart();
  if (/^<(\?xml|svg\b|!--|!DOCTYPE\s+svg)/i.test(head)) return "image/svg+xml";
  return null;
}

export interface ImageInfo {
  /** Agreed media type (extension AND bytes), for the raw route's Content-Type. */
  mediaType: string;
  /** True on-disk size. */
  size: number;
  /** Over IMAGE_MAX_BYTES: recognised as an image, deliberately not read. */
  tooLarge: boolean;
}

/**
 * Classify a path as a renderable image WITHOUT reading the whole file.
 *
 * Both signals must agree. A mismatch (a `.png` that is really a JPEG, a text
 * file named `.png`) returns null and lets the caller fall through to the normal
 * binary/text handling rather than mislabelling the bytes.
 *
 * `tooLarge` is reported rather than thrown so the UI can say "5.1 MB — too
 * large to preview" instead of showing a broken image.
 */
export async function classifyImage(absPath: string): Promise<ImageInfo | null> {
  const byExt = IMAGE_TYPES_BY_EXT.get(extensionOf(absPath));
  if (!byExt) return null;
  const st = await stat(absPath);
  if (!st.isFile()) return null;

  const toRead = Math.min(st.size, IMAGE_SNIFF_BYTES);
  const head = Buffer.alloc(toRead);
  if (toRead > 0) {
    const fh = await open(absPath, "r");
    try {
      let got = 0;
      while (got < toRead) {
        const r = await fh.read(head, got, toRead - got, got);
        if (r.bytesRead <= 0) break;
        got += r.bytesRead;
      }
      if (got < toRead) return null; // shrank/emptied under us; not classifiable now
    } finally {
      await fh.close();
    }
  }
  const byBytes = sniffImageType(head);
  if (!byBytes || byBytes !== byExt) return null;

  return { mediaType: byBytes, size: st.size, tooLarge: st.size > IMAGE_MAX_BYTES };
}

export interface ImageBytes {
  mediaType: string;
  /** The whole file, base64. Base64 (not raw bytes) because the dashboard's
   * sandbox client decodes every response body as UTF-8 — see
   * dashboard/lib/sandbox-client/http.ts. The dashboard route turns this back
   * into bytes, so no base64 ever reaches the browser. */
  base64: string;
  size: number;
}

/**
 * Whole-file read of an already-classified image, cwd-scoped.
 *
 * Re-classifies rather than trusting the caller: this is the function that hands
 * out a Content-Type, so the extension/bytes agreement has to hold here too.
 * Throws CwdPolicyError for a non-image, an over-cap file, or a path escape.
 */
export async function readImageWithinCwd(opts: { cwd: string; path: string }): Promise<ImageBytes> {
  const policy = isAllowedCwd(opts.cwd);
  if (!policy.ok) throw new CwdPolicyError(policy.reason ?? "cwd not allowed");
  const abs = resolveUnderCwd(opts.cwd, opts.path);
  const info = await classifyImage(abs);
  if (!info) throw new CwdPolicyError("not a renderable image");
  if (info.tooLarge) throw new CwdPolicyError("image too large to preview");

  const buf = Buffer.alloc(info.size);
  let bytesRead = 0;
  if (info.size > 0) {
    const fh = await open(abs, "r");
    try {
      while (bytesRead < info.size) {
        const r = await fh.read(buf, bytesRead, info.size - bytesRead, bytesRead);
        if (r.bytesRead <= 0) break; // shrank since classifyImage's stat
        bytesRead += r.bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
  // Same discipline as readCapped: never encode Buffer.alloc's zero-fill. A
  // partial image is corrupt, so refuse rather than serve a truncated one.
  if (bytesRead < info.size) throw new CwdPolicyError("image changed while reading");
  return { mediaType: info.mediaType, base64: buf.toString("base64"), size: info.size };
}

/**
 * Resolve `rel` (a path relative to `cwd`) to an absolute path, rejecting
 * anything that would escape `cwd`. Syntactic guards first (absolute paths,
 * `..` segments, null bytes), then — when the path exists — a canonical
 * (realpath) containment check so a symlink inside cwd can't point outside it.
 * Throws `CwdPolicyError` on any violation.
 */
export function resolveUnderCwd(cwd: string, rel: string): string {
  if (typeof rel !== "string" || !rel || rel.includes("\0")) {
    throw new CwdPolicyError("invalid path");
  }
  if (isAbsolute(rel)) throw new CwdPolicyError("path must be relative to cwd");
  if (rel.split("/").some((seg) => seg === "..")) {
    throw new CwdPolicyError("path escapes cwd");
  }
  const abs = normalize(join(cwd, rel));
  if (!isWithin(cwd, abs)) throw new CwdPolicyError("path escapes cwd");

  // Symlink safety: if the target exists, its realpath must still be inside the
  // cwd's realpath. Non-existent targets (e.g. a git-removed file) skip this —
  // there's nothing to read anyway.
  const realCwd = canonicalize(cwd);
  const realAbs = canonicalize(abs);
  if (realCwd && realAbs && !isWithin(realCwd, realAbs)) {
    throw new CwdPolicyError("path escapes cwd (symlink)");
  }
  return abs;
}

/**
 * Read at most `maxBytes` from an absolute file path without ever buffering the
 * whole file (opens an fd and reads a bounded slice). Sniffs for binary content
 * and reports the true size + whether the read was truncated. Throws
 * `CwdPolicyError` for a non-regular-file.
 */
export async function readCapped(absPath: string, maxBytes = PREVIEW_MAX_BYTES): Promise<CappedRead> {
  const st = await stat(absPath);
  if (!st.isFile()) throw new CwdPolicyError("not a regular file");
  const size = st.size;
  const toRead = Math.min(size, Math.max(0, maxBytes));
  const buf = Buffer.alloc(toRead);
  // read(2) is allowed to return FEWER bytes than asked for, so loop until the
  // buffer is full or we hit EOF, and track how much actually landed.
  //
  // Ignoring bytesRead was a bug with two faces, because Buffer.alloc zero-fills
  // and a short read leaves that zero-fill in place:
  //   - a NUL in the first 8 KB is the binary signal, so a file whose short read
  //     landed inside the sniff window read as "Binary file — n KB. Preview
  //     isn't available" despite being ordinary text. Any file at or under
  //     BINARY_SNIFF_BYTES sits entirely inside that window.
  //   - past the window it was quieter and worse: the preview rendered the real
  //     text with a tail of NUL characters appended, no warning of any kind.
  //
  // Reproduced, not theorised. Racing this against a writer that truncates and
  // rewrites — what an agent editing a file does, while the navigator refetches
  // the preview on every write under the cwd — the old body corrupted 338 of
  // 1000 reads: 333 false "binary" verdicts on a 7.7 KB text file (fully inside
  // the sniff window) and 5 NUL-padded previews at 200 KB (first 8 KB clean, so
  // no verdict to warn anyone). Same rate on the bind-mounted workspace and on
  // the container's own fs. This loop was clean in all 1000.
  //
  // The mechanism reproduced is the shrink race: stat() sizes the file, the
  // writer replaces it with a shorter one, read hits EOF early. A genuine
  // partial read on a stable file (FUSE, network fs) is the same defect and the
  // same fix, but is not what the numbers above measured.
  let bytesRead = 0;
  if (toRead > 0) {
    const fh = await open(absPath, "r");
    try {
      while (bytesRead < toRead) {
        const r = await fh.read(buf, bytesRead, toRead - bytesRead, bytesRead);
        if (r.bytesRead <= 0) break; // EOF: the file shrank since stat()
        bytesRead += r.bytesRead;
      }
    } finally {
      await fh.close();
    }
  }
  // Never sniff or decode past what was actually read.
  const data = buf.subarray(0, bytesRead);
  const sniff = data.subarray(0, Math.min(data.length, BINARY_SNIFF_BYTES));
  const binary = sniff.includes(0);
  return {
    content: binary ? null : data.toString("utf-8"),
    size,
    // Still "the file is bigger than the cap", NOT "we read less than we hoped":
    // a file that shrank mid-read is fully rendered, so flagging it truncated
    // would show a "Large file — showing the first 512 KB of 7.7 KB" banner.
    truncated: size > toRead,
    binary,
  };
}

/**
 * Cwd-scoped, capped file read. Validates `cwd` against the same policy as
 * session creation, resolves `path` safely under it, then reads ≤maxBytes.
 */
export async function readFileWithinCwd(opts: {
  cwd: string;
  path: string;
  maxBytes?: number;
}): Promise<CappedRead> {
  const policy = isAllowedCwd(opts.cwd);
  if (!policy.ok) throw new CwdPolicyError(policy.reason ?? "cwd not allowed");
  const abs = resolveUnderCwd(opts.cwd, opts.path);
  return readCapped(abs, opts.maxBytes ?? PREVIEW_MAX_BYTES);
}
