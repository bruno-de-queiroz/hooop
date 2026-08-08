/**
 * Per-key sliding-window rate limiter.
 *
 * Each bucket stores the timestamps of recent allowed requests in a ring
 * buffer; on every check we drop entries older than `windowMs` and admit if
 * the remaining count is below `max`. This is a true sliding window (no
 * fixed-window boundary spikes) at the cost of O(max) memory per active key.
 *
 * Used by middleware to gate mutating /api requests per cookie token. In-
 * process Map; suitable for the dashboard's single-server topology. If the
 * dashboard ever runs multi-replica, swap this for a Redis-backed limiter.
 */

const DEFAULT_MAX = 300;
const DEFAULT_WINDOW_MS = 60_000;

export interface RateLimiter {
  check(key: string): { ok: true } | { ok: false; resetSec: number };
  reset(): void;
}

export function createRateLimiter(opts: { max?: number; windowMs?: number; now?: () => number } = {}): RateLimiter {
  const max = opts.max ?? DEFAULT_MAX;
  const windowMs = opts.windowMs ?? DEFAULT_WINDOW_MS;
  const now = opts.now ?? (() => Date.now());
  // Each bucket is a ring of timestamps within the last `windowMs` ms. We
  // splice from the head (oldest) until everything we hold is fresh, then
  // check size against `max`.
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
      // Drop expired entries in place. Most calls only shed 0–1 elements.
      while (ring.length > 0 && ring[0] <= cutoff) ring.shift();
      if (ring.length >= max) {
        // resetSec is when the oldest still-counted entry will expire, i.e.
        // when one slot becomes available.
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

// Default per-token mutating-request limiter, owned by the middleware.
export const mutatingRequestLimiter: RateLimiter = createRateLimiter({
  max: DEFAULT_MAX,
  windowMs: DEFAULT_WINDOW_MS,
});
