import { describe, it, expect } from "vitest";
import { contextWindowFor, totalInputTokens, AUTO_COMPACT_PCT } from "./model-limits";

describe("contextWindowFor", () => {
  it("maps the 1M-context tier to 1,000,000", () => {
    for (const m of [
      "claude-opus-4-8",
      "claude-opus-4-8-20260528",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
      "claude-mythos-5",
    ]) {
      expect(contextWindowFor(m)).toBe(1_000_000);
    }
  });

  it("maps the 200k-context tier to 200,000", () => {
    for (const m of [
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
      "claude-haiku-4-4",
    ]) {
      expect(contextWindowFor(m)).toBe(200_000);
    }
  });

  it("resolves aliases / unversioned families to the family's latest window", () => {
    // Bare aliases expand to the latest of the family (what the CLI does):
    // opus/sonnet latest are 1M, haiku latest is 200k. A version override still
    // wins first (see the 200k tier above: opus-4-5 / sonnet-4-5).
    expect(contextWindowFor("opus")).toBe(1_000_000);
    expect(contextWindowFor("sonnet")).toBe(1_000_000);
    expect(contextWindowFor("haiku")).toBe(200_000);
    expect(contextWindowFor("claude-opus")).toBe(1_000_000);
    expect(contextWindowFor("claude-sonnet")).toBe(1_000_000);
    expect(contextWindowFor("claude-haiku")).toBe(200_000);
    expect(contextWindowFor("claude-sonnet-5")).toBe(1_000_000);
  });

  it("falls back to the single conservative default for unresolvable models", () => {
    // No model-bound size exists, so the meter uses one conservative constant
    // (never a second, larger competing default).
    expect(contextWindowFor(null)).toBe(200_000);
    expect(contextWindowFor(undefined)).toBe(200_000);
    expect(contextWindowFor("gpt-9")).toBe(200_000);
    expect(contextWindowFor("some-internal-model")).toBe(200_000);
  });
});

describe("totalInputTokens", () => {
  it("sums the input side (regular + cache create + cache read)", () => {
    expect(
      totalInputTokens({
        input_tokens: 7,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        // output is intentionally ignored by the caller's type, so not summed
      }),
    ).toBe(1107);
  });

  it("treats missing usage as zero", () => {
    expect(totalInputTokens(undefined)).toBe(0);
    expect(totalInputTokens({})).toBe(0);
  });
});

describe("AUTO_COMPACT_PCT", () => {
  it("is a sane fallback trigger percentage", () => {
    expect(AUTO_COMPACT_PCT).toBeGreaterThan(0);
    expect(AUTO_COMPACT_PCT).toBeLessThanOrEqual(100);
  });
});
