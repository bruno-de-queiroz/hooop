import { describe, it, expect } from "vitest";
import {
  signPeerToken,
  verifyPeerToken,
  signHostDeviceToken,
  verifyHostDeviceToken,
  type PeerTokenPayload,
} from "./peer-token";

const SECRET = "s".repeat(48);
const base: PeerTokenPayload = {
  sid: "share-1",
  ses: "sess-1",
  cap: "full",
  host: "abc.trycloudflare.com",
  name: "Bob",
};

describe("peer-token sign/verify", () => {
  it("round-trips a valid token", async () => {
    const t = await signPeerToken(base, SECRET);
    const p = await verifyPeerToken(t, SECRET);
    expect(p).not.toBeNull();
    expect(p!.sid).toBe("share-1");
    expect(p!.host).toBe("abc.trycloudflare.com");
    expect(p!.name).toBe("Bob");
  });

  it("rejects a token signed with a different secret", async () => {
    const t = await signPeerToken(base, SECRET);
    expect(await verifyPeerToken(t, "other-secret-aaaaaaaaaaaaaaaaaa")).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const t = await signPeerToken(base, SECRET);
    const dot = t.indexOf(".");
    // Flip a payload char but keep the original signature.
    const payload = t.slice(0, dot);
    const sig = t.slice(dot + 1);
    const flipped = (payload[5] === "A" ? "B" : "A");
    const tampered = payload.slice(0, 5) + flipped + payload.slice(6) + "." + sig;
    expect(await verifyPeerToken(tampered, SECRET)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const t = await signPeerToken(base, SECRET);
    const tampered = t.slice(0, t.length - 2) + (t.endsWith("AA") ? "BB" : "AA");
    expect(await verifyPeerToken(tampered, SECRET)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const t = await signPeerToken({ ...base, exp: Date.now() - 1000 }, SECRET);
    expect(await verifyPeerToken(t, SECRET)).toBeNull();
  });

  it("accepts an unexpired token", async () => {
    const t = await signPeerToken({ ...base, exp: Date.now() + 60_000 }, SECRET);
    expect(await verifyPeerToken(t, SECRET)).not.toBeNull();
  });

  it("rejects garbage / malformed input", async () => {
    expect(await verifyPeerToken("", SECRET)).toBeNull();
    expect(await verifyPeerToken("nodot", SECRET)).toBeNull();
    expect(await verifyPeerToken(".onlysig", SECRET)).toBeNull();
    expect(await verifyPeerToken("payload.", SECRET)).toBeNull();
    expect(await verifyPeerToken("a.b.c", SECRET)).toBeNull();
  });
});

describe("host device tokens", () => {
  // Both kinds are signed with the SAME secret, so a valid signature answers
  // "did we issue this?" and nothing else. The `kind` claim is what keeps "a
  // guest of one session" and "the operator of this machine" apart, and it has to
  // hold in both directions.
  it("round-trips a device token", async () => {
    const t = await signHostDeviceToken({ did: "device-1", host: "abc.trycloudflare.com" }, SECRET);
    const p = await verifyHostDeviceToken(t, SECRET);
    expect(p).toMatchObject({ kind: "host", did: "device-1", host: "abc.trycloudflare.com" });
  });

  it("a PEER token is not a device token", async () => {
    const t = await signPeerToken(base, SECRET);
    expect(await verifyHostDeviceToken(t, SECRET)).toBeNull();
  });

  it("a DEVICE token is not a peer token", async () => {
    const t = await signHostDeviceToken({ did: "device-1", host: base.host }, SECRET);
    expect(await verifyPeerToken(t, SECRET)).toBeNull();
  });

  it("rejects a device token signed with another secret", async () => {
    const t = await signHostDeviceToken({ did: "device-1", host: base.host }, SECRET);
    expect(await verifyHostDeviceToken(t, "x".repeat(48))).toBeNull();
  });

  it("rejects an expired device token", async () => {
    const t = await signHostDeviceToken({ did: "device-1", host: base.host, exp: Date.now() - 1000 }, SECRET);
    expect(await verifyHostDeviceToken(t, SECRET)).toBeNull();
  });

  it("rejects a device token with no device id", async () => {
    // Would otherwise resolve to the participant string `host:`, which is neither
    // the local host nor a device the sandbox can look up.
    const t = await signHostDeviceToken({ did: "", host: base.host }, SECRET);
    expect(await verifyHostDeviceToken(t, SECRET)).toBeNull();
  });

  it("rejects a peer token that lost its share id", async () => {
    const t = await signPeerToken({ ...base, sid: undefined as unknown as string }, SECRET);
    expect(await verifyPeerToken(t, SECRET)).toBeNull();
  });
});
