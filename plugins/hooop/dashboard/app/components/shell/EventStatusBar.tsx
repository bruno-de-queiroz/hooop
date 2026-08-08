"use client";
import { useEffect, useState } from "react";
import { Activity, ChevronUp } from "lucide-react";
import { useSSE } from "../useSSE";
import { cn } from "../ui/cn";

// Desktop-shell status bar (Phase 3). Matches the mockup: the whole bar is a
// button that opens the Events drawer, showing the latest event inline —
// timestamp, cue-colored hook type, tool name, a text summary — with a total
// count chip on the right. Live-updates via the same `event` SSE the panels use.

interface EventRow {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
}

/** Hook type → cue token. Mirrors DESIGN.md's state vocabulary. */
function hookTone(hook: string | null): string {
  const h = (hook ?? "").toLowerCase();
  if (h.includes("error")) return "text-fail";
  if (h.includes("permission") || h.includes("ask") || h.includes("notification")) return "text-live";
  if (h.includes("post") || h.includes("stop")) return "text-wrap";
  if (h.includes("pre") || h.includes("user")) return "text-sdk";
  return "text-ink-mute";
}

function clock(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour12: false });
}

export function EventStatusBar({ port, onOpen }: { port: string; onOpen: () => void }) {
  const [latest, setLatest] = useState<EventRow | null>(null);
  const [count, setCount] = useState(0);

  useEffect(() => {
    fetch("/api/events?limit=200")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: EventRow[]) => {
        if (Array.isArray(rows) && rows.length) {
          setLatest(rows[0]);
          setCount(rows.length);
        }
      })
      .catch(() => {});
  }, []);

  useSSE({
    event: (raw: unknown) => {
      const row = raw as EventRow | null;
      if (!row || !row.hook_type) return;
      setLatest(row);
      setCount((c) => c + 1);
    },
  });

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full h-8 shrink-0 flex items-center gap-3 px-4 bg-rail border-t border-divider text-left hover:brightness-110 transition"
      aria-label="Open events"
    >
      <Activity className="w-3.5 h-3.5 text-ink-mute shrink-0" />
      {latest ? (
        <>
          <span className="font-mono text-[11px] text-ink-hush shrink-0 tabular-nums">
            {clock(latest.ts)}
          </span>
          {latest.hook_type && (
            <span className={cn("font-mono text-[11px] shrink-0", hookTone(latest.hook_type))}>
              {latest.hook_type}
            </span>
          )}
          {latest.tool_name && (
            <span className="font-mono text-[11px] text-ink-soft shrink-0">{latest.tool_name}</span>
          )}
          {latest.text && (
            <span className="text-[11px] text-ink-faint truncate">{latest.text}</span>
          )}
        </>
      ) : (
        <span className="text-[11px] text-ink-faint">No events yet</span>
      )}
      <span className="ml-auto flex items-center gap-2 shrink-0">
        <span className="font-mono text-[11px] text-ink-hush tabular-nums">port {port}</span>
        {count > 0 && (
          <span className="rounded-[6px] bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-faint tabular-nums">
            {count} events
          </span>
        )}
        <ChevronUp className="w-3.5 h-3.5 text-ink-mute" />
      </span>
    </button>
  );
}
