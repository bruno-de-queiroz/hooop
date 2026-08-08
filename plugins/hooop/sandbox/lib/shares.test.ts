import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Share registry: create/validate-by-id/revoke/expiry/capability + durable
 * persist round-trip. HOME is redirected so STATE_DIR (and shares.json) land in
 * a temp dir. The dashboard signs the peer token; the sandbox only stores the
 * grant and is the revocation authority — so these tests exercise shareId
 * validation, not raw-token hashing.
 */
describe("shares registry", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  let mod: typeof import("./shares");

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-shares-"));
    process.env.HOME = fakeHome;
    vi.resetModules();
    mod = await import("./shares");
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("creates a share and validates by id, bound to host + session", () => {
    const rec = mod.createShare({
      sessionId: "sess-1",
      publicHost: "abc.trycloudflare.com",
      capability: "full",
    });
    expect(rec.shareId).toBeTruthy();

    const v = mod.validateShareById(rec.shareId, {
      host: "abc.trycloudflare.com",
      sessionId: "sess-1",
    });
    expect(v.ok).toBe(true);
    expect(v.record?.capability).toBe("full");
  });

  it("rejects unknown id, wrong host, and wrong session", () => {
    const rec = mod.createShare({ sessionId: "sess-1", publicHost: "abc.example" });
    expect(mod.validateShareById("nope", { host: "abc.example" }).ok).toBe(false);
    expect(mod.validateShareById(rec.shareId, { host: "evil.example" }).ok).toBe(false);
    expect(mod.validateShareById(rec.shareId, { host: "abc.example", sessionId: "other" }).ok).toBe(false);
  });

  it("host match is port- and case-insensitive", () => {
    const rec = mod.createShare({ sessionId: "s", publicHost: "Box.Local:7842" });
    expect(mod.validateShareById(rec.shareId, { host: "box.local" }).ok).toBe(true);
    expect(mod.validateShareById(rec.shareId, { host: "box.local:9999" }).ok).toBe(true);
  });

  it("revoke immediately invalidates the share", () => {
    const rec = mod.createShare({ sessionId: "s", publicHost: "h.example" });
    expect(mod.validateShareById(rec.shareId, { host: "h.example" }).ok).toBe(true);
    expect(mod.revokeShare(rec.shareId).ok).toBe(true);
    expect(mod.validateShareById(rec.shareId, { host: "h.example" }).ok).toBe(false);
    expect(mod.revokeShare(rec.shareId).ok).toBe(false); // already gone
  });

  it("expired shares do not validate", () => {
    const rec = mod.createShare({ sessionId: "s", publicHost: "h.example", expiresInMs: -1 });
    expect(mod.validateShareById(rec.shareId, { host: "h.example" }).ok).toBe(false);
    expect(mod.getShare(rec.shareId)).toBeNull();
  });

  it("capabilityAllows gates actions per capability", () => {
    expect(mod.capabilityAllows("full", "bash")).toBe(true);
    expect(mod.capabilityAllows("full", "permission")).toBe(true);
    expect(mod.capabilityAllows("drive", "turn")).toBe(true);
    expect(mod.capabilityAllows("drive", "bash")).toBe(false);
    expect(mod.capabilityAllows("spectate", "turn")).toBe(false);
    // "admit" (bring another peer into the session) is full-only.
    expect(mod.capabilityAllows("full", "admit")).toBe(true);
    expect(mod.capabilityAllows("drive", "admit")).toBe(false);
    expect(mod.capabilityAllows("spectate", "admit")).toBe(false);
    // "notify" is the one action every capability permits: receiving a push is
    // output about content the peer may already read, not input to the session.
    expect(mod.capabilityAllows("full", "notify")).toBe(true);
    expect(mod.capabilityAllows("drive", "notify")).toBe(true);
    expect(mod.capabilityAllows("spectate", "notify")).toBe(true);
  });

  it("discards shares on reload (no dangling links across a restart)", async () => {
    // A share is bound to a per-run tunnel hostname, so nothing valid can carry
    // across a restart. bootShares() must drop whatever is on disk so a
    // stop/start (or crash) can't revive a dangling grant.
    const rec = mod.createShare({ sessionId: "s", publicHost: "h.example", peerName: "Bob" });
    vi.resetModules();
    const reloaded = await import("./shares");
    reloaded.bootShares();
    expect(reloaded.getShare(rec.shareId)).toBeNull();
    expect(reloaded.validateShareById(rec.shareId, { host: "h.example" }).ok).toBe(false);
    expect(reloaded.listShares()).toHaveLength(0);
  });

  it("revokeAllShares clears every grant and returns the dropped ids", () => {
    const a = mod.createShare({ sessionId: "s1", publicHost: "h.example" });
    const b = mod.createShare({ sessionId: "s2", publicHost: "h.example" });
    expect(mod.listShares()).toHaveLength(2);
    const { revoked } = mod.revokeAllShares();
    expect(revoked.sort()).toEqual([a.shareId, b.shareId].sort());
    expect(mod.listShares()).toHaveLength(0);
    expect(mod.validateShareById(a.shareId, { host: "h.example" }).ok).toBe(false);
    // Idempotent: a second call drops nothing.
    expect(mod.revokeAllShares().revoked).toHaveLength(0);
  });

  it("revokeSharesForSession drops only shares bound to the given session(s)", () => {
    const a = mod.createShare({ sessionId: "sess-A", publicHost: "h.example" });
    const b = mod.createShare({ sessionId: "sess-A", publicHost: "h.example" });
    const c = mod.createShare({ sessionId: "sess-B", publicHost: "h.example" });
    expect(mod.listShares()).toHaveLength(3);

    const { revoked } = mod.revokeSharesForSession("sess-A");
    expect(revoked.sort()).toEqual([a.shareId, b.shareId].sort());
    // sess-A grants are dead; sess-B survives.
    expect(mod.validateShareById(a.shareId, { host: "h.example" }).ok).toBe(false);
    expect(mod.validateShareById(b.shareId, { host: "h.example" }).ok).toBe(false);
    expect(mod.validateShareById(c.shareId, { host: "h.example" }).ok).toBe(true);
    expect(mod.listShares()).toHaveLength(1);
    // Idempotent: nothing left to drop for sess-A.
    expect(mod.revokeSharesForSession("sess-A").revoked).toHaveLength(0);
  });

  it("revokeSharesForSession matches any of a session's resume aliases", () => {
    // A share minted under an OLD id (before claude --resume re-keyed the
    // session) must still be revoked when the session — now known by its
    // canonical id + aliases — is deleted.
    const old = mod.createShare({ sessionId: "old-id", publicHost: "h.example" });
    const cur = mod.createShare({ sessionId: "new-id", publicHost: "h.example" });
    const { revoked } = mod.revokeSharesForSession(["new-id", "old-id"]);
    expect(revoked.sort()).toEqual([old.shareId, cur.shareId].sort());
    expect(mod.listShares()).toHaveLength(0);
  });

  it("listShares returns only active records", () => {
    const a = mod.createShare({ sessionId: "s", publicHost: "h.example" });
    mod.createShare({ sessionId: "s2", publicHost: "h2.example", expiresInMs: -1 });
    const list = mod.listShares();
    expect(list).toHaveLength(1);
    expect(list[0].shareId).toBe(a.shareId);
  });

  // Rejoin state: `joinedBefore` starts false, flips true when a claim marks the
  // share joined, and stays sticky. /join-admit reads this to say "rejoined"
  // rather than "joined" when a peer returns through the admit gate.
  it("a fresh share has not been joined before", () => {
    const rec = mod.createShare({ sessionId: "s", publicHost: "h.example" });
    expect(rec.joinedBefore).toBe(false);
    expect(mod.getShare(rec.shareId)?.joinedBefore).toBe(false);
  });

  it("markShareJoined flips joinedBefore and is idempotent (sticky)", () => {
    const rec = mod.createShare({ sessionId: "s", publicHost: "h.example" });
    expect(mod.markShareJoined(rec.shareId)).toEqual({ ok: true });
    expect(mod.getShare(rec.shareId)?.joinedBefore).toBe(true);
    expect(mod.markShareJoined(rec.shareId)).toEqual({ ok: true });
    expect(mod.getShare(rec.shareId)?.joinedBefore).toBe(true);
  });

  it("markShareJoined is a no-op for an unknown or revoked share", () => {
    expect(mod.markShareJoined("does-not-exist")).toEqual({ ok: false });
    const rec = mod.createShare({ sessionId: "s", publicHost: "h.example" });
    mod.revokeShare(rec.shareId); // deny/revoke drops the record entirely
    expect(mod.markShareJoined(rec.shareId)).toEqual({ ok: false });
  });
});
