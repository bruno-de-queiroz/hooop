import { vi, describe, it, expect, beforeEach } from "vitest";
import { deriveText } from "./ingestor";

describe("deriveText", () => {
  it("returns empty string for empty event", () => {
    expect(deriveText({})).toBe("");
  });

  it("returns empty string for null/undefined event", () => {
    expect(deriveText(null)).toBe("");
    expect(deriveText(undefined)).toBe("");
  });

  it("returns just the hook when no ctx", () => {
    expect(deriveText({ hook: "Stop" })).toBe("[Stop]");
  });

  it("includes hook and tool_name in the output", () => {
    const result = deriveText({
      hook: "PostToolUse",
      ctx: { tool_name: "Bash" },
    });
    expect(result).toBe("[PostToolUse] | tool=Bash");
  });

  it("includes string values from ctx in key=value format", () => {
    const result = deriveText({
      hook: "Stop",
      ctx: { last_assistant_message: "hi" },
    });
    expect(result).toContain("last_assistant_message=hi");
  });

  it("JSON-stringifies object values", () => {
    const result = deriveText({
      hook: "Start",
      ctx: { tool_input: { command: "ls" } },
    });
    expect(result).toContain('tool_input={"command":"ls"}');
  });

  it("skips null and undefined ctx values", () => {
    const result = deriveText({
      hook: "Test",
      ctx: {
        tool_input: "value",
        tool_response: null,
        tool_result: undefined,
      },
    });
    expect(result).not.toContain("tool_response");
    expect(result).not.toContain("tool_result");
    expect(result).toContain("tool_input=value");
  });

  it("includes kind key in output", () => {
    const result = deriveText({
      hook: "Event",
      ctx: { kind: "compaction" },
    });
    expect(result).toContain("kind=compaction");
  });

  it("maintains the full documented key order", () => {
    const result = deriveText({
      hook: "Test",
      ctx: {
        kind: "X",
        last_assistant_message: "X",
        tool_input: "X",
        tool_response: "X",
        tool_result: "X",
        prompt: "X",
        message: "X",
        transcript: "X",
      },
    });
    const order = ["tool_input=", "tool_response=", "tool_result=", "prompt=", "message=", "transcript=", "last_assistant_message=", "kind="];
    const positions = order.map((key) => result.indexOf(key));
    for (let i = 0; i < positions.length; i++) {
      expect(positions[i], `${order[i]} missing`).toBeGreaterThan(-1);
      if (i > 0) expect(positions[i], `${order[i]} out of order`).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("preserves long string values without truncation", () => {
    const longString = "x".repeat(100_000);
    const result = deriveText({
      hook: "Test",
      ctx: { last_assistant_message: longString },
    });
    expect(result).toContain(`last_assistant_message=${longString}`);
  });

  it("JSON-stringifies nested object values exactly", () => {
    const result = deriveText({
      hook: "Complex",
      ctx: {
        tool_input: { nested: { deep: "value" }, array: [1, 2, 3] },
      },
    });
    expect(result).toContain('tool_input={"nested":{"deep":"value"},"array":[1,2,3]}');
  });

  it("escapes embedded quotes when stringifying object values", () => {
    const result = deriveText({
      hook: "X",
      ctx: { tool_input: { quote: 'a"b' } },
    });
    expect(result).toContain('tool_input={"quote":"a\\"b"}');
  });

  it("combines multiple keys separated by pipes", () => {
    const result = deriveText({
      hook: "Multi",
      ctx: {
        tool_name: "Bash",
        tool_input: '{"command":"ls"}',
        message: "hello",
      },
    });
    expect(result).toBe(
      '[Multi] | tool=Bash | tool_input={"command":"ls"} | message=hello'
    );
  });
});
