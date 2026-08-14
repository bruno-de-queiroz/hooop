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

/**
 * Host-device enrollment attempts, keyed by client IP.
 *
 * The enrollment endpoint is reachable from the tunnel with NO credential — it
 * has to be, since the phone redeeming a code holds nothing yet — and what it
 * guards is an 8-character code that buys host authority. Online guessing is the
 * one attack that matters, so the budget is deliberately mean: a handful of
 * tries a minute, which is generous for a human mistyping a code off a screen
 * and useless for a script. Codes are also single-use and expire in two minutes,
 * so an attacker gets one shot per value against a target that keeps moving.
 */
export const enrollAttemptLimiter: RateLimiter = createRateLimiter({
  max: 10,
  windowMs: 60_000,
});

/**
 * The same attempts again, counted install-wide with no key at all.
 *
 * Because the per-IP key is not ours: it comes from `CF-Connecting-IP`, which is
 * authoritative behind the tunnel and pure client input anywhere else. The
 * enrollment endpoint is allowlisted BEFORE the host check (it must be — the phone
 * has no credential yet), so on an install bound to 0.0.0.0 somebody on the LAN
 * can rotate that header per request and the per-IP budget stops existing.
 *
 * This one cannot be rotated. It is set far above any legitimate use — nobody
 * types sixty codes a minute — so it never touches a real person, and it puts a
 * real ceiling on guessing regardless of what the caller claims to be. The code
 * space (31^8 ≈ 8.5e11, single-use, two-minute window) was always the actual
 * defence; this is what makes the rate limit part of the argument true.
 */
export const enrollAttemptCeiling: RateLimiter = createRateLimiter({
  max: 60,
  windowMs: 60_000,
});
