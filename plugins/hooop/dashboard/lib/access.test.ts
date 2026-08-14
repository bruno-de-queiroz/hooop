import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * The access check itself. Its wiring (who is refused, and how) is asserted in
 * proxy.test.ts; this covers the part that decides, and in particular the two
 * behaviours that are easy to get backwards: which direction it fails on an error,
 * and what the cache is allowed to answer for.
 */
const validateShare = vi.fn();
const hostDeviceLive = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    validateShare: (...a: unknown[]) => validateShare(...(a as [])),
    hostDeviceLive: (...a: unknown[]) => hostDeviceLive(...(a as [])),
  },
}));

let mod: typeof import("./access");

beforeEach(async () => {
  vi.resetModules();
  validateShare.mockReset();
  hostDeviceLive.mockReset();
  mod = await import("./access");
});

describe("grantIsLive", () => {
  it("asks the sandbox about a peer's share", async () => {
    validateShare.mockResolvedValue({ shareId: "share-1" });
    expect(await mod.grantIsLive("peer:share-1")).toBe(true);
    expect(validateShare).toHaveBeenCalledWith("share-1", {});
  });

  it("reports a revoked share as dead", async () => {
    validateShare.mockResolvedValue(null);
    expect(await mod.grantIsLive("peer:share-1")).toBe(false);
  });

  it("asks the sandbox about a device", async () => {
    hostDeviceLive.mockResolvedValue({ deviceId: "device-1", label: "Pixel" });
    expect(await mod.grantIsLive("host:device-1")).toBe(true);
    expect(hostDeviceLive).toHaveBeenCalledWith("device-1");
  });

  it("reports a revoked device as dead", async () => {
    hostDeviceLive.mockResolvedValue(null);
    expect(await mod.grantIsLive("host:device-1")).toBe(false);
  });

  it("has nothing to check for the host at the machine, or for nobody", async () => {
    expect(await mod.grantIsLive("host")).toBe(true);
    expect(await mod.grantIsLive("none")).toBe(true);
    expect(await mod.grantIsLive("")).toBe(true);
    expect(validateShare).not.toHaveBeenCalled();
    expect(hostDeviceLive).not.toHaveBeenCalled();
  });

  it("treats a malformed participant as nothing to check, never as a grant", async () => {
    // `host:` with no id must not become a probe for the empty string, which the
    // sandbox would answer 404 to — refusing a request that was never a device.
    expect(await mod.grantIsLive("host:")).toBe(true);
    expect(await mod.grantIsLive("peer:")).toBe(true);
    expect(hostDeviceLive).not.toHaveBeenCalled();
    expect(validateShare).not.toHaveBeenCalled();
  });

  it("fails OPEN on a sandbox error", async () => {
    // A local socket blip must not evict a legitimate participant. Their reads
    // would be empty anyway if the sandbox were truly down, and the next request
    // re-checks — whereas locking the operator out of their own phone over a
    // hiccup is a failure they cannot recover from by retrying.
    hostDeviceLive.mockRejectedValue(new Error("socket down"));
    expect(await mod.grantIsLive("host:device-1")).toBe(true);
  });

  it("caches, so a polling client costs one probe", async () => {
    validateShare.mockResolvedValue({ shareId: "share-1" });
    await mod.grantIsLive("peer:share-1");
    await mod.grantIsLive("peer:share-1");
    await mod.grantIsLive("peer:share-1");
    expect(validateShare).toHaveBeenCalledTimes(1);
  });

  it("caches per participant, so one verdict never answers for another", async () => {
    validateShare.mockResolvedValueOnce(null);
    expect(await mod.grantIsLive("peer:share-1")).toBe(false);
    validateShare.mockResolvedValueOnce({ shareId: "share-2" });
    expect(await mod.grantIsLive("peer:share-2")).toBe(true);
  });

  it("does not let a peer id and a device id collide in the cache", async () => {
    // Both are uuids; keyed on the bare id, one kind would answer for the other.
    validateShare.mockResolvedValue(null);
    hostDeviceLive.mockResolvedValue({ deviceId: "same-id", label: "Pixel" });
    expect(await mod.grantIsLive("peer:same-id")).toBe(false);
    expect(await mod.grantIsLive("host:same-id")).toBe(true);
  });

  it("re-checks once the TTL lapses, so revocation actually lands", async () => {
    vi.useFakeTimers();
    try {
      validateShare.mockResolvedValueOnce({ shareId: "share-1" });
      expect(await mod.grantIsLive("peer:share-1")).toBe(true);

      validateShare.mockResolvedValueOnce(null);
      vi.advanceTimersByTime(4000); // > TTL
      expect(await mod.grantIsLive("peer:share-1")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("revokedReason", () => {
  it("names the thing the holder actually lost", async () => {
    // A guest has to be re-invited by somebody else; the host just signed out one
    // of their own screens. Same code, different sentence.
    expect(mod.revokedReason("host:device-1")).toBe("device revoked");
    expect(mod.revokedReason("peer:share-1")).toBe("share revoked");
  });
});
