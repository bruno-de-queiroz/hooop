import { describe, it, expect } from "vitest";
import {
  truncate,
  textOf,
  extractField,
  extractObj,
  relTime,
  formatTokens,
  formatDuration,
  cwdBasename,
  sessionDisplayLabel,
} from "./format";

describe("truncate", () => {
  it("returns the input when it's short enough", () => {
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("abcdef", 6)).toBe("abcdef");
  });

  it("slices and appends ellipsis when longer than n", () => {
    expect(truncate("abcdefg", 3)).toBe("abc…");
    expect(truncate("abcdefg", 6)).toBe("abcdef…");
  });

  it("handles empty strings", () => {
    expect(truncate("", 5)).toBe("");
  });
});

describe("textOf", () => {
  it("returns strings as-is", () => {
    expect(textOf("hello")).toBe("hello");
  });

  it("renders (empty) for null and undefined", () => {
    expect(textOf(null)).toBe("(empty)");
    expect(textOf(undefined)).toBe("(empty)");
  });

  it("extracts Bash-style stdout/stderr", () => {
    expect(textOf({ stdout: "ok", stderr: "" })).toBe("ok");
    expect(textOf({ stdout: "out", stderr: "warn" })).toBe("out\n[stderr]\nwarn");
    expect(textOf({ stderr: "boom" })).toBe("[stderr]\nboom");
  });

  it("prefers content over stringified JSON", () => {
    expect(textOf({ content: "body" })).toBe("body");
    expect(textOf({ output: "lines" })).toBe("lines");
    expect(textOf({ text: "tee" })).toBe("tee");
    expect(textOf({ message: "msg" })).toBe("msg");
  });

  it("joins string content arrays from tool_response shape", () => {
    expect(textOf({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
  });

  it("falls back to pretty JSON for unknown shapes", () => {
    expect(textOf({ foo: 1, bar: 2 })).toBe(JSON.stringify({ foo: 1, bar: 2 }, null, 2));
  });

  it("renders primitives via String()", () => {
    expect(textOf(42)).toBe("42");
    expect(textOf(true)).toBe("true");
  });
});

describe("extractField", () => {
  it("pulls a key=value out of the pipe-tail format", () => {
    expect(extractField("[Stop] | last_assistant_message=hello | kind=info", "last_assistant_message")).toBe("hello");
    expect(extractField("[Stop] | kind=info", "kind")).toBe("info");
  });

  it("returns null when the key is missing or text is empty", () => {
    expect(extractField("[Stop] | foo=bar", "missing")).toBeNull();
    expect(extractField(null, "any")).toBeNull();
    expect(extractField("", "any")).toBeNull();
  });
});

describe("extractObj", () => {
  it("parses a JSON value tucked into the tail", () => {
    const text = '[Pre] | tool_input={"command":"ls"} ';
    expect(extractObj(text, "tool_input")).toEqual({ command: "ls" });
  });

  it("returns the raw string when it isn't valid JSON", () => {
    expect(extractObj("foo=plainvalue", "foo")).toBe("plainvalue");
  });

  it("returns null when missing", () => {
    expect(extractObj("nothing", "x")).toBeNull();
  });
});

describe("relTime", () => {
  const now = Date.now();
  const iso = (offsetMs: number) => new Date(now - offsetMs).toISOString();

  it("renders 'now' for very recent timestamps", () => {
    expect(relTime(iso(5_000))).toBe("now");
  });

  it("renders minutes under an hour", () => {
    expect(relTime(iso(2 * 60_000))).toBe("2m");
    expect(relTime(iso(59 * 60_000))).toBe("59m");
  });

  it("renders hours under a day", () => {
    expect(relTime(iso(3 * 3_600_000))).toBe("3h");
  });

  it("renders days beyond that", () => {
    expect(relTime(iso(5 * 86_400_000))).toBe("5d");
  });
});

describe("formatTokens", () => {
  it("returns exact integers under 1k", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(7)).toBe("7");
    expect(formatTokens(842)).toBe("842");
    expect(formatTokens(999)).toBe("999");
  });

  it("formats thousands with one decimal (trimming .0)", () => {
    expect(formatTokens(1_000)).toBe("1k");
    expect(formatTokens(8_420)).toBe("8.4k");
    expect(formatTokens(84_210)).toBe("84.2k");
    expect(formatTokens(999_499)).toBe("999.5k");
  });

  it("formats millions with one decimal", () => {
    expect(formatTokens(1_000_000)).toBe("1m");
    expect(formatTokens(1_234_567)).toBe("1.2m");
    expect(formatTokens(12_500_000)).toBe("12.5m");
  });

  it("handles null, undefined, NaN, and negatives as '0'", () => {
    expect(formatTokens(null)).toBe("0");
    expect(formatTokens(undefined)).toBe("0");
    expect(formatTokens(NaN)).toBe("0");
    expect(formatTokens(-5)).toBe("0");
  });
});

describe("formatDuration", () => {
  it("renders seconds under a minute", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(1_000)).toBe("1s");
    expect(formatDuration(59_999)).toBe("59s");
  });

  it("renders minutes-and-seconds under an hour, zero-padded", () => {
    expect(formatDuration(60_000)).toBe("1m 00s");
    expect(formatDuration(60_000 + 4_000)).toBe("1m 04s");
    expect(formatDuration(12 * 60_000 + 4_000)).toBe("12m 04s");
    expect(formatDuration(59 * 60_000 + 59_000)).toBe("59m 59s");
  });

  it("renders hours-and-minutes beyond an hour, zero-padded", () => {
    expect(formatDuration(60 * 60_000)).toBe("1h 00m");
    expect(formatDuration(2 * 60 * 60_000 + 12 * 60_000)).toBe("2h 12m");
  });

  it("handles null, undefined, NaN, and negatives as '0s'", () => {
    expect(formatDuration(null)).toBe("0s");
    expect(formatDuration(undefined)).toBe("0s");
    expect(formatDuration(NaN)).toBe("0s");
    expect(formatDuration(-100)).toBe("0s");
  });
});

describe("cwdBasename", () => {
  it("returns the last path segment", () => {
    expect(cwdBasename("/home/agent/workspace")).toBe("workspace");
    expect(cwdBasename("/workspace")).toBe("workspace");
  });
  it("returns '/' for the root and '' for empty", () => {
    expect(cwdBasename("/")).toBe("/");
    expect(cwdBasename("")).toBe("");
    expect(cwdBasename(undefined)).toBe("");
    expect(cwdBasename(null)).toBe("");
  });
});

describe("sessionDisplayLabel", () => {
  it("prefers the displayName slug", () => {
    expect(sessionDisplayLabel({ displayName: "Calm Nesting Thompson" })).toBe("calm-nesting-thompson");
  });
  it("falls back to skill when displayName is empty", () => {
    expect(sessionDisplayLabel({ displayName: "  ", skill: "hooop:setup" })).toBe("hooop:setup");
  });
  it("falls back to cwd basename, then short id", () => {
    expect(sessionDisplayLabel({ cwd: "/home/agent/workspace" })).toBe("workspace");
    expect(sessionDisplayLabel({ sessionId: "abcdef12-3456" })).toBe("abcdef12");
    expect(sessionDisplayLabel({ id: "zzzzzzzz-1" })).toBe("zzzzzzzz");
  });
  it("never returns empty", () => {
    expect(sessionDisplayLabel({})).toBe("session");
  });
});
