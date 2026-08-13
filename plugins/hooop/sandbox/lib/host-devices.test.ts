import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Host device registry: enrollment codes (single-use, TTL, host-bound) and the
 * device grants they produce (validate/revoke/expire, per-run discard).
 *
 * HOME is redirected so STATE_DIR (and host-devices.json) land in a temp dir.
 * The dashboard signs the device token; the sandbox stores the grant and is the
 * revocation authority — so these exercise deviceId validation and the code
 * ceremony, never raw-token handling.
 */
describe("host device registry", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  let mod: typeof import("./host-devices");

  const HOST = "abc123.trycloudflare.com";

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-devices-"));
    process.env.HOME = fakeHome;
    vi.resetModules();
    mod = await import("./host-devices");
  });

  afterEach(() => {
    vi.useRealTimers();
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function enroll(label?: string | null) {
    const { code } = mod.createEnrollCode({ publicHost: HOST, label });
    const r = mod.redeemEnrollCode(code, HOST);
    if (!r.ok) throw new Error(`enrollment failed: ${r.reason}`);
    return r.device;
  }

  describe("enrollment codes", () => {
    it("mints a code that redeems into a live device", () => {
      const device = enroll("Pixel 8");
      expect(device.deviceId).toBeTruthy();
      expect(device.label).toBe("Pixel 8");
      expect(device.publicHost).toBe(HOST);
      expect(mod.validateHostDevice(device.deviceId).ok).toBe(true);
    });

    it("is SINGLE USE — the second attempt on the same code fails", () => {
      // The code is a bearer credential for host authority. Reuse would turn one
      // deliberate act at the laptop into standing permission for anyone who saw
      // the QR over your shoulder.
      const { code } = mod.createEnrollCode({ publicHost: HOST });
      expect(mod.redeemEnrollCode(code, HOST).ok).toBe(true);
      const again = mod.redeemEnrollCode(code, HOST);
      expect(again.ok).toBe(false);
    });

    it("is consumed even by an attempt that then fails the host check", () => {
      // Otherwise a guesser who finds a live code on the wrong hostname could
      // keep it and retry it elsewhere — one guess must buy exactly one attempt.
      const { code } = mod.createEnrollCode({ publicHost: HOST });
      expect(mod.redeemEnrollCode(code, "evil.example.com").ok).toBe(false);
      expect(mod.redeemEnrollCode(code, HOST).ok).toBe(false);
    });

    it("refuses a code minted for a DIFFERENT tunnel host", () => {
      const { code } = mod.createEnrollCode({ publicHost: HOST });
      const r = mod.redeemEnrollCode(code, "other.trycloudflare.com");
      expect(r.ok).toBe(false);
    });

    it("expires a code after its short window", () => {
      vi.useFakeTimers();
      const { code } = mod.createEnrollCode({ publicHost: HOST });
      vi.advanceTimersByTime(3 * 60_000); // > 2 min TTL
      expect(mod.redeemEnrollCode(code, HOST).ok).toBe(false);
    });

    it("refuses an unknown code", () => {
      expect(mod.redeemEnrollCode("NOTACODE", HOST).ok).toBe(false);
      expect(mod.redeemEnrollCode("", HOST).ok).toBe(false);
    });

    it("accepts a code case-insensitively and trimmed (it gets typed by hand)", () => {
      const { code } = mod.createEnrollCode({ publicHost: HOST });
      expect(mod.redeemEnrollCode(`  ${code.toLowerCase()} `, HOST).ok).toBe(true);
    });

    it("normalizes the host the same way on both sides (port stripped)", () => {
      const { code } = mod.createEnrollCode({ publicHost: `${HOST}:443` });
      expect(mod.redeemEnrollCode(code, HOST).ok).toBe(true);
    });

    it("clearEnrollCodes drops outstanding codes (host closed the dialog)", () => {
      const { code } = mod.createEnrollCode({ publicHost: HOST });
      expect(mod.pendingEnrollCount()).toBe(1);
      mod.clearEnrollCodes();
      expect(mod.pendingEnrollCount()).toBe(0);
      expect(mod.redeemEnrollCode(code, HOST).ok).toBe(false);
    });

    it("clamps a caller-supplied lifetime to the maximum", () => {
      const { deviceTtlMs } = mod.createEnrollCode({ publicHost: HOST, ttlMs: 365 * 24 * 60 * 60 * 1000 });
      expect(deviceTtlMs).toBe(mod.MAX_DEVICE_TTL_MS);
    });

    it("defaults the lifetime when none is asked for", () => {
      const { deviceTtlMs } = mod.createEnrollCode({ publicHost: HOST, ttlMs: null });
      expect(deviceTtlMs).toBe(mod.DEFAULT_DEVICE_TTL_MS);
    });

    it("codes are drawn from an alphabet with no look-alikes", () => {
      // It gets read off a screen and typed on a phone, so O/0 and I/1/L are out.
      for (let i = 0; i < 20; i++) {
        const { code } = mod.createEnrollCode({ publicHost: HOST });
        expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      }
    });
  });

  describe("device grants", () => {
    it("validates the host binding", () => {
      const device = enroll();
      expect(mod.validateHostDevice(device.deviceId, { host: HOST }).ok).toBe(true);
      const wrong = mod.validateHostDevice(device.deviceId, { host: "other.trycloudflare.com" });
      expect(wrong.ok).toBe(false);
      expect(wrong.reason).toBe("host mismatch");
    });

    it("revokes instantly", () => {
      const device = enroll();
      expect(mod.revokeHostDevice(device.deviceId)).toEqual({ ok: true });
      expect(mod.validateHostDevice(device.deviceId).ok).toBe(false);
      expect(mod.getHostDevice(device.deviceId)).toBeNull();
      // Idempotent-ish: revoking twice reports "unknown" rather than throwing.
      expect(mod.revokeHostDevice(device.deviceId)).toEqual({ ok: false });
    });

    it("expires on its own", () => {
      vi.useFakeTimers();
      const { code } = mod.createEnrollCode({ publicHost: HOST, ttlMs: 60_000 });
      const r = mod.redeemEnrollCode(code, HOST);
      expect(r.ok).toBe(true);
      const id = r.ok ? r.device.deviceId : "";
      vi.advanceTimersByTime(61_000);
      expect(mod.validateHostDevice(id).ok).toBe(false);
    });

    it("revokeAllHostDevices clears every grant AND every pending code", () => {
      // Called when the tunnel dies. A dangling share is a stale guest grant; a
      // dangling device is stale HOST authority, so nothing may survive.
      const a = enroll("phone");
      const b = enroll("tablet");
      mod.createEnrollCode({ publicHost: HOST });
      const { revoked } = mod.revokeAllHostDevices();
      expect(revoked).toHaveLength(2);
      expect(mod.validateHostDevice(a.deviceId).ok).toBe(false);
      expect(mod.validateHostDevice(b.deviceId).ok).toBe(false);
      expect(mod.pendingEnrollCount()).toBe(0);
    });

    it("refuses to MINT a code once the list is full, and says why", () => {
      // Said out loud here because the caller is the authenticated host. The
      // redeem side cannot afford to be this specific (it would become an oracle
      // for "was that code real?"), so catching it at mint is the only place the
      // host learns what to do — before walking to the other device.
      for (let i = 0; i < 8; i++) enroll(`d${i}`);
      expect(() => mod.createEnrollCode({ publicHost: HOST })).toThrow(mod.HostDeviceCapError);

      // Revoking one makes room again.
      mod.revokeHostDevice(mod.listHostDevices()[0].deviceId);
      const { code } = mod.createEnrollCode({ publicHost: HOST });
      expect(mod.redeemEnrollCode(code, HOST).ok).toBe(true);
    });

    it("still enforces the cap at REDEEM, for a code minted before the list filled", () => {
      // The mint check is a courtesy; this one is the invariant. A code minted
      // with room to spare must not be redeemable after the last slot went.
      for (let i = 0; i < 7; i++) enroll(`d${i}`);
      const { code } = mod.createEnrollCode({ publicHost: HOST }); // room at this point
      enroll("the-eighth");                                        // ...and now there isn't
      expect(mod.redeemEnrollCode(code, HOST).ok).toBe(false);
      expect(mod.listHostDevices()).toHaveLength(8);
    });

    it("records last-seen on validation", () => {
      const device = enroll();
      expect(mod.getHostDevice(device.deviceId)?.lastSeenAt).toBeNull();
      mod.validateHostDevice(device.deviceId);
      expect(mod.getHostDevice(device.deviceId)?.lastSeenAt).toBeGreaterThan(0);
    });

    it("lists devices oldest first", () => {
      vi.useFakeTimers();
      const a = enroll("first");
      vi.advanceTimersByTime(1000);
      const b = enroll("second");
      expect(mod.listHostDevices().map((d) => d.deviceId)).toEqual([a.deviceId, b.deviceId]);
    });
  });

  describe("per-run lifetime", () => {
    it("DISCARDS whatever is on disk at boot", () => {
      // A device is bound to a tunnel hostname, and the quick tunnel mints a new
      // one every start — so any persisted device is dangling by definition. This
      // is also the backstop for a SIGKILL where the shutdown drainer never ran:
      // stale HOST authority must never be revivable.
      const stateDir = join(fakeHome, ".claude", "hooop");
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(
        join(stateDir, "host-devices.json"),
        JSON.stringify({
          version: 1,
          savedAt: new Date().toISOString(),
          devices: [{
            deviceId: "from-last-run",
            label: "ghost",
            publicHost: "old.trycloudflare.com",
            createdAt: Date.now(),
            expiresAt: null,
            revoked: false,
            lastSeenAt: null,
          }],
        }),
        "utf-8",
      );

      mod.bootHostDevices();
      expect(mod.listHostDevices()).toHaveLength(0);
      expect(mod.validateHostDevice("from-last-run").ok).toBe(false);
      // And the file on disk no longer claims otherwise.
      const onDisk = JSON.parse(readFileSync(join(stateDir, "host-devices.json"), "utf-8"));
      expect(onDisk.devices).toHaveLength(0);
    });

    it("persists a live device so the file reflects reality", () => {
      const device = enroll("phone");
      const file = join(fakeHome, ".claude", "hooop", "host-devices.json");
      expect(existsSync(file)).toBe(true);
      const onDisk = JSON.parse(readFileSync(file, "utf-8"));
      expect(onDisk.devices.map((d: { deviceId: string }) => d.deviceId)).toContain(device.deviceId);
    });
  });
});
