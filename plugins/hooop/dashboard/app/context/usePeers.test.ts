import { describe, it, expect } from "vitest";
import { toEntries } from "./usePeers";
import type { PresenceParticipant } from "./hooks/usePresence";

const p = (over: Partial<PresenceParticipant> = {}): PresenceParticipant => ({
  participantId: "peer:a",
  name: "Sam",
  kind: "peer",
  typing: false,
  lastSeen: 0,
  handle: "sam",
  ...over,
});

describe("toEntries", () => {
  it("maps a participant to a mention row", () => {
    expect(toEntries([p()], "host", "")).toEqual([
      { insert: "@sam", label: "Sam", description: "peer", kind: "peer", source: null },
    ]);
  });

  it("never offers a self-mention", () => {
    // You are never the person being called over.
    expect(toEntries([p({ participantId: "host" })], "host", "")).toEqual([]);
    expect(toEntries([p({ participantId: "peer:a" })], "peer:a", "")).toEqual([]);
  });

  it("matches on the handle or the display name", () => {
    const roster = [p({ participantId: "peer:b", name: "Bruno de Queiroz", handle: "bruno-de-queiroz" })];
    // Both halves of a name people actually read off an avatar.
    expect(toEntries(roster, "host", "bruno")).toHaveLength(1);
    expect(toEntries(roster, "host", "queiroz")).toHaveLength(1);
    expect(toEntries(roster, "host", "de-que")).toHaveLength(1);
    expect(toEntries(roster, "host", "zzz")).toHaveLength(0);
  });

  it("is case-insensitive", () => {
    expect(toEntries([p({ name: "Sam" })], "host", "SA")).toHaveLength(1);
  });

  it("skips a participant with no handle", () => {
    // An older presence frame carries no handle; offering it would insert a
    // bare "@" that resolves to nobody.
    expect(toEntries([p({ handle: undefined })], "host", "")).toEqual([]);
  });

  it("labels the host and an away peer distinctly", () => {
    expect(toEntries([p({ kind: "host", participantId: "host" })], "peer:a", "")[0].description).toBe("host");
    expect(toEntries([p({ away: true })], "host", "")[0].description).toBe("away");
  });

  it("keeps everyone when the query is empty", () => {
    const roster = [p({ participantId: "peer:a", handle: "sam" }), p({ participantId: "peer:b", name: "Ada", handle: "ada" })];
    expect(toEntries(roster, "host", "")).toHaveLength(2);
  });
});
