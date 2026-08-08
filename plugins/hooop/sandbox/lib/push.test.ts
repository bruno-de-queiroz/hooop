import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

/**
 * Push subscription registry + delivery.
 *
 * HOME is redirected so STATE_DIR (push.json, vapid.json) lands in a temp dir,
 * matching shares.test.ts. `web-push` is mocked — these tests are about who we
 * decide to deliver to, never about the wire format. `./ingestor` is mocked to a
 * bare EventEmitter so the suite doesn't drag in SQLite for a bus subscription.
 */

const sendNotification = vi.fn(async () => ({ statusCode: 201 }));
vi.mock("web-push", () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    sendNotification,
  },
}));

const eventBus = new EventEmitter();
vi.mock("./ingestor", () => ({ eventBus }));

const KEYS = { p256dh: "p", auth: "a" };

describe("push registry", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  let push: typeof import("./push");
  let shares: typeof import("./shares");

  // Imported ONCE. STATE_DIR is derived from HOME at module load, so HOME has to
  // be redirected before the first import and stay put; per-test isolation then
  // comes from the reset seams plus deleting the state file. Re-importing per
  // test (the shares.test.ts pattern) re-transforms this module's whole graph
  // ~20 times, which was enough extra load to push a neighbouring DB test past
  // its 5s timeout when vitest ran the two files together.
  beforeAll(async () => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-push-"));
    process.env.HOME = fakeHome;
    push = await import("./push");
    shares = await import("./shares");
  });

  afterAll(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  beforeEach(() => {
    sendNotification.mockClear();
    sendNotification.mockImplementation(async () => ({ statusCode: 201 }));
    shares.revokeAllShares();
    rmSync(join(fakeHome, ".claude", "hooop", "push.json"), { force: true });
    push.__resetPushForTests();
    push.bootPush();
  });

  function addHost() {
    return push.addSubscription({
      ownerKind: "host", shareId: null, sessionId: null, displayName: "host",
      capability: null, endpoint: "https://push.example/host", keys: KEYS,
    });
  }

  function addPeer(opts: { shareId: string; sessionId: string; name?: string; capability?: "full" | "drive" | "spectate"; endpoint?: string }) {
    return push.addSubscription({
      ownerKind: "peer",
      shareId: opts.shareId,
      sessionId: opts.sessionId,
      displayName: opts.name ?? "Ana",
      capability: opts.capability ?? "drive",
      endpoint: opts.endpoint ?? `https://push.example/${opts.shareId}`,
      keys: KEYS,
    });
  }

  const chat = (sessionId: string, author: string | null = "host") => ({
    session_id: sessionId, hook_type: "UserPromptSubmit", text: "hi", author,
  });

  describe("lifetime", () => {
    it("keeps host subscriptions across a restart but drops every peer one", () => {
      addHost();
      addPeer({ shareId: "share-1", sessionId: "s1" });
      expect(push.listSubscriptions()).toHaveLength(2);

      // Forget in-memory state and boot again — the file on disk is all that
      // carries over, exactly as after a real restart.
      push.__resetPushForTests();
      push.bootPush();

      const after = push.listSubscriptions();
      expect(after).toHaveLength(1);
      expect(after[0].ownerKind).toBe("host");
    });

    it("drops a peer's subscription the moment their share is revoked", () => {
      // The security property: a revoked peer must stop receiving session
      // content immediately, not at the next restart.
      const rec = shares.createShare({ sessionId: "s1", publicHost: "x.trycloudflare.com" });
      addHost();
      addPeer({ shareId: rec.shareId, sessionId: "s1" });
      expect(push.listSubscriptions()).toHaveLength(2);

      shares.revokeShare(rec.shareId);

      const left = push.listSubscriptions();
      expect(left).toHaveLength(1);
      expect(left[0].ownerKind).toBe("host");
    });

    it("drops peer subscriptions when every share is revoked (tunnel down / shutdown)", () => {
      const a = shares.createShare({ sessionId: "s1", publicHost: "x.trycloudflare.com" });
      const b = shares.createShare({ sessionId: "s2", publicHost: "x.trycloudflare.com" });
      addPeer({ shareId: a.shareId, sessionId: "s1", endpoint: "https://push.example/a" });
      addPeer({ shareId: b.shareId, sessionId: "s2", endpoint: "https://push.example/b" });

      shares.revokeAllShares();
      expect(push.listSubscriptions()).toHaveLength(0);
    });

    it("drops peer subscriptions when the session they belong to is deleted", () => {
      const rec = shares.createShare({ sessionId: "s1", publicHost: "x.trycloudflare.com" });
      addPeer({ shareId: rec.shareId, sessionId: "s1" });

      shares.revokeSharesForSession("s1");
      expect(push.listSubscriptions()).toHaveLength(0);
    });

    it("treats a re-subscribe with the same endpoint as the same device", () => {
      addHost();
      addHost();
      expect(push.listSubscriptions()).toHaveLength(1);
    });
  });

  describe("routing", () => {
    it("delivers a session's activity to the host", async () => {
      addHost();
      const { sent } = await push.notifyForEvent(chat("s1", "Ana"));
      expect(sent).toBe(1);
    });

    it("never notifies the host about their own message", async () => {
      addHost();
      expect((await push.notifyForEvent(chat("s1", "host"))).sent).toBe(0);
    });

    it("never notifies a peer about their own message", async () => {
      addPeer({ shareId: "share-1", sessionId: "s1", name: "Ana" });
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(0);
      // ...but a different author in the same session still reaches them.
      expect((await push.notifyForEvent(chat("s1", "host"))).sent).toBe(1);
    });

    // Reported as "a few permission bubbles never notified me". It was every ask
    // on a turn you drove yourself, which is nearly all of them: the ask carries
    // the turn's author, and the self-authored filter then dropped it for exactly
    // the person the agent is blocked on.
    it("notifies the host about a permission ask on a turn the host drove", async () => {
      addHost();
      const ask = {
        session_id: "s1", hook_type: "PermissionRequest", tool_name: "Write", author: "host",
      };
      expect((await push.notifyForEvent(ask)).sent).toBe(1);
    });

    it("notifies a peer about an ask on a turn that peer drove", async () => {
      addPeer({ shareId: "share-1", sessionId: "s1", name: "Ana", capability: "full" });
      const ask = {
        session_id: "s1", hook_type: "PermissionRequest", tool_name: "ExitPlanMode", author: "Ana",
      };
      expect((await push.notifyForEvent(ask)).sent).toBe(1);
    });

    it("notifies the host that their own preview came up", async () => {
      // The whole point is that you started it and walked away; telling only
      // OTHER people your app is running would be useless.
      addHost();
      const up = {
        session_id: "s1", hook_type: "PreviewStarted", author: "host",
        text: '[PreviewStarted] | message=Preview "web" is running',
      };
      expect((await push.notifyForEvent(up)).sent).toBe(1);
    });

    // The filter still does its original job.
    it("still does not echo the host's own message back at them", async () => {
      addHost();
      expect((await push.notifyForEvent(chat("s1", "host"))).sent).toBe(0);
    });

    it("skips only the author, not everyone else on the session", async () => {
      addHost();
      addPeer({ shareId: "share-1", sessionId: "s1", name: "Ana" });
      // Ana's message reaches the host and nobody else.
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(1);
    });

    it("only tells a peer about the session their share is bound to", async () => {
      addPeer({ shareId: "share-1", sessionId: "s1", name: "Ana" });
      expect((await push.notifyForEvent(chat("s1"))).sent).toBe(1);
      expect((await push.notifyForEvent(chat("s2"))).sent).toBe(0);
    });

    it("matches a resumed session through its canonical id", async () => {
      // claude --resume swaps the canonical id; a peer bound to the old one must
      // still be reachable, or notifications silently stop mid-session.
      addPeer({ shareId: "share-1", sessionId: "old-id", name: "Ana" });
      push.setCanonicalResolver((id) => (id === "old-id" ? "new-id" : id));
      expect((await push.notifyForEvent(chat("new-id"))).sent).toBe(1);
    });

    it("restricts join-request notifications to admit-capable recipients", async () => {
      const join = { session_id: "s1", hook_type: "PeerJoinRequest", text: "Ana asked to join" };
      addPeer({ shareId: "drive-share", sessionId: "s1", capability: "drive", endpoint: "https://push.example/drive" });
      expect((await push.notifyForEvent(join)).sent).toBe(0);

      addPeer({ shareId: "full-share", sessionId: "s1", capability: "full", endpoint: "https://push.example/full" });
      expect((await push.notifyForEvent(join)).sent).toBe(1);
    });

    it("still delivers ordinary activity to a spectator", async () => {
      // Receiving is output, not input — a spectate share may watch the
      // transcript live, so it may equally be told the agent finished.
      addPeer({ shareId: "share-1", sessionId: "s1", capability: "spectate" });
      expect((await push.notifyForEvent(chat("s1"))).sent).toBe(1);
    });

    it("sends nothing for an event that isn't notifiable", async () => {
      addHost();
      const { sent } = await push.notifyForEvent({ session_id: "s1", hook_type: "PostToolUse", text: "x" });
      expect(sent).toBe(0);
      expect(sendNotification).not.toHaveBeenCalled();
    });
  });

  describe("muting", () => {
    it("mutes a single session without affecting the others", async () => {
      addHost();
      push.setMute("host", "s1", true);
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(0);
      expect((await push.notifyForEvent(chat("s2", "Ana"))).sent).toBe(1);
    });

    it("a global mute outranks everything", async () => {
      addHost();
      push.setMute("host", null, true);
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(0);
      expect((await push.notifyForEvent(chat("s2", "Ana"))).sent).toBe(0);
    });

    it("unmuting restores delivery", async () => {
      addHost();
      push.setMute("host", "s1", true);
      push.setMute("host", "s1", false);
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(1);
    });

    it("a mute set under a session alias still catches events under the canonical id", async () => {
      // isMuted resolves the incoming event's id forward, so storing the raw
      // alias used to miss: the canonical resolves to itself, so the alias
      // branch never fired and the mute silently did nothing.
      addHost();
      push.setCanonicalResolver((id) => (id === "old-id" ? "new-id" : id));
      push.setMute("host", "old-id", true);
      expect((await push.notifyForEvent(chat("new-id", "Ana"))).sent).toBe(0);
    });

    it("scopes mutes per participant — one peer muting doesn't silence the host", async () => {
      addHost();
      addPeer({ shareId: "share-1", sessionId: "s1", name: "Ana" });
      push.setMute(push.ownerKeyFor("peer", "share-1"), "s1", true);
      // Host still hears about it; the peer does not.
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(1);
    });
  });

  describe("endpoint ownership", () => {
    // Endpoints are unguessable URLs, so these are defence in depth — but
    // "unguessable" is not an authorisation check, and the cost of the check is
    // one comparison.
    it("refuses to let one participant delete another's subscription", async () => {
      addHost();
      const peerKey = push.ownerKeyFor("peer", "share-1");

      const r = push.removeSubscription("https://push.example/host", peerKey);

      expect(r.ok).toBe(false);
      expect(push.listSubscriptions()).toHaveLength(1);
      // And the host still hears about their sessions.
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(1);
    });

    it("lets the owner delete their own subscription", () => {
      addHost();
      expect(push.removeSubscription("https://push.example/host", "host").ok).toBe(true);
      expect(push.listSubscriptions()).toHaveLength(0);
    });

    it("refuses to let a peer re-register someone else's endpoint under their own identity", () => {
      // Otherwise a peer could quietly re-scope another participant's device to
      // their own session — a hijack, not just a silencing.
      addHost();
      expect(() =>
        addPeer({ shareId: "share-1", sessionId: "s1", endpoint: "https://push.example/host" }),
      ).toThrow(push.PushOwnershipError);

      const [only] = push.listSubscriptions();
      expect(only.ownerKind).toBe("host");
    });

  });

  describe("present participants don't need telling", () => {
    it("skips a participant who is here and foregrounded on that session", async () => {
      addHost();
      push.setParticipantActive("host", "s1");

      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(0);
      // A different session still notifies — they're only present on one.
      expect((await push.notifyForEvent(chat("s2", "Ana"))).sent).toBe(1);
    });

    it("resumes the moment presence goes inactive (tab backgrounded or left)", async () => {
      addHost();
      push.setParticipantActive("host", "s1");
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(0);

      push.setParticipantActive("host", null);
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(1);
    });

    it("expires a stale beat and fails toward notifying", async () => {
      // A tab that slept or died must not silence a blocking question forever.
      // Missing an ask is worse than a redundant buzz.
      vi.useFakeTimers();
      try {
        addHost();
        push.setParticipantActive("host", "s1");
        expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(0);

        vi.advanceTimersByTime(30_000);
        expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("suppresses across ALL of that participant's devices, not just the active one", async () => {
      // Presence is per participant: watching on a laptop should keep the phone
      // quiet too.
      addHost();
      push.addSubscription({
        ownerKind: "host", shareId: null, sessionId: null, displayName: "host",
        capability: null, endpoint: "https://push.example/host-phone", keys: KEYS,
      });
      expect(push.listSubscriptions()).toHaveLength(2);

      push.setParticipantActive("host", "s1");
      expect((await push.notifyForEvent(chat("s1", "Ana"))).sent).toBe(0);
    });

    it("one participant's presence never silences another's notifications", async () => {
      addHost();
      addPeer({ shareId: "share-1", sessionId: "s1", name: "Ana" });
      // Ana is watching; the host is not.
      push.setParticipantActive(push.ownerKeyFor("peer", "share-1"), "s1");
      expect((await push.notifyForEvent(chat("s1", "someone-else"))).sent).toBe(1);
    });

    it("matches a watched session through a resumed id", async () => {
      addHost();
      push.setCanonicalResolver((id) => (id === "old-id" ? "new-id" : id));
      push.setParticipantActive("host", "old-id");
      expect((await push.notifyForEvent(chat("new-id", "Ana"))).sent).toBe(0);
    });
  });

  describe("noise", () => {
    it("does not notify for a turn-complete with nothing to read", async () => {
      // countsAsUnseen already refuses to raise a dot for this; the sender has
      // to agree, or every finished turn buzzes with an empty body.
      addHost();
      const { sent } = await push.notifyForEvent({ session_id: "s1", hook_type: "Stop", text: "" });
      expect(sent).toBe(0);
    });

    it("still notifies for a turn that produced a message", async () => {
      addHost();
      const { sent } = await push.notifyForEvent({ session_id: "s1", hook_type: "Stop", text: "all done" });
      expect(sent).toBe(1);
    });
  });

  describe("endpoint hygiene", () => {
    it("prunes an endpoint the push service reports as permanently gone", async () => {
      addHost();
      sendNotification.mockRejectedValueOnce(Object.assign(new Error("gone"), { statusCode: 410 }));
      await push.notifyForEvent(chat("s1", "Ana"));
      expect(push.listSubscriptions()).toHaveLength(0);
    });

    it("keeps the subscription on a transient failure so the next event retries", async () => {
      addHost();
      sendNotification.mockRejectedValueOnce(Object.assign(new Error("boom"), { statusCode: 500 }));
      await push.notifyForEvent(chat("s1", "Ana"));
      expect(push.listSubscriptions()).toHaveLength(1);
    });
  });

  describe("bus wiring", () => {
    it("delivers events emitted on the ingest bus", async () => {
      addHost();
      push.startPushNotifier();
      eventBus.emit("event", chat("s1", "Ana"));
      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1));
    });
  });
});
