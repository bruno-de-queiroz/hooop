import { describe, it, expect } from "vitest";
import {
  windowForModel,
  CTX_1M,
  CTX_200K,
  DEFAULT_WINDOW,
  MODEL_WINDOW_OVERRIDES,
} from "./model-windows";

describe("windowForModel (single source of truth)", () => {
  it("sizes the 1M tier for opus/sonnet/fable/mythos (versioned + bare)", () => {
    for (const m of [
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
      "claude-fable-5",
      "claude-mythos-5",
      "opus",
      "sonnet",
      "claude-opus",
    ]) {
      expect(windowForModel(m)).toBe(CTX_1M);
    }
  });

  it("sizes the 200k tier for haiku and the pre-1M overrides", () => {
    for (const m of [
      "claude-haiku-4-5",
      "haiku",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929",
    ]) {
      expect(windowForModel(m)).toBe(CTX_200K);
    }
  });

  it("returns null for an unresolvable model (caller must not guess)", () => {
    expect(windowForModel(null)).toBeNull();
    expect(windowForModel(undefined)).toBeNull();
    expect(windowForModel("")).toBeNull();
    expect(windowForModel("gpt-4o")).toBeNull();
    expect(windowForModel("some-internal-model")).toBeNull();
  });

  it("exposes the shared constants the callers build on", () => {
    expect(CTX_1M).toBe(1_000_000);
    expect(CTX_200K).toBe(200_000);
    expect(DEFAULT_WINDOW).toBe(CTX_200K);
    expect(MODEL_WINDOW_OVERRIDES.length).toBeGreaterThan(0);
  });
});
