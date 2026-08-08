"use client";
import { useEffect, useState } from "react";
import { Activity, ChevronDown, ChevronRight } from "lucide-react";
import { useSSE } from "../useSSE";
import { Drawer } from "../ui/Overlay";
import { ShellEventDetail } from "./ShellEventDetail";
import { cn } from "../ui/cn";

// Events drawer (Phase 3) — the mockup's full-width bottom sheet. Header:
// activity icon + "Events" + count chip + all/tools/agents/user tabs + a
// chevron-down close. Rows are the mockup's mono line (time · cue-hook · tool ·
// text), expanding into ShellEventDetail. Same /api/events fetch + SSE + filter
// as the legacy EventsPanel.

interface EventRow {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
}
interface EventDetail extends EventRow {
  payload: unknown;
}
type Filter = "all" | "tools" | "agents" | "user";

function hookTone(h: string | null): string {
  switch (h) {
    case "PreToolUse": return "text-sdk";
    case "PostToolUse": return "text-wrap";
    case "UserPromptSubmit": return "text-direct";
    case "SessionStart": return "text-live";
    case "Stop": return "text-fail";
    default: return "text-ink-faint";
  }
}

export function ShellEventsDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, EventDetail>>({});

  useEffect(() => {
    fetch("/api/events?limit=200")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: EventRow[]) => setEvents(rows))
      .finally(() => setLoading(false));
  }, []);

  useSSE({
    event: (raw: unknown) => {
      const e = raw as EventRow;
      setEvents((prev) =>
        [{ id: e.id, ts: e.ts, session_id: e.session_id, hook_type: e.hook_type, tool_name: e.tool_name, text: e.text }, ...prev].slice(0, 1000),
      );
    },
  });

  const shown = events.filter((e) => {
    if (filter === "all") return true;
    if (filter === "tools") return e.hook_type === "PreToolUse" || e.hook_type === "PostToolUse";
    if (filter === "agents") return e.tool_name === "Task" || e.tool_name === "Agent";
    if (filter === "user") return e.hook_type === "UserPromptSubmit";
    return true;
  });

  async function toggle(e: EventRow) {
    if (expanded === e.id) {
      setExpanded(null);
      return;
    }
    setExpanded(e.id);
    if (details[e.id]) return;
    try {
      const r = await fetch(`/api/events/${e.id}`);
      if (r.ok) {
        const d: EventDetail = await r.json();
        setDetails((prev) => ({ ...prev, [e.id]: d }));
      }
    } catch {
      /* ignore */
    }
  }

  return (
    <Drawer open={open} onClose={onClose} label="Events" className="max-h-[70vh]">
      <div className="flex items-center gap-3 px-5 h-12 shrink-0 border-b border-divider">
        <Activity className="w-4 h-4 text-ink-mute" />
        <span className="font-sans text-[13px] font-semibold text-ink">Events</span>
        <span className="chip font-mono text-[10px] px-1.5 py-0.5">{events.length}</span>
        <div className="ml-4 flex gap-1">
          {(["all", "tools", "agents", "user"] as Filter[]).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn("tab tab-neutral px-2.5 py-1", filter === f && "is-on")}
            >
              {f}
            </button>
          ))}
        </div>
        <button onClick={onClose} className="icon-btn w-8 h-8 ml-auto" aria-label="Close">
          <ChevronDown className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {loading ? (
          <p className="text-xs text-ink-faint p-5">Loading…</p>
        ) : shown.length === 0 ? (
          <p className="text-xs text-ink-faint p-5">
            No events yet. Run any tool in Claude to see them stream in.
          </p>
        ) : (
          <ul className="font-mono text-[11px]">
            {shown.slice(0, 200).map((e, i) => {
              const isOpen = expanded === e.id;
              return (
                <li key={e.id} className={cn(i > 0 && "border-t border-divider")}>
                  <button
                    onClick={() => toggle(e)}
                    className="list-row w-full text-left flex items-center gap-3 py-1.5 px-4"
                  >
                    {isOpen ? (
                      <ChevronDown className="w-3 h-3 text-ink-mute shrink-0" />
                    ) : (
                      <ChevronRight className="w-3 h-3 text-ink-mute shrink-0" />
                    )}
                    <span className="text-ink-faint shrink-0 w-16 tabular-nums">{e.ts.slice(11, 19)}</span>
                    <span className={cn("shrink-0 w-28 truncate", hookTone(e.hook_type))}>
                      {e.hook_type ?? "—"}
                    </span>
                    <span className="shrink-0 w-20 truncate text-ink-soft">{e.tool_name ?? ""}</span>
                    <span className="flex-1 truncate text-ink-mute">{e.text ?? ""}</span>
                  </button>
                  {isOpen && (
                    <div className="px-4 pb-3 pl-9">
                      <ShellEventDetail detail={details[e.id]} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Drawer>
  );
}
