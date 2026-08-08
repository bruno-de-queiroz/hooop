"use client";
import { useMemo } from "react";
import type { EventRow } from "@/lib/sandbox-client";
import type { SessionInfo } from "@/lib/types/session";
import { contextWindowFor, totalInputTokens, AUTO_COMPACT_PCT } from "@/lib/model-limits";

export interface SessionStats {
  /** ms between first and last event in the transcript; live-ticking while alive. */
  timeMs: number;
  /** Cumulative input tokens summed across all turns. */
  inputTokens: number;
  /** Cumulative output tokens summed across all turns. */
  outputTokens: number;
  /** Cumulative cache-read tokens. */
  cacheReadTokens: number;
  /** Cumulative cache-creation tokens. */
  cacheCreationTokens: number;
  /** Total turns that completed. */
  turns: number;
  /** Most recent turn's input tokens (input + cache_read + cache_create). */
  lastTurnInputTokens: number;
  /** Most recent turn's output tokens. */
  lastTurnOutputTokens: number;
  /** First event timestamp (ms epoch), or 0 if unknown. A presentational
   * component can tick locally from this while `isAlive` to show live elapsed
   * time WITHOUT this hook returning a new object every second. */
  startedAtMs: number;
  /** Whether the session is currently alive (for the local live-time tick). */
  isAlive: boolean;
  /**
   * Context-fill figures derived from `lastStats.usage` (per-turn, not
   * cumulative). Matches Claude Code's TUI formula: input + cache_create +
   * cache_read against the model's hardcoded context window. See
   * lib/model-limits.ts for why the denominator is what it is.
   */
  contextUsed: number;
  contextLimit: number;
  contextPct: number;
  /** Percentage of the window at which auto-compaction is configured to fire.
   * Drives the marker line and warning tone on the stats strip. Reported by
   * the sandbox per session; falls back to AUTO_COMPACT_PCT. */
  autoCompactPct: number;
}

const EMPTY_STATS: SessionStats = Object.freeze({
  timeMs: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  turns: 0,
  lastTurnInputTokens: 0,
  lastTurnOutputTokens: 0,
  contextUsed: 0,
  contextLimit: 0,
  contextPct: 0,
  autoCompactPct: AUTO_COMPACT_PCT,
  startedAtMs: 0,
  isAlive: false,
});

/**
 * Derives the stats strip values for the active session.
 *
 * Tokens come from `session.lastStats.totals`, populated sandbox-side at
 * end-of-turn from claude's stream-json `result` frame. We do NOT walk
 * event payloads on the client — `/api/events` returns the lean `EventRow`
 * shape which has no payload column, so anything based on per-event
 * usage extraction would render zeros.
 *
 * `timeMs` is wall-clock at the last event: max(ts) - min(ts). It is NOT
 * live-ticked here — doing so would return a new stats object every second,
 * churning the ActiveSession context value and re-rendering every consumer
 * (and re-parsing the whole transcript) once per second. Instead we expose
 * `startedAtMs` + `isAlive` so the small presentational strip that shows the
 * clock can tick locally, keeping this hook's result identity-stable between
 * real stat changes.
 */
export function useSessionStats(
  events: EventRow[],
  session: SessionInfo | null,
): SessionStats {
  const isAlive = session?.lifecycle === "alive";
  return useMemo<SessionStats>(() => {
    let firstTs = Infinity;
    let lastTs = -Infinity;
    for (const e of events) {
      const t = Date.parse(e.ts);
      if (Number.isFinite(t)) {
        if (t < firstTs) firstTs = t;
        if (t > lastTs) lastTs = t;
      }
    }
    const totals = session?.lastStats?.totals;
    const usage = session?.lastStats?.usage;
    const model = session?.lastStats?.model ?? null;
    const contextUsed = totalInputTokens(usage);
    // Prefer the window claude ACTUALLY enforces this incarnation
    // (autoCompactWindow = the frozen CLAUDE_CODE_AUTO_COMPACT_WINDOW). That's
    // what determines when compaction fires, so measuring against it keeps the
    // bar and the auto-compact marker consistent even when the model was unknown
    // at spawn (env floored to 200k) but the init frame later rebound
    // contextWindow to a larger model window. Fall back to contextWindow, then
    // the model table, for historical rows that predate autoCompactWindow.
    const contextLimit =
      session?.lastStats?.autoCompactWindow ??
      session?.lastStats?.contextWindow ??
      contextWindowFor(model);
    const contextPct =
      contextLimit > 0 && contextUsed > 0
        ? Math.min(100, Math.round((contextUsed / contextLimit) * 100))
        : 0;
    const autoCompactPct = session?.lastStats?.autoCompactPct ?? AUTO_COMPACT_PCT;
    const startedAtMs = Number.isFinite(firstTs) ? firstTs : 0;
    const timeMs =
      Number.isFinite(firstTs) && Number.isFinite(lastTs) && lastTs >= firstTs
        ? lastTs - firstTs
        : 0;
    return {
      timeMs,
      inputTokens: totals?.input_tokens ?? 0,
      outputTokens: totals?.output_tokens ?? 0,
      cacheReadTokens: totals?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: totals?.cache_creation_input_tokens ?? 0,
      turns: totals?.turns ?? 0,
      lastTurnInputTokens: contextUsed,
      lastTurnOutputTokens: usage?.output_tokens ?? 0,
      contextUsed,
      contextLimit,
      contextPct,
      autoCompactPct,
      startedAtMs,
      isAlive,
    };
  }, [events, session?.lastStats?.totals, session?.lastStats?.usage, session?.lastStats?.model, session?.lastStats?.contextWindow, session?.lastStats?.autoCompactWindow, session?.lastStats?.autoCompactPct, isAlive]);
}

// Re-exporting EMPTY_STATS lets the active-session provider hand
// consumers a sane shape when no session is selected, without having
// to construct a literal.
export { EMPTY_STATS };
