/**
 * Context-window helpers for the dashboard's "context N%" indicator.
 *
 * The window table + resolver are the SINGLE SOURCE OF TRUTH in
 * @shared/model-windows, imported by both this file and the sandbox
 * (plugins/hooop/sandbox/lib/active-sessions.ts) so the meter's fallback
 * denominator can never drift from the window the sandbox actually hands claude.
 * This file adds only the dashboard-specific concerns: the concrete
 * (null-free) denominator and the input-token sum.
 */
import { windowForModel, DEFAULT_WINDOW } from "@shared/model-windows";

/**
 * Percentage of the context window at which auto-compaction is configured to
 * trigger (see the sandbox spawn env). Used to place the marker line and the
 * "rose" warning tone on the stats strip. The sandbox reports the effective
 * value per session in `lastStats.autoCompactPct`; this is the fallback.
 */
export const AUTO_COMPACT_PCT = 85;

// For a live session the sandbox reports the model-bound window in
// `lastStats.contextWindow`; this is the fallback the meter uses only when that
// field is absent (historical rows). It resolves by model and drops to a single
// conservative default for model-less rows — there is no second competing size.
export function contextWindowFor(model?: string | null): number {
  return windowForModel(model) ?? DEFAULT_WINDOW;
}

/**
 * Total tokens consumed by the most recent turn's INPUT side (regular +
 * cache creation + cache read). This is the figure to compare against the
 * model's context window for the "ctx %" indicator; output_tokens doesn't
 * count toward the limit.
 */
export function totalInputTokens(usage?: {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): number {
  if (!usage) return 0;
  return (usage.input_tokens ?? 0)
    + (usage.cache_creation_input_tokens ?? 0)
    + (usage.cache_read_input_tokens ?? 0);
}
