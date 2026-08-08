import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

describe("presence registry", () => {
  let mod: typeof import("./presence");

  beforeEach(async () => {
    // Fresh globalThis singleton per test.
    delete (globalThis as any).__hooop_presence__;
    vi.resetModules();
    mod = await import("./presence");
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).__hooop_presence__;
  });

  it("tracks participants per session and dedupes by participantId", () => {
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
    mod.heartbeat({ sessionId: "s1", participantId: "peer:abc", name: "Bob", kind: "peer", typing: true });
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" }); // refresh

    const list = mod.listPresence("s1");
    expect(list).toHaveLength(2);
    const bob = list.find((p) => p.participantId === "peer:abc");
    expect(bob?.name).toBe("Bob");
    expect(bob?.typing).toBe(true);
  });

  it("isolates sessions", () => {
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
    mod.heartbeat({ sessionId: "s2", participantId: "host", name: "Host", kind: "host" });
    expect(mod.listPresence("s1")).toHaveLength(1);
    expect(mod.listPresence("s2")).toHaveLength(1);
    expect(mod.listPresence("nope")).toHaveLength(0);
  });

  it("leave() drops a participant and emits change", () => {
    let changes = 0;
    mod.presenceBus().on("change", () => { changes += 1; });
    mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
    mod.leave("s1", "peer:x");
    expect(mod.listPresence("s1")).toHaveLength(0);
    expect(changes).toBe(2); // heartbeat + leave
  });

  it("evicts a participant only past the long eviction window, not the idle window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
    expect(mod.listPresence("s1")).toHaveLength(1);
    // Still present well past the (short) idle/dim window.
    vi.setSystemTime(31_000);
    expect(mod.listPresence("s1")).toHaveLength(1);
    // Silently evicted only past the long window (EVICT_MS = 3 min) — no marker.
    vi.setSystemTime(3 * 60_000 + 1_000);
    expect(mod.listPresence("s1")).toHaveLength(0);
  });

  describe("away (dim) — NOT a departure", () => {
    it("a peer reporting its tab inactive is marked away, not removed, no marker", () => {
      const lefts: unknown[] = [];
      mod.presenceBus().on("left", (p) => lefts.push(p));
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer", active: false });
      const list = mod.listPresence("s1");
      expect(list).toHaveLength(1);
      expect(list[0].away).toBe(true);
      expect(lefts).toHaveLength(0);
    });

    it("an active peer is not away; goes away once its heartbeat is stale", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      expect(mod.listPresence("s1")[0].away).toBe(false);
      // Past the idle window (25s) but nowhere near GONE — dimmed, still here.
      vi.setSystemTime(26_000);
      const list = mod.listPresence("s1");
      expect(list).toHaveLength(1);
      expect(list[0].away).toBe(true);
    });

    it("hosts are never marked away", () => {
      mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host", active: false });
      expect(mod.listPresence("s1")[0].away).toBe(false);
    });
  });

  describe("presence NEVER emits a 'left' marker (explicit-leave-only policy)", () => {
    // The durable `PeerLeft` transcript marker now has exactly ONE source: the
    // explicit "Leave session" route. The presence registry only tracks who's
    // here (and dims the away/gone) — it must never emit a "left" signal from
    // inactivity, tab-close beacons, or eviction. These guard that contract.
    function collectLefts() {
      const lefts: unknown[] = [];
      mod.presenceBus().on("left", (p) => lefts.push(p));
      return lefts;
    }

    it("does not emit 'left' for a backgrounded peer, however long it stays away", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer", active: false });
      // Far past any old TTL/watchdog window — must stay (dimmed), never "left".
      vi.advanceTimersByTime(10 * 60_000);
      expect(lefts).toHaveLength(0);
      // Eventually evicted from the roster (silently), still no marker.
      expect(mod.listPresence("s1")).toHaveLength(0);
    });

    it("a beacon leave drops the roster entry silently — no 'left' emitted", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "peer:x", name: "X", kind: "peer" });
      mod.leave("s1", "peer:x"); // tab-close beacon — roster only
      expect(mod.listPresence("s1")).toHaveLength(0);
      vi.advanceTimersByTime(5 * 60_000);
      expect(lefts).toHaveLength(0);
    });

    it("never emits 'left' for a host", () => {
      vi.useFakeTimers();
      const lefts = collectLefts();
      mod.heartbeat({ sessionId: "s1", participantId: "host", name: "Host", kind: "host" });
      mod.leave("s1", "host");
      vi.advanceTimersByTime(5 * 60_000);
      expect(lefts).toHaveLength(0);
    });
  });
});
