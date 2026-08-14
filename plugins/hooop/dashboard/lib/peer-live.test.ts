import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * The read-path revocation guard, which is the only thing standing between a
 * revoked credential and the transcript.
 *
 * Writes are re-checked sandbox-side on every call, so they die instantly. Reads
 * do not go anywhere near that check, and a signed token stays valid after
 * revocation — so this guard IS the revocation for everything a participant can
 * see. It covered shares. It did not cover the host's own enrolled devices, which
 * are revocable too, so a revoked phone kept reading the session list and the
 * transcript for as long as its token had left.
 */
const validateShare = vi.fn();
const hostDeviceLive = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    validateShare: (...a: unknown[]) => validateShare(...(a as [])),
    hostDeviceLive: (...a: unknown[]) => hostDeviceLive(...(a as [])),
  },
}));

let mod: typeof import("./peer-live");

beforeEach(async () => {
  vi.resetModules();
  validateShare.mockReset();
  hostDeviceLive.mockReset();
  mod = await import("./peer-live");
});

/** Middleware would have injected this trusted header. */
function req(participant?: string): Request {
  return new Request("http://localhost/api/events", {
    headers: participant ? { "x-hooop-participant": participant } : {},
  });
}

describe("revokedGrantGuard", () => {
  it("blocks a peer whose share is gone", async () => {
    validateShare.mockResolvedValue(null);
    const res = await mod.revokedGrantGuard(req("peer:share-1"));
    expect(res?.status).toBe(403);
  });

  it("lets a live peer through", async () => {
    validateShare.mockResolvedValue({ shareId: "share-1" });
    expect(await mod.revokedGrantGuard(req("peer:share-1"))).toBeNull();
  });

  it("BLOCKS a revoked device — it used to pass as 'host'", async () => {
    // The hole: `host` meant "the machine, authenticated by hostname, nothing to
    // revoke", so every host-shaped participant was waved through. A device is
    // host-shaped AND revocable, and unlike a peer it isn't even confined to one
    // session, so waving it through leaked more than a revoked share ever could.
    hostDeviceLive.mockResolvedValue(null);
    const res = await mod.revokedGrantGuard(req("host:device-1"));
    expect(res?.status).toBe(403);
    expect((await res!.json()) as { error: string }).toMatchObject({ error: "device revoked" });
  });

  it("lets a live device through", async () => {
    hostDeviceLive.mockResolvedValue({ deviceId: "device-1", label: "Pixel" });
    expect(await mod.revokedGrantGuard(req("host:device-1"))).toBeNull();
    expect(hostDeviceLive).toHaveBeenCalledWith("device-1");
  });

  it("never probes for the host at the machine", async () => {
    // Their authority is the install cookie. There is nothing to revoke, so a
    // round trip per read would be pure cost.
    expect(await mod.revokedGrantGuard(req("host"))).toBeNull();
    expect(hostDeviceLive).not.toHaveBeenCalled();
    expect(validateShare).not.toHaveBeenCalled();
  });

  it("passes an unauthenticated caller to the route's own gate", async () => {
    expect(await mod.revokedGrantGuard(req())).toBeNull();
  });

  it("caches per grant, so a polling client costs one probe", async () => {
    hostDeviceLive.mockResolvedValue({ deviceId: "device-1", label: "Pixel" });
    await mod.revokedGrantGuard(req("host:device-1"));
    await mod.revokedGrantGuard(req("host:device-1"));
    await mod.revokedGrantGuard(req("host:device-1"));
    expect(hostDeviceLive).toHaveBeenCalledTimes(1);
  });

  it("does not let one grant's verdict answer for another", async () => {
    hostDeviceLive.mockResolvedValueOnce(null);
    expect((await mod.revokedGrantGuard(req("host:device-1")))?.status).toBe(403);
    hostDeviceLive.mockResolvedValueOnce({ deviceId: "device-2", label: "iPad" });
    expect(await mod.revokedGrantGuard(req("host:device-2"))).toBeNull();
  });

  it("fails OPEN on a sandbox blip rather than locking out a live device", async () => {
    // Same call as the share path: a local socket hiccup must not evict the
    // operator from their own phone, and the next read re-checks.
    hostDeviceLive.mockRejectedValue(new Error("socket down"));
    expect(await mod.revokedGrantGuard(req("host:device-1"))).toBeNull();
  });
});
