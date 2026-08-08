import { describe, it, expect } from "vitest";
import {
  createJoinTicket,
  joinStatus,
  getJoinTicket,
  admitJoin,
  denyJoin,
  claimJoin,
  listPendingJoins,
  dropJoinsForShare,
} from "./peer-joins";

function mk(shareId = "share-1", sessionId = "sess-1", peerName: string | null = "Alice") {
  return createJoinTicket({ shareId, sessionId, peerName });
}

describe("peer-joins: host-admits-each-join gate", () => {
  it("a fresh ticket is pending and appears in the host's pending list (no secret leaked)", () => {
    const { ticketId } = mk("share-A");
    expect(joinStatus(ticketId)).toBe("pending");
    const pending = listPendingJoins().find((j) => j.ticketId === ticketId);
    expect(pending).toBeDefined();
    expect(pending!.peerName).toBe("Alice");
    expect((pending as Record<string, unknown>).secret).toBeUndefined();
  });

  it("carries the joiner IP + country through to the pending list (info for the decider)", () => {
    const { ticketId } = createJoinTicket({ shareId: "share-ip", sessionId: "sess-ip", peerName: "Ivy", peerIp: "203.0.113.7", peerCountry: "US" });
    const pending = listPendingJoins().find((j) => j.ticketId === ticketId);
    expect(pending?.peerIp).toBe("203.0.113.7");
    expect(pending?.peerCountry).toBe("US");
    // Absent IP/country default to null rather than undefined.
    const { ticketId: t2 } = createJoinTicket({ shareId: "share-noip", sessionId: "sess-noip", peerName: "Ivo" });
    const p2 = listPendingJoins().find((j) => j.ticketId === t2);
    expect(p2?.peerIp).toBeNull();
    expect(p2?.peerCountry).toBeNull();
  });

  it("admit → status admitted; a matching-secret claim consumes it once", () => {
    const { ticketId, secret } = mk("share-B", "sess-B", "Bob");
    expect(admitJoin(ticketId).ok).toBe(true);
    expect(joinStatus(ticketId)).toBe("admitted");
    const grant = claimJoin(ticketId, secret);
    expect(grant).toEqual({ shareId: "share-B", sessionId: "sess-B", peerName: "Bob" });
    // One-time: a second claim (or a status read) finds nothing.
    expect(claimJoin(ticketId, secret)).toBeNull();
    expect(joinStatus(ticketId)).toBe("expired");
  });

  it("claim with the wrong secret is rejected (ticket hijack protection)", () => {
    const { ticketId } = mk("share-C");
    admitJoin(ticketId);
    expect(claimJoin(ticketId, "not-the-secret")).toBeNull();
    // Still admitted (not consumed by a failed claim).
    expect(joinStatus(ticketId)).toBe("admitted");
  });

  it("cannot claim a ticket that was never admitted", () => {
    const { ticketId, secret } = mk("share-D");
    expect(claimJoin(ticketId, secret)).toBeNull();
  });

  it("deny returns the shareId (so the caller revokes) and blocks the join", () => {
    const { ticketId, secret } = mk("share-E");
    const r = denyJoin(ticketId);
    expect(r.ok).toBe(true);
    expect(r.shareId).toBe("share-E");
    expect(joinStatus(ticketId)).toBe("denied");
    expect(claimJoin(ticketId, secret)).toBeNull();
  });

  it("admit/deny are no-ops once a ticket is already resolved", () => {
    const { ticketId } = mk("share-F");
    expect(admitJoin(ticketId).ok).toBe(true);
    expect(admitJoin(ticketId).ok).toBe(false); // already admitted
    expect(denyJoin(ticketId).ok).toBe(false);  // can't deny an admitted one
  });

  it("dropJoinsForShare removes every ticket bound to a revoked share", () => {
    const a = mk("share-G");
    const b = mk("share-G", "sess-G2", "Carol");
    const other = mk("share-H");
    dropJoinsForShare("share-G");
    expect(joinStatus(a.ticketId)).toBe("expired");
    expect(joinStatus(b.ticketId)).toBe("expired");
    expect(joinStatus(other.ticketId)).toBe("pending");
  });

  it("unknown ticket ids read as expired", () => {
    expect(joinStatus("does-not-exist")).toBe("expired");
    expect(admitJoin("nope").ok).toBe(false);
    expect(claimJoin("nope", "x")).toBeNull();
  });

  it("getJoinTicket peeks session/share for the admit gate without consuming", () => {
    const { ticketId } = mk("share-peek", "sess-peek", "Dana");
    const t = getJoinTicket(ticketId);
    expect(t).toEqual({ shareId: "share-peek", sessionId: "sess-peek", peerName: "Dana", status: "pending" });
    // Non-consuming: still pending and still admittable afterwards.
    expect(joinStatus(ticketId)).toBe("pending");
    expect(admitJoin(ticketId).ok).toBe(true);
    expect(getJoinTicket("does-not-exist")).toBeNull();
  });
});
