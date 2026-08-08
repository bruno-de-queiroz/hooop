import { describe, it, expect } from "vitest";
import { detectTrigger, spliceTrigger } from "./useComposerAutocomplete";

describe("detectTrigger", () => {
  it("opens the slash trigger for a bare '/' at the start of the message", () => {
    expect(detectTrigger("/", 1)).toEqual({ type: "slash", start: 0, query: "" });
  });

  it("keeps the slash trigger open while typing the command name", () => {
    expect(detectTrigger("/pla", 4)).toEqual({ type: "slash", start: 0, query: "pla" });
  });

  it("closes the slash trigger once a space is typed", () => {
    expect(detectTrigger("/plan ", 6)).toBeNull();
  });

  it("does not open the slash trigger mid-message", () => {
    expect(detectTrigger("hello /plan", 11)).toBeNull();
  });

  it("scopes the query to the text left of the caret, not the whole token", () => {
    // Caret sits after "/pl" even though the full text is "/plan".
    expect(detectTrigger("/plan", 3)).toEqual({ type: "slash", start: 0, query: "pl" });
  });

  it("opens the file trigger for a bare '@' at the start of the message", () => {
    expect(detectTrigger("@", 1)).toEqual({ type: "file", start: 0, query: "" });
  });

  it("opens the file trigger mid-message, after whitespace", () => {
    const text = "please check @src/inde";
    expect(detectTrigger(text, text.length)).toEqual({
      type: "file",
      start: 13,
      query: "src/inde",
    });
  });

  it("closes the file trigger once a space is typed after the path", () => {
    expect(detectTrigger("look at @a.ts now", 9)).toEqual({ type: "file", start: 8, query: "" });
    expect(detectTrigger("look at @a.ts now", 13)).toEqual({ type: "file", start: 8, query: "a.ts" });
    expect(detectTrigger("look at @a.ts now", 14)).toBeNull();
  });

  it("returns null when the caret isn't inside any trigger token", () => {
    expect(detectTrigger("just a normal message", 10)).toBeNull();
  });

  it("prefers slash detection when the whole prefix is still a slash token", () => {
    // Not a realistic case (both can't match at once for the same caret),
    // but slash's stricter regex should win when it matches at all.
    expect(detectTrigger("/x", 2)?.type).toBe("slash");
  });
});

describe("spliceTrigger", () => {
  it("replaces the slash token (from message start) with the insertion + a space", () => {
    const result = spliceTrigger("/pla", 4, { type: "slash", start: 0, query: "pla" }, "/plan");
    expect(result).toEqual({ text: "/plan ", cursor: 6 });
  });

  it("replaces the @token in place, preserving text before and after", () => {
    const text = "please check @src/inde";
    const result = spliceTrigger(
      text,
      text.length,
      { type: "file", start: 13, query: "src/inde" },
      "@src/index.ts",
    );
    expect(result).toEqual({ text: "please check @src/index.ts ", cursor: 27 });
  });

  it("preserves trailing text after the caret", () => {
    const result = spliceTrigger(
      "/pl more text",
      3,
      { type: "slash", start: 0, query: "pl" },
      "/plan",
    );
    expect(result).toEqual({ text: "/plan  more text", cursor: 6 });
  });
});
