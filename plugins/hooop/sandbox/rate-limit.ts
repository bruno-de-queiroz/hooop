/**
 * Sliding-window rate limiter, mirror of dashboard/lib/rate-limit.ts.
 *
 * Defense-in-depth: even if the dashboard process is compromised, the sandbox
 * caps how many agent-spawn requests it accepts per token per minute. The
 * dashboard's limit is meaningless here — only this one keeps the sandbox
 * from being a runaway-agent factory.
 */

const DEFAULT_MAX = 60;          // mutating reqs/min/token at the sandbox edge
const DEFAULT_WINDOW_MS = 60_000;

export interface RateLimiter {
  check(key: string): { ok: true } | { ok: false; resetSec: number };
  reset(): void;
}

export function createRateLimiter(opts: { max?: number; windowMs?: number; now?: () => number } = {}): RateLimiter {
  const max = opts.max ?? DEFAULT_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  const buckets = new Map<string, number[]>();

  return {
    check(key) {
      const t = now();
      const cutoff = t - windowMs;
      let ring = buckets.get(key);
      if (!ring) {
        ring = [];
        buckets.set(key, ring);
      }
      while (ring.length > 0 && ring[0] <= cutoff) ring.shift();
      if (ring.length >= max) {
        const oldestExpiresAt = ring[0] + windowMs;
        const resetSec = Math.max(1, Math.ceil((oldestExpiresAt - t) / 1000));
        return { ok: false, resetSec };
      }
      ring.push(t);
      return { ok: true };
    },
    reset() {
      buckets.clear();
    },
  };
}

export const mutatingLimiter: RateLimiter = createRateLimiter();
