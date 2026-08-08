export interface ClampOptions {
  min: number;
  max: number;
  fallback: number;
}

/**
 * Coerce a possibly-untrusted limit input to a safe integer.
 * - NaN, null, undefined, non-numeric strings → fallback.
 * - Values below min → min.
 * - Values above max → max.
 * - Float values are floored.
 * - Negative values (after coercion) → min (which should be ≥ 1 for SQL LIMIT contexts).
 */
export function clampInt(value: unknown, opts: ClampOptions): number {
  if (typeof value === "string") value = Number(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return opts.fallback;
  const floored = Math.floor(value);
  if (floored < opts.min) return opts.min;
  if (floored > opts.max) return opts.max;
  return floored;
}
