import { describe, it, expect } from "vitest";
import { deriveHandles, extractMentions, toHandle } from "./handles";

describe("toHandle", () => {
  it("slugs a display name into something typeable after '@'", () => {
    expect(toHandle("Bruno de Queiroz")).toBe("bruno-de-queiroz");
    expect(toHandle("Sam")).toBe("sam");
  });

  it("folds accents so the handle can be typed on a plain keyboard", () => {
    expect(toHandle("José")).toBe("jose");
  });

  it("drops punctuation and collapses separators", () => {
    expect(toHandle("Sam O'Neill")).toBe("sam-o-neill");
    expect(toHandle("  spaced   out  ")).toBe("spaced-out");
    expect(toHandle("Ann-Marie")).toBe("ann-marie");
  });

  it("falls back for a name with nothing sluggable in it", () => {
    // A handle has to be typeable; an empty one could never be matched.
    expect(toHandle("안나")).toBe("peer");
    expect(toHandle("")).toBe("peer");
    expect(toHandle("!!!")).toBe("peer");
  });

  it("produces only characters the composer's mention token accepts", () => {
    for (const name of ["Bruno de Queiroz", "Sam O'Neill", "José", "안나", "A  B"]) {
      expect(toHandle(name)).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("deriveHandles", () => {
  it("keeps handles unique within a roster", () => {
    expect(deriveHandles(["Sam", "Sam", "Sam"])).toEqual(["sam", "sam-2", "sam-3"]);
  });

  it("only suffixes the ones that actually collide", () => {
    expect(deriveHandles(["Sam", "Bruno", "Sam"])).toEqual(["sam", "bruno", "sam-2"]);
  });

  it("disambiguates names that slug to the same thing", () => {
    expect(deriveHandles(["José", "Jose"])).toEqual(["jose", "jose-2"]);
  });

  it("disambiguates unsluggable names instead of colliding on the fallback", () => {
    expect(deriveHandles(["안나", "테스트"])).toEqual(["peer", "peer-2"]);
  });

  it("is positional, so a stably-ordered roster gives stable handles", () => {
    // listPresence sorts by participantId for exactly this reason: if the order
    // moved, two people named Sam would swap handles between frames and a
    // mention typed against one frame would resolve to the other.
    const roster = ["Sam", "Sam"];
    expect(deriveHandles(roster)).toEqual(deriveHandles(roster));
  });

  it("returns one handle per name, in order", () => {
    expect(deriveHandles([])).toEqual([]);
    expect(deriveHandles(["A", "B", "C"])).toHaveLength(3);
  });
});

describe("extractMentions", () => {
  it("finds handles named in a message", () => {
    expect(extractMentions("hey @sam can you look")).toEqual(["sam"]);
    expect(extractMentions("@sam @ada")).toEqual(["sam", "ada"]);
  });

  it("does not fire inside an email address", () => {
    // Otherwise writing out an address would notify whoever matched the domain.
    expect(extractMentions("mail bruno@example.com")).toEqual([]);
  });

  it("dedupes repeats", () => {
    expect(extractMentions("@sam and again @sam")).toEqual(["sam"]);
  });

  it("ignores tokens that can't be a handle", () => {
    expect(extractMentions("@ alone")).toEqual([]);
    expect(extractMentions("@Sam")).toEqual([]); // handles are lowercase slugs
    expect(extractMentions("no mentions here")).toEqual([]);
  });

  it("stops at the end of the handle", () => {
    expect(extractMentions("@sam, and @ada.")).toEqual(["sam", "ada"]);
    expect(extractMentions("(@sam)")).toEqual([]); // no word boundary before it
  });
});
