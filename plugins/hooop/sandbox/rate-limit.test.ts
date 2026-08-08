import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("sandbox createRateLimiter (sliding window)", () => {
  it("allows requests up to max within the window", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) expect(limiter.check("k1").ok).toBe(true);
  });

  it("rejects once max is reached", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    limiter.check("k1");
    limiter.check("k1");
    const res = limiter.check("k1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.resetSec).toBeGreaterThan(0);
  });

  it("recovers capacity as old entries fall out of the window", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    limiter.check("k1");
    t = 500;
    limiter.check("k1");
    t = 1001; // first entry expired
    expect(limiter.check("k1").ok).toBe(true);
  });

  it("scopes per key", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("a").ok).toBe(false);
    expect(limiter.check("b").ok).toBe(true);
  });

  it("burst-on-boundary does not admit 2x max", () => {
    let t = 999;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    expect(limiter.check("k1").ok).toBe(true);
    expect(limiter.check("k1").ok).toBe(true);
    t = 1000;
    expect(limiter.check("k1").ok).toBe(false);
    t = 1001;
    expect(limiter.check("k1").ok).toBe(false);
  });
});
