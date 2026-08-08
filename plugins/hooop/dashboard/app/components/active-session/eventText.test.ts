import { describe, it, expect } from "vitest";
import type { EventRow } from "@/lib/sandbox-client";
import {
  userPromptText,
  assistantText,
  toolArgsText,
  toolResultText,
  systemText,
  extractEventField,
  bashShortcutData,
} from "./eventText";

function row(o: Partial<EventRow> & { text: string | null }): EventRow {
  return {
    id: o.id ?? 1,
    ts: o.ts ?? "2026-05-20T10:00:00Z",
    session_id: o.session_id ?? "s1",
    hook_type: o.hook_type ?? "UserPromptSubmit",
    tool_name: o.tool_name ?? null,
    text: o.text,
  };
}

describe("extractEventField", () => {
  it("returns the value of the named field up to the next ` | ` separator", () => {
    expect(
      extractEventField(
        "[UserPromptSubmit] | prompt=hello there | tool=null",
        "prompt",
      ),
    ).toBe("hello there");
  });

  it("returns null when the field is absent", () => {
    expect(
      extractEventField("[Stop] | other=foo", "prompt"),
    ).toBeNull();
  });

  it("returns the rest of the string when the field is the last one", () => {
    expect(
      extractEventField(
        "[Stop] | last_assistant_message=goodbye for now",
        "last_assistant_message",
      ),
    ).toBe("goodbye for now");
  });

  it("preserves `|` characters inside the value (markdown tables, regex examples)", () => {
    // The old `[^|]+` regex would have truncated at the first pipe.
    expect(
      extractEventField(
        "[Stop] | last_assistant_message=use `a | b` in regex | tool=null",
        "last_assistant_message",
      ),
    ).toBe("use `a | b` in regex");
  });
});

describe("userPromptText", () => {
  it("returns the bare text for an optimistic row (negative id)", () => {
    // Literal user input that happens to contain `prompt=` must not
    // trigger the field extractor — the old impl extracted "foo" by
    // accident here.
    const r = row({ id: -1, text: "set prompt= variable to foo" });
    expect(userPromptText(r)).toBe("set prompt= variable to foo");
  });

  it("strips the structured wrapper from a real row", () => {
    const r = row({
      id: 7,
      text: "[UserPromptSubmit] | prompt=hello there",
    });
    expect(userPromptText(r)).toBe("hello there");
  });

  it("falls back to raw text when the row isn't structured", () => {
    const r = row({ id: 9, text: "bare text, no wrapper" });
    expect(userPromptText(r)).toBe("bare text, no wrapper");
  });

  it("returns empty string for null text", () => {
    const r = row({ text: null });
    expect(userPromptText(r)).toBe("");
  });

  it("returns '' for a structured row with no prompt= field (image-only turn)", () => {
    // The sandbox's deriveText drops the empty prompt of an image-only turn,
    // leaving just the bare wrapper. The old `?? row.text` fallback leaked
    // "[UserPromptSubmit]" into the bubble as message text.
    const r = row({ id: 7, hook_type: "UserPromptSubmit", text: "[UserPromptSubmit]" });
    expect(userPromptText(r)).toBe("");
  });

  it("returns '' for a bare [Chat] wrapper (image-only chat message)", () => {
    const r = row({ id: 8, hook_type: "Chat", text: "[Chat]" });
    expect(userPromptText(r)).toBe("");
  });
});

describe("assistantText", () => {
  it("extracts last_assistant_message from a Stop frame", () => {
    const r = row({
      hook_type: "Stop",
      text: "[Stop] | last_assistant_message=ALPHA | kind=info",
    });
    expect(assistantText(r)).toBe("ALPHA");
  });

  it("falls back to message when last_assistant_message isn't present", () => {
    const r = row({
      hook_type: "Stop",
      text: "[Stop] | message=heartbeat",
    });
    expect(assistantText(r)).toBe("heartbeat");
  });

  it("falls back to raw text for unstructured input (synthetic frames)", () => {
    const r = row({ text: "just the body" });
    expect(assistantText(r)).toBe("just the body");
  });

  it("does NOT fall back to the `transcript` field — that's a file path, not assistant content", () => {
    // Regression: an earlier impl let `transcript=/path/to/foo.jsonl`
    // flow through to the assistant row when last_assistant_message
    // and message were both absent. We want the raw wrapper visible
    // in that case (so the bug is loud) rather than surfacing a file
    // path as the model's reply.
    const r = row({
      hook_type: "Stop",
      text: "[Stop] | transcript=/home/agent/.claude/projects/abc/session.jsonl",
    });
    expect(assistantText(r)).not.toBe(
      "/home/agent/.claude/projects/abc/session.jsonl",
    );
  });

  it("does NOT treat ` | foo=` as a separator unless `foo` is a known sandbox field", () => {
    // Regression: an earlier impl accepted ANY `<word>=` after ` | ` as
    // a separator. A user prompt containing `| foo=bar` would have been
    // truncated. The fix anchors the separator alternation to the known
    // sandbox field set.
    expect(
      extractEventField(
        "[Stop] | last_assistant_message=consider: x=1 | foo=bar continues",
        "last_assistant_message",
      ),
    ).toBe("consider: x=1 | foo=bar continues");
  });
});

describe("toolArgsText / toolResultText", () => {
  it("pulls tool_input for PreToolUse args", () => {
    const r = row({
      hook_type: "PreToolUse",
      text: "[PreToolUse] | tool=Bash | tool_input={\"command\":\"ls\"}",
    });
    expect(toolArgsText(r)).toBe('{"command":"ls"}');
  });

  it("pulls tool_response for PostToolUse result", () => {
    const r = row({
      hook_type: "PostToolUse",
      text: "[PostToolUse] | tool=Bash | tool_response=file1\\nfile2",
    });
    expect(toolResultText(r)).toBe("file1\\nfile2");
  });

  it("returns empty string when args aren't present", () => {
    const r = row({
      hook_type: "PreToolUse",
      text: "[PreToolUse] | tool=Bash",
    });
    expect(toolArgsText(r)).toBe("");
  });
});

describe("systemText", () => {
  it("extracts message from a Notification", () => {
    const r = row({
      hook_type: "Notification",
      text: "[Notification] | message=session resumed",
    });
    expect(systemText(r)).toBe("session resumed");
  });

  it("falls back to kind when message is absent", () => {
    const r = row({
      hook_type: "PreCompact",
      text: "[PreCompact] | kind=auto",
    });
    expect(systemText(r)).toBe("auto");
  });
});

describe("bashShortcutData", () => {
  it("parses the command from tool_input and the structured response", () => {
    const response = JSON.stringify({
      exit_code: 0,
      signal: null,
      duration_ms: 42,
      timed_out: false,
      stdout: "hello\n",
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
    });
    const r = row({
      hook_type: "BashShortcut",
      tool_name: "BashShortcut",
      text: `[BashShortcut] | tool=BashShortcut | tool_input=echo hello | tool_response=${response}`,
    });
    const data = bashShortcutData(r);
    expect(data).not.toBeNull();
    expect(data!.command).toBe("echo hello");
    expect(data!.exitCode).toBe(0);
    expect(data!.durationMs).toBe(42);
    expect(data!.stdout).toBe("hello\n");
    expect(data!.timedOut).toBe(false);
  });

  it("returns defaults when tool_response is missing", () => {
    const r = row({
      hook_type: "BashShortcut",
      tool_name: "BashShortcut",
      text: "[BashShortcut] | tool=BashShortcut | tool_input=pwd",
    });
    const data = bashShortcutData(r);
    expect(data).not.toBeNull();
    expect(data!.command).toBe("pwd");
    expect(data!.exitCode).toBeNull();
    expect(data!.stdout).toBe("");
  });

  it("returns null on a row with no text at all", () => {
    const r = row({ hook_type: "BashShortcut", text: null });
    expect(bashShortcutData(r)).toBeNull();
  });

  it("surfaces a non-zero exit code", () => {
    const response = JSON.stringify({
      exit_code: 127,
      signal: null,
      duration_ms: 5,
      timed_out: false,
      stdout: "",
      stderr: "bash: nope: command not found\n",
      stdout_truncated: false,
      stderr_truncated: false,
    });
    const r = row({
      hook_type: "BashShortcut",
      tool_name: "BashShortcut",
      text: `[BashShortcut] | tool=BashShortcut | tool_input=nope | tool_response=${response}`,
    });
    const data = bashShortcutData(r);
    expect(data!.exitCode).toBe(127);
    expect(data!.stderr).toContain("not found");
  });
});
