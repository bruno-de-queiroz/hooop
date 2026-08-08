/**
 * SINGLE SOURCE OF TRUTH for Claude context-window sizes.
 *
 * Both packages consume this via the `@shared/*` path alias (see each
 * tsconfig.json + the sandbox esbuild/vitest configs), so the window table lives
 * in exactly one place:
 *   - sandbox  (plugins/hooop/sandbox/lib/active-sessions.ts) sizes the
 *     CLAUDE_CODE_AUTO_COMPACT_WINDOW it hands the claude subprocess at spawn.
 *   - dashboard (plugins/hooop/dashboard/lib/model-limits.ts) uses it as the
 *     fallback denominator for the "context %" meter.
 * A wrong or drifted window is actively harmful in BOTH directions: too small
 * pins the meter at a fake 100% and compacts absurdly early; too large tells
 * claude to auto-compact PAST the model's real ceiling, so it never compacts and
 * dies with "Prompt is too long". Keeping one table removes the drift hazard the
 * two hand-synced copies used to carry.
 *
 * These are the REAL published windows (Claude docs, 2026-07): the 1M tier
 * (Opus 4.6+, Sonnet 5 / 4.6, Fable 5, Mythos 5) vs the 200k tier (Sonnet 4.5,
 * Opus 4.5, Haiku, older models).
 */
export const CTX_1M = 1_000_000;
export const CTX_200K = 200_000;

// Only the EXCEPTIONS to the family default (see windowForModel): opus 4.5 and
// sonnet 4.5 predate the 1M rollout and stay at 200k even though their family is
// otherwise 1M. Fully-qualified / date-stamped ids match by prefix.
export const MODEL_WINDOW_OVERRIDES: ReadonlyArray<readonly [string, number]> = [
  ["claude-opus-4-5", CTX_200K],
  ["claude-sonnet-4-5", CTX_200K],
];

/**
 * Conservative fallback for a row with no resolvable model (a legacy session
 * whose lastStats never captured a model, or a genuinely unknown id). Under-
 * reporting fill is safer than over-reporting — a too-small window compacts
 * early; a too-large one blows past the real ceiling — so default small.
 */
export const DEFAULT_WINDOW = CTX_200K;

/**
 * Context window as a PURE function of the resolved model, or `null` when it
 * can't be resolved. Callers that need a concrete number substitute
 * DEFAULT_WINDOW (dashboard meter) or a spawn floor (sandbox auto-compact env) —
 * but never a guessed per-family size.
 *
 * Bare aliases ("opus") and unversioned family names resolve to the LATEST of
 * that family — the same expansion the CLI applies to an alias.
 */
export function windowForModel(model?: string | null): number | null {
  if (!model) return null;
  const lower = model.toLowerCase();
  for (const [prefix, size] of MODEL_WINDOW_OVERRIDES) {
    if (lower.startsWith(prefix)) return size;
  }
  const family = lower.match(/^(?:claude-)?(opus|sonnet|haiku|fable|mythos)\b/)?.[1];
  if (family === "haiku") return CTX_200K;
  if (family) return CTX_1M;
  return null;
}
