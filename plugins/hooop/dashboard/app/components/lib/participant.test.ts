import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { peerCapability, canDecidePlans, myDisplayName, stashHostName, stashPeerName } from "./participant";

// The client reads identity from layout-injected <meta> tags. These tests drive
// the plan-decision gate: who may Approve/Reject a plan review.
function setMeta(name: string, content: string) {
  const m = document.createElement("meta");
  m.setAttribute("name", name);
  m.setAttribute("content", content);
  document.head.appendChild(m);
}

afterEach(() => {
  document.head.querySelectorAll("meta[name^='x-hooop-']").forEach((m) => m.remove());
  try { sessionStorage.clear(); } catch { /* ignore */ }
  // Now persisted per BROWSER, not per tab, so it outlives a test too.
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe("display names", () => {
  it("host advertises 'Host' until the identity loads, then the first name", () => {
    expect(myDisplayName()).toBe("Host"); // no participant meta ⇒ host
    stashHostName("Bruno de Queiroz");
    expect(myDisplayName()).toBe("Bruno"); // first token only
  });

  it("a peer advertises the name they picked at join", () => {
    setMeta("x-hooop-participant", "peer");
    expect(myDisplayName()).toBe("Guest"); // nothing stashed yet
    stashPeerName("Alex");
    expect(myDisplayName()).toBe("Alex");
  });
});

describe("participant plan-decision gate", () => {
  it("host (no participant meta) may decide", () => {
    expect(canDecidePlans()).toBe(true);
    expect(peerCapability()).toBeNull();
  });

  it("a full-capability peer may decide", () => {
    setMeta("x-hooop-participant", "peer");
    setMeta("x-hooop-peer-capability", "full");
    expect(peerCapability()).toBe("full");
    expect(canDecidePlans()).toBe(true);
  });

  it("a drive peer may NOT decide (comment-only)", () => {
    setMeta("x-hooop-participant", "peer");
    setMeta("x-hooop-peer-capability", "drive");
    expect(peerCapability()).toBe("drive");
    expect(canDecidePlans()).toBe(false);
  });

  it("a spectate peer may NOT decide", () => {
    setMeta("x-hooop-participant", "peer");
    setMeta("x-hooop-peer-capability", "spectate");
    expect(canDecidePlans()).toBe(false);
  });

  it("a peer with a missing/garbled capability may NOT decide (fail closed)", () => {
    setMeta("x-hooop-participant", "peer");
    expect(peerCapability()).toBeNull();
    expect(canDecidePlans()).toBe(false);
  });
});

describe("a peer's own name in a tab that did not do the joining", () => {
  // sessionStorage is per TAB, and only the joining tab ever had the name. A
  // second tab, a restored one, or the link followed again on a phone fell back
  // to "Guest" — which is not merely an ugly label. It is a DIFFERENT identity
  // from the one the server attributes their turns to, so a peer's own message
  // showed up as somebody else and its optimistic row never reconciled with the
  // real event when it arrived.
  beforeEach(() => setMeta("x-hooop-participant", "peer"));

  it("remembers the name for the whole browser, not just the tab", () => {
    stashPeerName("Alex");
    sessionStorage.clear();               // a different tab
    expect(myDisplayName()).toBe("Alex");
  });

  it("prefers this tab's own name when it has one", () => {
    // Two people on one machine, one of them in a private window: whoever this
    // tab joined as wins over whoever the browser last remembered.
    stashPeerName("Alex");
    sessionStorage.setItem("hooop_peer_name", "Sam");
    expect(myDisplayName()).toBe("Sam");
  });

  it("still says Guest when nobody has ever named themselves", () => {
    expect(myDisplayName()).toBe("Guest");
  });
});
