import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Only the policy verdict is stubbed. `canonicalize` stays REAL so
// resolveUnderCwd's realpath/symlink containment is exercised as shipped rather
// than replaced by an identity function that would pass anything.
vi.mock("./cwd-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cwd-policy")>()),
  isAllowedCwd: (p: string) => {
    if (p.startsWith("/forbidden")) return { ok: false, reason: "policy: out of scope" };
    return { ok: true };
  },
}));

// readCapped's contract depends on read(2) being allowed to return fewer bytes
// than asked for, which a real local-filesystem read won't reproduce on demand.
// So `shortRead` lets a test cap each read: given the requested length and
// position it returns the length to actually deliver (0 for EOF). Null — the
// default — passes every handle straight through untouched, so the listFiles
// suite below is unaffected.
let shortRead: ((length: number, position: number) => number) | null = null;

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const fh = await real.open(...args);
      if (!shortRead) return fh;
      const realRead = fh.read.bind(fh);
      // Own-property assignment shadowing FileHandle.prototype.read.
      // @ts-expect-error narrowing the overloaded read() to the positional form readCapped uses
      fh.read = async (buffer: Buffer, offset: number, length: number, position: number) => {
        const n = shortRead!(length, position);
        if (n <= 0) return { bytesRead: 0, buffer };
        return realRead(buffer, offset, n, position);
      };
      return fh;
    },
  };
});

const { listFiles, readCapped, classifyImage, sniffImageType, readImageWithinCwd, IMAGE_MAX_BYTES, CwdPolicyError } =
  await import("./files");

// Smallest byte sequences that identify each format. Only the header matters to
// classifyImage — it never decodes — so these are headers plus filler.
const MAGIC = {
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  gif: Buffer.from("GIF89a", "latin1"),
  webp: Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1")]),
  avif: Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif", "latin1")]),
  bmp: Buffer.from("BM", "latin1"),
  ico: Buffer.from([0x00, 0x00, 0x01, 0x00]),
};

/** Header + filler, so the file is longer than the 64-byte sniff window. */
function imageBytes(kind: keyof typeof MAGIC, pad = 200): Buffer {
  return Buffer.concat([MAGIC[kind], Buffer.alloc(pad, 0x42)]);
}

describe("listFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "files-test-"));
    writeFileSync(join(dir, "README.md"), "");
    writeFileSync(join(dir, "package.json"), "");
    writeFileSync(join(dir, "tsconfig.json"), "");
    writeFileSync(join(dir, ".env"), "");
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "lib"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists entries with directories first, alphabetical within group, skipping hidden", async () => {
    const entries = await listFiles({ cwd: dir });
    // localeCompare sort: directories first (alphabetical), then files
    // (alphabetical, locale-aware so case-insensitive in en-US).
    expect(entries.slice(0, 2).map((e) => e.name)).toEqual(["lib", "src"]);
    expect(entries.slice(2).map((e) => e.name).sort()).toEqual(
      ["README.md", "package.json", "tsconfig.json"].sort(),
    );
    expect(entries.find((e) => e.name === ".env")).toBeUndefined();
    expect(entries.find((e) => e.name === "lib")?.isDir).toBe(true);
    expect(entries.find((e) => e.name === "README.md")?.isDir).toBe(false);
  });

  it("filters by case-insensitive substring on the basename", async () => {
    const entries = await listFiles({ cwd: dir, q: "json" });
    expect(entries.map((e) => e.name)).toEqual(["package.json", "tsconfig.json"]);
  });

  it("respects the limit", async () => {
    const entries = await listFiles({ cwd: dir, limit: 2 });
    expect(entries).toHaveLength(2);
  });

  it("clamps limit between 1 and 100", async () => {
    const tiny = await listFiles({ cwd: dir, limit: 0 });
    expect(tiny).toHaveLength(1);
  });

  it("includes hidden entries only when the query starts with a dot", async () => {
    const noHidden = await listFiles({ cwd: dir });
    expect(noHidden.find((e) => e.name === ".env")).toBeUndefined();

    const withHidden = await listFiles({ cwd: dir, q: "." });
    expect(withHidden.find((e) => e.name === ".env")).toBeDefined();
  });

  it("throws CwdPolicyError for an off-policy cwd", async () => {
    await expect(listFiles({ cwd: "/forbidden/path" })).rejects.toBeInstanceOf(CwdPolicyError);
  });

  it("throws CwdPolicyError for a non-existent cwd", async () => {
    await expect(listFiles({ cwd: join(dir, "does-not-exist") })).rejects.toBeInstanceOf(
      CwdPolicyError,
    );
  });

  it("descends into subdirectories when the query carries a slash", async () => {
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "src", "util.ts"), "");
    const entries = await listFiles({ cwd: dir, q: "src/index" });
    expect(entries.map((e) => e.name)).toEqual(["src/index.ts"]);
  });

  it("lists all entries under a subdirectory when query is 'sub/'", async () => {
    writeFileSync(join(dir, "src", "index.ts"), "");
    writeFileSync(join(dir, "src", "util.ts"), "");
    const entries = await listFiles({ cwd: dir, q: "src/" });
    expect(entries.map((e) => e.name).sort()).toEqual(["src/index.ts", "src/util.ts"]);
  });

  it("rejects queries that try to escape the cwd via ..", async () => {
    await expect(listFiles({ cwd: dir, q: "../README" })).rejects.toBeInstanceOf(
      CwdPolicyError,
    );
  });
});

describe("readCapped", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "readcapped-test-"));
    shortRead = null;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    shortRead = null;
  });

  it("reads a small text file whole", async () => {
    const p = join(dir, "a.ts");
    writeFileSync(p, "export const x = 1;\n");
    expect(await readCapped(p)).toEqual({
      content: "export const x = 1;\n",
      size: 20,
      truncated: false,
      binary: false,
    });
  });

  it("flags a file with a real NUL byte as binary", async () => {
    const p = join(dir, "a.bin");
    writeFileSync(p, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));
    const r = await readCapped(p);
    expect(r.binary).toBe(true);
    expect(r.content).toBeNull();
  });

  it("reports truncated (not binary) for a file past the cap", async () => {
    const p = join(dir, "big.txt");
    writeFileSync(p, "x".repeat(100));
    expect(await readCapped(p, 10)).toEqual({
      content: "x".repeat(10),
      size: 100,
      truncated: true,
      binary: false,
    });
  });

  it("treats an empty file as empty text, not binary", async () => {
    const p = join(dir, "empty.txt");
    writeFileSync(p, "");
    expect(await readCapped(p)).toEqual({ content: "", size: 0, truncated: false, binary: false });
  });

  // The reported bug: a 7.7 KB TypeScript file previewing as "Binary file —
  // 7.7 KB. Preview isn't available". read(2) may return fewer bytes than asked
  // for — a file rewritten while the preview refetches it is exactly how — and
  // the discarded bytesRead left Buffer.alloc's zero-fill in the tail. Every
  // file at or under BINARY_SNIFF_BYTES (8 KB) sits entirely inside the sniff
  // window, so a single byte of leftover fill condemned the whole file.
  it("does not mistake a short read's zero-fill for binary content", async () => {
    const p = join(dir, "short.ts");
    const text = "a".repeat(7889); // the reported size, and under the 8 KB sniff window
    writeFileSync(p, text);
    // First read delivers 4 KB and stops; the rest arrives on subsequent reads.
    shortRead = (length, position) => (position === 0 ? Math.min(length, 4096) : length);

    const r = await readCapped(p);
    expect(r.binary).toBe(false);
    expect(r.content).toBe(text);
  });

  it("keeps a short read past the sniff window free of NUL padding", async () => {
    // The quieter half of the same bug: beyond the first 8 KB a short read was
    // not flagged binary, it just appended the zero-fill to the rendered text.
    const p = join(dir, "long.txt");
    const text = "c".repeat(20_000);
    writeFileSync(p, text);
    shortRead = (length) => Math.min(length, 4096); // every read caps at 4 KB

    const r = await readCapped(p);
    expect(r.binary).toBe(false);
    expect(r.content).toBe(text);
    expect(r.content).not.toMatch(/\0/);
  });

  it("returns only the bytes that existed when a file shrinks mid-read", async () => {
    // stat() sizes the file, then it is truncated under us, so EOF arrives
    // early. Report what was actually there — and do NOT call it truncated,
    // which means "bigger than the cap" and would show a nonsense banner.
    const p = join(dir, "shrink.txt");
    writeFileSync(p, "b".repeat(9000));
    shortRead = (length, position) => (position >= 100 ? 0 : Math.min(length, 100));

    const r = await readCapped(p);
    expect(r.binary).toBe(false);
    expect(r.content).toBe("b".repeat(100));
    expect(r.truncated).toBe(false);
  });
});

describe("sniffImageType", () => {
  it("identifies each renderable raster format from its header", () => {
    expect(sniffImageType(imageBytes("png"))).toBe("image/png");
    expect(sniffImageType(imageBytes("jpeg"))).toBe("image/jpeg");
    expect(sniffImageType(imageBytes("gif"))).toBe("image/gif");
    expect(sniffImageType(imageBytes("webp"))).toBe("image/webp");
    expect(sniffImageType(imageBytes("avif"))).toBe("image/avif");
    expect(sniffImageType(imageBytes("bmp"))).toBe("image/bmp");
    expect(sniffImageType(imageBytes("ico"))).toBe("image/x-icon");
  });

  it("recognises SVG from its root element or an XML prolog", () => {
    expect(sniffImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
    expect(sniffImageType(Buffer.from('<?xml version="1.0"?><svg/>'))).toBe("image/svg+xml");
    expect(sniffImageType(Buffer.from('  \n <svg/>'))).toBe("image/svg+xml"); // leading whitespace
  });

  it("returns null for anything it doesn't render", () => {
    expect(sniffImageType(Buffer.from("export const x = 1;\n"))).toBeNull();
    expect(sniffImageType(Buffer.from("<html><body>hi</body></html>"))).toBeNull();
    expect(sniffImageType(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))).toBeNull(); // ELF
    expect(sniffImageType(Buffer.alloc(0))).toBeNull();
  });
});

describe("classifyImage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "classifyimage-test-"));
    shortRead = null;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    shortRead = null;
  });

  it("classifies a real PNG", async () => {
    const p = join(dir, "shot.png");
    writeFileSync(p, imageBytes("png"));
    const info = await classifyImage(p);
    expect(info).toEqual({ mediaType: "image/png", size: 208, tooLarge: false });
  });

  it("classifies an SVG", async () => {
    const p = join(dir, "logo.svg");
    writeFileSync(p, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');
    expect((await classifyImage(p))?.mediaType).toBe("image/svg+xml");
  });

  // The reason extension alone can't decide: it's the value that becomes a
  // Content-Type. A file whose name and bytes disagree is not classified at all,
  // so it falls through to the ordinary binary/text handling.
  it("refuses a .png that actually holds JPEG bytes", async () => {
    const p = join(dir, "liar.png");
    writeFileSync(p, imageBytes("jpeg"));
    expect(await classifyImage(p)).toBeNull();
  });

  it("refuses a text file wearing an image extension", async () => {
    const p = join(dir, "notreally.png");
    writeFileSync(p, "just text, definitely not a PNG\n");
    expect(await classifyImage(p)).toBeNull();
  });

  it("refuses an image extension we don't render", async () => {
    const p = join(dir, "raw.tiff");
    writeFileSync(p, imageBytes("png")); // real image bytes, unlisted extension
    expect(await classifyImage(p)).toBeNull();
  });

  it("ignores case in the extension", async () => {
    const p = join(dir, "SHOT.PNG");
    writeFileSync(p, imageBytes("png"));
    expect((await classifyImage(p))?.mediaType).toBe("image/png");
  });

  it("flags an over-cap image as tooLarge without reading it", async () => {
    const p = join(dir, "huge.png");
    writeFileSync(p, Buffer.concat([MAGIC.png, Buffer.alloc(IMAGE_MAX_BYTES + 1, 0x42)]));
    const info = await classifyImage(p);
    expect(info?.tooLarge).toBe(true);
    expect(info?.mediaType).toBe("image/png");
  });

  it("returns null for a directory named like an image", async () => {
    const p = join(dir, "assets.png");
    mkdirSync(p);
    expect(await classifyImage(p)).toBeNull();
  });
});

describe("readImageWithinCwd", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "readimage-test-"));
    shortRead = null;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    shortRead = null;
  });

  it("returns the whole file base64'd with its agreed media type", async () => {
    const bytes = imageBytes("png");
    writeFileSync(join(dir, "a.png"), bytes);
    const r = await readImageWithinCwd({ cwd: dir, path: "a.png" });
    expect(r.mediaType).toBe("image/png");
    expect(r.size).toBe(bytes.length);
    // Byte-exact round trip — the base64 hop must not alter a single byte.
    expect(Buffer.from(r.base64, "base64").equals(bytes)).toBe(true);
  });

  it("rejects a path escaping the cwd", async () => {
    writeFileSync(join(dir, "a.png"), imageBytes("png"));
    await expect(readImageWithinCwd({ cwd: dir, path: "../a.png" })).rejects.toBeInstanceOf(CwdPolicyError);
    await expect(readImageWithinCwd({ cwd: dir, path: "/etc/hosts" })).rejects.toBeInstanceOf(CwdPolicyError);
  });

  it("rejects a non-image and a mislabelled one", async () => {
    writeFileSync(join(dir, "code.ts"), "const x = 1;\n");
    writeFileSync(join(dir, "liar.png"), imageBytes("jpeg"));
    await expect(readImageWithinCwd({ cwd: dir, path: "code.ts" })).rejects.toThrow(/not a renderable image/);
    await expect(readImageWithinCwd({ cwd: dir, path: "liar.png" })).rejects.toThrow(/not a renderable image/);
  });

  it("refuses an over-cap image rather than serving a prefix", async () => {
    writeFileSync(join(dir, "huge.png"), Buffer.concat([MAGIC.png, Buffer.alloc(IMAGE_MAX_BYTES + 1, 0x42)]));
    await expect(readImageWithinCwd({ cwd: dir, path: "huge.png" })).rejects.toThrow(/too large/);
  });

  // Same discipline as readCapped: a partly-read image is corrupt, and unlike
  // text there is no salvageable prefix — so refuse instead of base64'ing
  // Buffer.alloc's zero-fill onto the end of a real image.
  it("refuses rather than returning a short read padded with zeroes", async () => {
    const bytes = Buffer.concat([MAGIC.png, Buffer.alloc(4000, 0x42)]);
    writeFileSync(join(dir, "shrink.png"), bytes);
    shortRead = (length, position) => (position >= 100 ? 0 : Math.min(length, 100));
    await expect(readImageWithinCwd({ cwd: dir, path: "shrink.png" })).rejects.toThrow(/changed while reading/);
  });

  it("survives a short read that still delivers every byte", async () => {
    const bytes = Buffer.concat([MAGIC.png, Buffer.alloc(4000, 0x42)]);
    writeFileSync(join(dir, "chunked.png"), bytes);
    shortRead = (length) => Math.min(length, 512); // every read caps at 512B
    const r = await readImageWithinCwd({ cwd: dir, path: "chunked.png" });
    expect(Buffer.from(r.base64, "base64").equals(bytes)).toBe(true);
  });

  it("rejects an out-of-policy cwd", async () => {
    await expect(readImageWithinCwd({ cwd: "/forbidden/x", path: "a.png" })).rejects.toBeInstanceOf(CwdPolicyError);
  });
});
