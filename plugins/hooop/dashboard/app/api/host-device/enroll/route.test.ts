import { vi, describe, it, expect, beforeEach } from "vitest";
import { HOST_DEVICE_COOKIE, verifyHostDeviceToken, verifyPeerToken } from "@/lib/peer-token";

/**
 * The enrollment endpoint is the one door in the system that is reachable from the
 * public tunnel with NO credential and hands back host authority. So what is
 * tested here is mostly what it REFUSES: it must not confirm whether a code was
 * real, must not accept one minted for another hostname, must be rate limited, and
 * must hand out a token that cannot be replayed as a peer.
 */
const redeemMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    redeemHostEnrollCode: (code: string, host: string, label?: string | null) =>
      redeemMock(code, host, label),
  },
}));

const PEER_SECRET = "p".repeat(48);
const TUNNEL_HOST = "abc123.trycloudflare.com";

let mod: typeof import("./route");
let rateLimit: typeof import("@/lib/rate-limit");

beforeEach(async () => {
  vi.resetModules();
  redeemMock.mockReset();
  process.env.HOOOP_PEER_SIGNING_SECRET = PEER_SECRET;
  mod = await import("./route");
  rateLimit = await import("@/lib/rate-limit");
  rateLimit.enrollAttemptLimiter.reset();
});

function enrollReq(body: unknown, ip = "203.0.113.1"): Request {
  return new Request(`https://${TUNNEL_HOST}/api/host-device/enroll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      host: TUNNEL_HOST,
      // The tunnel edge sets this; it is the rate-limit key, never an auth input.
      "cf-connecting-ip": ip,
    },
    body: JSON.stringify(body),
  });
}

const DEVICE = {
  deviceId: "device-1",
  label: "Pixel",
  publicHost: TUNNEL_HOST,
  expiresAt: Date.now() + 60_000,
};

describe("POST /api/host-device/enroll", () => {
  it("issues a device cookie carrying a HOST-kind token", async () => {
    redeemMock.mockResolvedValueOnce(DEVICE);
    const res = await mod.POST(enrollReq({ code: "ABCDEFGH", label: "Pixel" }));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${HOST_DEVICE_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    // Lax, not Strict: the device arrives by a cross-site top-level navigation
    // (tapping a link / scanning a QR), and Strict is withheld on exactly that.
    expect(setCookie).toContain("SameSite=lax");

    const value = /hooop_host_device=([^;]+)/.exec(setCookie)?.[1] ?? "";
    const payload = await verifyHostDeviceToken(decodeURIComponent(value), PEER_SECRET);
    expect(payload).toMatchObject({ kind: "host", did: "device-1", host: TUNNEL_HOST });
  });

  it("issues a token that cannot be replayed as a PEER token", async () => {
    // Both kinds share a signing secret, so this is the property that keeps "the
    // operator" and "a guest of one session" from being interchangeable.
    redeemMock.mockResolvedValueOnce(DEVICE);
    const res = await mod.POST(enrollReq({ code: "ABCDEFGH" }));
    const value = /hooop_host_device=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    expect(await verifyPeerToken(decodeURIComponent(value), PEER_SECRET)).toBeNull();
  });

  it("binds the device to the hostname the request arrived on", async () => {
    redeemMock.mockResolvedValueOnce(DEVICE);
    await mod.POST(enrollReq({ code: "ABCDEFGH" }));
    expect(redeemMock).toHaveBeenCalledWith("ABCDEFGH", TUNNEL_HOST, null);
  });

  it("gives ONE message for every kind of no", async () => {
    // Anything more specific turns this into an oracle: "that code exists but is
    // expired" is a hint, and the endpoint is unauthenticated by construction.
    redeemMock.mockResolvedValueOnce(null);
    const rejected = await mod.POST(enrollReq({ code: "WRONGONE" }));
    expect(rejected.status).toBe(401);
    const body = (await rejected.json()) as { error: string };

    const missing = await mod.POST(enrollReq({}));
    expect(missing.status).toBe(401);
    expect((await missing.json()) as { error: string }).toEqual(body);
  });

  it("sets no cookie when the code is refused", async () => {
    redeemMock.mockResolvedValueOnce(null);
    const res = await mod.POST(enrollReq({ code: "WRONGONE" }));
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("rate limits guessing, per client", async () => {
    // The code is 8 characters and buys host authority. Online guessing is the
    // only attack that matters here, so the budget is deliberately mean.
    redeemMock.mockResolvedValue(null);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await mod.POST(enrollReq({ code: `GUESS${i}` }))).status;
    }
    expect(last).toBe(429);

    // A different client still gets its own budget.
    const other = await mod.POST(enrollReq({ code: "ABCDEFGH" }, "198.51.100.7"));
    expect(other.status).not.toBe(429);
  });

  it("refuses when sharing is not configured", async () => {
    delete process.env.HOOOP_PEER_SIGNING_SECRET;
    vi.resetModules();
    const fresh = await import("./route");
    const res = await fresh.POST(enrollReq({ code: "ABCDEFGH" }));
    expect(res.status).toBe(503);
  });

  it("survives a sandbox blip without claiming success", async () => {
    redeemMock.mockRejectedValueOnce(new Error("socket down"));
    const res = await mod.POST(enrollReq({ code: "ABCDEFGH" }));
    expect(res.status).toBe(502);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});
