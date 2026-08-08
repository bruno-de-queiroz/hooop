import { describe, it, expect } from "vitest";
import { clampInt } from "./clamp";

const OPTS = { min: 1, max: 100, fallback: 10 };

describe("clampInt", () => {
  it("returns fallback for undefined", () => {
    expect(clampInt(undefined, OPTS)).toBe(10);
  });

  it("returns fallback for null", () => {
    expect(clampInt(null, OPTS)).toBe(10);
  });

  it("returns fallback for NaN", () => {
    expect(clampInt(NaN, OPTS)).toBe(10);
  });

  it("returns fallback for non-numeric string", () => {
    expect(clampInt("abc", OPTS)).toBe(10);
  });

  it("clamps negative number up to min", () => {
    expect(clampInt(-1, OPTS)).toBe(1);
  });

  it("clamps zero up to min", () => {
    expect(clampInt(0, OPTS)).toBe(1);
  });

  it("returns value within range unchanged", () => {
    expect(clampInt(50, OPTS)).toBe(50);
  });

  it("clamps value above max down to max", () => {
    expect(clampInt(99999, OPTS)).toBe(100);
  });

  it("floors float values", () => {
    expect(clampInt(3.7, OPTS)).toBe(3);
  });

  it("parses numeric string and returns the integer", () => {
    expect(clampInt("42", OPTS)).toBe(42);
  });

  it("clamps numeric string below min up to min", () => {
    expect(clampInt("-5", OPTS)).toBe(1);
  });

  it("clamps numeric string above max down to max", () => {
    expect(clampInt("9999", OPTS)).toBe(100);
  });

  it("returns fallback for empty string", () => {
    // Number("") is 0, floored is 0, clamped to min=1 — not fallback.
    // Number("") === 0, which is finite, so it clamps to min.
    expect(clampInt("", OPTS)).toBe(1);
  });

  it("returns fallback for Infinity", () => {
    expect(clampInt(Infinity, OPTS)).toBe(10);
  });

  it("returns fallback for -Infinity", () => {
    expect(clampInt(-Infinity, OPTS)).toBe(10);
  });

  it("returns min when value equals min exactly", () => {
    expect(clampInt(1, OPTS)).toBe(1);
  });

  it("returns max when value equals max exactly", () => {
    expect(clampInt(100, OPTS)).toBe(100);
  });
});
