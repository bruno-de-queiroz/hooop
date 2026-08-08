import { describe, it, expect } from "vitest";
import { validateImageBase64 } from "./image-guard";

function png(w: number, h: number): string {
  const b = Buffer.alloc(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString("base64");
}
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString("base64");

describe("validateImageBase64", () => {
  it("accepts a well-formed PNG within the dimension cap", () => {
    expect(validateImageBase64(png(200, 200), "image/png", 8192).ok).toBe(true);
  });

  it("accepts a JPEG by signature", () => {
    expect(validateImageBase64(jpeg, "image/jpeg", 1024).ok).toBe(true);
  });

  it("rejects non-base64 input", () => {
    const r = validateImageBase64("not base64!!!", "image/png", 8192);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/base64/i);
  });

  it("rejects a type/bytes mismatch (png bytes claimed as jpeg)", () => {
    const r = validateImageBase64(png(10, 10), "image/jpeg", 8192);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/do not match/i);
  });

  it("rejects a decompression bomb (dimensions over the cap)", () => {
    const r = validateImageBase64(png(20000, 20000), "image/png", 1024);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/dimensions/i);
  });

  it("rejects an unsupported media type", () => {
    const r = validateImageBase64(png(10, 10), "image/svg+xml", 8192);
    expect(r.ok).toBe(false);
  });
});
