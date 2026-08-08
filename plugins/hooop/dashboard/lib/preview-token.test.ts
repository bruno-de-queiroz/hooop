import { describe, it, expect } from "vitest";
import {
  signPreviewToken,
  verifyPreviewToken,
  normalizePreviewHost,
  PREVIEW_TOKEN_TTL_MS,
  type PreviewTokenPayload,
} from "./preview-token";

const SECRET = "s".repeat(48);

function payload(over: Partial<PreviewTokenPayload> = {}): PreviewTokenPayload {
  return {
    pv: "pv-1",
    ses: "sess-a",
    sid: "share-1",
    host: "abc.trycloudflare.com",
    exp: Date.now() + PREVIEW_TOKEN_TTL_MS,
    ...over,
  };
}

describe("preview grants", () => {
  it("round-trips a valid grant", async () => {
    const t = await signPreviewToken(payload(), SECRET);
    const back = await verifyPreviewToken(t, SECRET);
    expect(back).toMatchObject({ pv: "pv-1", ses: "sess-a", sid: "share-1" });
  });

  it("rejects a token signed with a different secret", async () => {
    const t = await signPreviewToken(payload(), SECRET);
    expect(await verifyPreviewToken(t, "d".repeat(48))).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    // Swapping the preview id must invalidate the signature — otherwise one
    // grant would open every preview.
    const t = await signPreviewToken(payload(), SECRET);
    const [body, sig] = t.split(".");
    const decoded = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")));
    decoded.pv = "pv-someone-else";
    const forged = btoa(JSON.stringify(decoded)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(await verifyPreviewToken(`${forged}.${sig}`, SECRET)).toBeNull();
  });

  it("rejects an expired grant", async () => {
    const t = await signPreviewToken(payload({ exp: Date.now() - 1 }), SECRET);
    expect(await verifyPreviewToken(t, SECRET)).toBeNull();
  });

  it("rejects a grant with no expiry at all", async () => {
    // A grant that never expires would outlive the tunnel it was minted for.
    const t = await signPreviewToken(payload({ exp: 0 }), SECRET);
    expect(await verifyPreviewToken(t, SECRET)).toBeNull();
  });

  it("rejects garbage without throwing", async () => {
    for (const bad of ["", "x", "a.b.c", "....", "no-dot"]) {
      expect(await verifyPreviewToken(bad, SECRET)).toBeNull();
    }
  });

  it("rejects an empty secret rather than trusting the token", async () => {
    const t = await signPreviewToken(payload(), SECRET);
    expect(await verifyPreviewToken(t, "")).toBeNull();
  });
});

describe("normalizePreviewHost", () => {
  it.each([
    ["abc.trycloudflare.com", "abc.trycloudflare.com"],
    ["ABC.TryCloudflare.com:443", "abc.trycloudflare.com"],
    ["127.0.0.1:7850", "127.0.0.1"],
    ["[::1]:7850", "[::1]"],
    ["", ""],
  ])("%s → %s", (input, expected) => {
    expect(normalizePreviewHost(input)).toBe(expected);
  });

  it("treats a missing header as empty rather than matching anything", () => {
    expect(normalizePreviewHost(null)).toBe("");
    expect(normalizePreviewHost(undefined)).toBe("");
  });
});
