import { vi, describe, it, expect, beforeEach } from "vitest";
import { verifyPeerToken } from "@/lib/peer-token";

/**
 * A peer re-deriving their OWN link, so they can carry on from a second device
 * without asking the host for anything.
 *
 * The behaviour worth pinning is the scope: this must answer only about the
 * caller's own share (taken from the trusted header, never the request body), and
 * it must not become a way to look up or re-mint anybody else's.
 */
const validateShare = vi.fn();
vi.mock("@/lib/sandbox-client", () => ({
  client: { validateShare: (...a: unknown[]) => validateShare(...(a as [])) },
}));

let participant: { kind: "host" | "peer" | "none"; shareId?: string } = { kind: "peer", shareId: "share-1" };
vi.mock("@/lib/peer-auth", () => ({
  participantOf: () => participant,
}));

const PEER_SECRET = "p".repeat(48);
const TUNNEL_HOST = "abc123.trycloudflare.com";

const RECORD = {
  shareId: "share-1",
  sessionId: "sess-1",
  capability: "spectate" as const,
  publicHost: TUNNEL_HOST,
  peerName: "Ana",
  createdAt: 0,
  expiresAt: null,
  revoked: false,
};

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  validateShare.mockReset();
  participant = { kind: "peer", shareId: "share-1" };
  process.env.HOOOP_PEER_SIGNING_SECRET = PEER_SECRET;
  mod = await import("./route");
});

const req = () => new Request(`https://${TUNNEL_HOST}/api/share/mine/link`);

describe("GET /api/share/mine/link", () => {
  it("re-derives the caller's own link, with a token that still verifies", async () => {
    // The token is stateless, so re-signing the stored record reproduces the same
    // valid credential. No new grant is created — that is the whole point.
    validateShare.mockResolvedValueOnce(RECORD);
    const res = await mod.GET(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { link: string; capability: string };
    expect(body.link.startsWith(`https://${TUNNEL_HOST}/join/share-1#k=`)).toBe(true);
    expect(body.capability).toBe("spectate");

    const token = body.link.split("#k=")[1];
    expect(await verifyPeerToken(token, PEER_SECRET)).toMatchObject({ sid: "share-1", ses: "sess-1" });
  });

  it("looks up only the CALLER's share, from the trusted header", async () => {
    validateShare.mockResolvedValueOnce(RECORD);
    await mod.GET(req());
    expect(validateShare).toHaveBeenCalledWith("share-1", {});
  });

  it("works for a spectate peer, who cannot use the admit-gated route", async () => {
    // This is the gap it closes: a drive/spectate guest had no way to reach even
    // their own link, because the existing re-derive route requires admit rights.
    participant = { kind: "peer", shareId: "share-1" };
    validateShare.mockResolvedValueOnce({ ...RECORD, capability: "spectate" });
    expect((await mod.GET(req())).status).toBe(200);
  });

  it("refuses the host (they have the share list) and anonymous callers", async () => {
    participant = { kind: "host" };
    expect((await mod.GET(req())).status).toBe(403);
    participant = { kind: "none" };
    expect((await mod.GET(req())).status).toBe(403);
  });

  it("404s once the share is revoked, rather than handing out a dead link", async () => {
    validateShare.mockResolvedValueOnce(null);
    expect((await mod.GET(req())).status).toBe(404);
  });

  it("404s when the sandbox cannot be reached", async () => {
    validateShare.mockRejectedValueOnce(new Error("socket down"));
    expect((await mod.GET(req())).status).toBe(404);
  });

  it("refuses when sharing is not configured", async () => {
    delete process.env.HOOOP_PEER_SIGNING_SECRET;
    vi.resetModules();
    const fresh = await import("./route");
    expect((await fresh.GET(req())).status).toBe(503);
  });
});
