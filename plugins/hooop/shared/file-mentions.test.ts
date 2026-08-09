import { describe, it, expect } from "vitest";
import { FILE_MENTION, parseFileMention, toClaudeFileRefs } from "./file-mentions";

/** Every match in `s`, using the shared (global) regex the way consumers do. */
function mentions(s: string): string[] {
  return [...s.matchAll(FILE_MENTION)].map((m) => m[0]);
}

describe("FILE_MENTION", () => {
  it("matches path-shaped tokens, including dotfiles and nested paths", () => {
    expect(mentions("check #src/index.ts please")).toEqual(["#src/index.ts"]);
    expect(mentions("#.gitignore")).toEqual(["#.gitignore"]);
    expect(mentions("#README.md and #a/b/c-d.py")).toEqual(["#README.md", "#a/b/c-d.py"]);
  });

  it("keeps a :line suffix as part of the same mention", () => {
    expect(mentions("look at #src/index.ts:42")).toEqual(["#src/index.ts:42"]);
  });

  it("leaves an issue reference alone, including mid-sentence", () => {
    // The reason the all-digit exclusion exists: "#123" in chat is an issue
    // number far more often than a file named 123. Trailing punctuation is the
    // common case and has to be covered, not just end-of-string.
    expect(mentions("#123")).toEqual([]);
    expect(mentions("fixes #123")).toEqual([]);
    expect(mentions("fixes #123, and #456; also #789.")).toEqual([]);
    expect(mentions("see #1.")).toEqual([]);
    expect(mentions("(#42)")).toEqual([]);
    // ...but a digit-led filename is still a filename.
    expect(mentions("#42.txt")).toEqual(["#42.txt"]);
    expect(mentions("#2024-notes.md")).toEqual(["#2024-notes.md"]);
  });

  it("does not fire mid-word", () => {
    expect(mentions("issue#4")).toEqual([]);
    expect(mentions("https://x.dev/docs#anchor")).toEqual([]);
  });

  it("does not match a markdown heading or a bare sigil", () => {
    expect(mentions("# Heading")).toEqual([]);
    expect(mentions("#")).toEqual([]);
    expect(mentions("## Sub")).toEqual([]);
  });
});

describe("parseFileMention", () => {
  it("splits the path from a :line suffix, with or without the sigil", () => {
    expect(parseFileMention("#src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
    expect(parseFileMention("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
  });

  it("returns a null line when there is no suffix", () => {
    expect(parseFileMention("#src/a.ts")).toEqual({ path: "src/a.ts", line: null });
    expect(parseFileMention("#.gitignore")).toEqual({ path: ".gitignore", line: null });
  });

  it("does not mistake a colon inside the path for a line number", () => {
    expect(parseFileMention("#a:b.ts")).toEqual({ path: "a:b.ts", line: null });
  });

  it("never yields an empty path", () => {
    expect(parseFileMention("#:12")).toEqual({ path: ":12", line: null });
  });

  it("round-trips every token the matcher produces", () => {
    // Guards the pairing: anything FILE_MENTION matches must parse to a
    // non-empty path, or click-to-open would hand the dock a blank target.
    for (const tok of mentions("#a.ts #b/c.ts:9 #.env #2024-notes.md")) {
      expect(parseFileMention(tok).path).not.toBe("");
    }
  });
});

describe("toClaudeFileRefs", () => {
  it("rewrites mentions to the @ syntax claude's CLI resolves", () => {
    expect(toClaudeFileRefs("check #src/index.ts")).toBe("check @src/index.ts");
    expect(toClaudeFileRefs("#a.ts and #b/c.ts:9")).toBe("@a.ts and @b/c.ts:9");
  });

  it("leaves text with no mentions byte-identical", () => {
    const s = "just a sentence, #123, and issue#4";
    expect(toClaudeFileRefs(s)).toBe(s);
  });

  it("leaves an existing literal @ alone", () => {
    // Nothing rewrites "@" any more, so a real email or scoped package survives.
    expect(toClaudeFileRefs("mail me@example.com about @scope/pkg")).toBe(
      "mail me@example.com about @scope/pkg",
    );
  });

  it("does not touch a fenced block", () => {
    // The case that motivated the skip: a pasted shell script whose comments
    // would otherwise each become a file reference.
    const s = [
      "run this:",
      "```bash",
      "#!/bin/bash",
      "#setup step",
      "echo #inline",
      "```",
      "and read #src/a.ts",
    ].join("\n");
    expect(toClaudeFileRefs(s)).toBe(
      [
        "run this:",
        "```bash",
        "#!/bin/bash",
        "#setup step",
        "echo #inline",
        "```",
        "and read @src/a.ts",
      ].join("\n"),
    );
  });

  it("handles tilde fences and longer fences", () => {
    const s = "~~~\n#a.ts\n~~~\n#b.ts";
    expect(toClaudeFileRefs(s)).toBe("~~~\n#a.ts\n~~~\n@b.ts");
    // A longer fence is not closed by a shorter one.
    const t = "````\n#a.ts\n```\n#b.ts\n````\n#c.ts";
    expect(toClaudeFileRefs(t)).toBe("````\n#a.ts\n```\n#b.ts\n````\n@c.ts");
  });

  it("treats an unterminated fence as running to the end", () => {
    expect(toClaudeFileRefs("```\n#a.ts\n#b.ts")).toBe("```\n#a.ts\n#b.ts");
  });

  it("does not touch an inline code span", () => {
    expect(toClaudeFileRefs("compare `#a.ts` with #b.ts")).toBe("compare `#a.ts` with @b.ts");
  });

  it("rewrites around an unmatched backtick rather than swallowing the line", () => {
    expect(toClaudeFileRefs("a ` b #c.ts")).toBe("a ` b @c.ts");
  });

  it("preserves the exact line structure, including trailing newlines", () => {
    expect(toClaudeFileRefs("#a.ts\n\n#b.ts\n")).toBe("@a.ts\n\n@b.ts\n");
  });
});
