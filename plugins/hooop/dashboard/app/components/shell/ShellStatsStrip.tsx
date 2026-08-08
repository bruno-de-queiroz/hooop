"use client";
import type { SessionStats } from "@/app/context/hooks/useSessionStats";
import { formatTokens, formatDuration, prettyModel } from "../lib/format";
import { cn } from "../ui/cn";

// Center-pane stats sub-bar: `model X · time Y` with a right-aligned ctx
// figure + fill bar. The bar turns amber as it approaches the auto-compact
// line and rose once past it; that line sits at the session's configured
// auto-compact trigger (`autoCompactPct`, reported by the sandbox) rather than
// a hardcoded value, so it marks where compaction actually fires.
//
// ctx is the CURRENT prompt vs the model's window, counting input + prompt-
// cache reads/writes (output never counts). Prompt caching serves almost the
// whole prompt (system prompt, tools, transcript) as a cache hit, so the window
// reads tens-of-k full even when fresh input is tiny — hence ctx prints the
// absolute `used / limit` next to the percentage to make it legible. The raw
// token counters (uncached-in / out / turns) were removed: they told a
// contradictory story next to this meter and added noise.

function ctxTone(pct: number, compactPct: number): { text: string; bar: string } {
  if (pct >= compactPct) return { text: "text-fail", bar: "bg-fail" };
  // Amber in the run-up to compaction (within ~15 points below the line).
  if (pct >= compactPct - 15) return { text: "text-live", bar: "bg-live" };
  return { text: "text-ink-soft", bar: "bg-ink-mute" };
}

export function ShellStatsStrip({
  stats,
  model,
}: {
  stats: SessionStats;
  model: string | null;
}) {
  const tone = ctxTone(stats.contextPct, stats.autoCompactPct);
  const sep = <span className="text-ink-hush">·</span>;
  return (
    <div className="px-3 sm:px-5 py-2 shrink-0 flex items-center gap-x-3 gap-y-1 flex-wrap border-b border-divider font-mono text-[11px] text-ink-faint tabular-nums">
      <span>
        model <span className="text-ink-soft">{prettyModel(model) ?? "—"}</span>
      </span>
      {/* time is secondary — hidden on phones (with its leading separator) so
        * the strip reads cleanly as `model … ctx`. */}
      <span className="hidden sm:inline-flex items-center gap-x-3">
        {sep}
        <span>
          time <span className="text-ink-soft">{formatDuration(stats.timeMs)}</span>
        </span>
      </span>
      <span
        className="ml-auto flex items-center gap-2"
        title="Current prompt size vs the model's context window — counts input + prompt-cache; output never counts. The tick marks where auto-compaction fires."
      >
        <span>
          context <span className={tone.text}>{stats.contextLimit > 0 ? `${stats.contextPct}%` : "—"}</span>
        </span>
        <span className="relative h-1.5 w-20 sm:w-28 rounded-full overflow-hidden bg-sunken">
          <span
            className={cn(
              "absolute inset-y-0 left-0 motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-smooth",
              tone.bar,
            )}
            style={{ width: `${Math.min(100, stats.contextPct)}%` }}
          />
          {/* auto-compact line at the session's configured trigger */}
          <span
            className="absolute inset-y-0 w-px bg-ink-hush"
            style={{ left: `${stats.autoCompactPct}%` }}
          />
        </span>
        {/* Concrete used / limit AFTER the bar; hidden on phones to keep the
          * mobile strip to `model … ctx N%`. */}
        {stats.contextLimit > 0 && (
          <span className="hidden sm:inline text-ink-soft">
            {formatTokens(stats.contextUsed)} / {formatTokens(stats.contextLimit)}
          </span>
        )}
      </span>
    </div>
  );
}
