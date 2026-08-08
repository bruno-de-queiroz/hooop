import { describe, it, expect } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows requests up to max within the window", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 3, windowMs: 1000, now: () => t });
    for (let i = 0; i < 3; i++) {
      expect(limiter.check("k1").ok).toBe(true);
    }
  });

  it("rejects the next request once max is reached", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });
    limiter.check("k1");
    limiter.check("k1");
    const res = limiter.check("k1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.resetSec).toBeGreaterThan(0);
  });

  it("resets after the window elapses", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(limiter.check("k1").ok).toBe(true);
    expect(limiter.check("k1").ok).toBe(false);
    t = 1001; // past the window
    expect(limiter.check("k1").ok).toBe(true);
  });

  it("scopes per key — one key being throttled does not affect another", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    expect(limiter.check("a").ok).toBe(true);
    expect(limiter.check("a").ok).toBe(false);
    expect(limiter.check("b").ok).toBe(true);
  });

  it("returns a resetSec that reflects time remaining in the window", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 10_000, now: () => t });
    limiter.check("k1");
    t = 2000; // 2s in
    const res = limiter.check("k1");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.resetSec).toBe(8); // 10 - 2
  });

  it("reset() clears all buckets", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
    limiter.check("k1");
    expect(limiter.check("k1").ok).toBe(false);
    limiter.reset();
    expect(limiter.check("k1").ok).toBe(true);
  });

  it("true sliding window: a burst at the boundary does NOT admit 2x max", () => {
    // The classic fixed-window bug: max requests in the last ε of one window
    // plus max in the first ε of the next = 2x max in 2ε. A sliding window
    // should refuse the second burst because the first one is still counted.
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 1000, now: () => t });

    // Use up the budget at t=999.
    t = 999;
    expect(limiter.check("k1").ok).toBe(true);
    expect(limiter.check("k1").ok).toBe(true);

    // 1ms later we are in the "next" fixed-window — a fixed-window limiter
    // would happily admit two more. Sliding must say no.
    t = 1000;
    expect(limiter.check("k1").ok).toBe(false);
    t = 1001;
    expect(limiter.check("k1").ok).toBe(false);

    // After the full windowMs has elapsed since the burst, capacity returns.
    t = 2000;
    expect(limiter.check("k1").ok).toBe(true);
  });
});
