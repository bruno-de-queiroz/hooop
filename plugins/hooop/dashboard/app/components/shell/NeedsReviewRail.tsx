"use client";
import { ClipboardCheck, ClipboardList } from "lucide-react";
import { SectionTitle } from "@/app/components/ui";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { usePlanReview } from "./ShellChrome";

// Left-rail "Needs review" section (mockup): pending plans across all sessions,
// each opening the shared PlanPanel slide-over. This is where a new plan
// surfaces — not as an inline card in the center pane.

const liveAvatar = {
  background: "color-mix(in oklab, rgb(var(--live)) 20%, rgb(var(--elevated)))",
  color: "rgb(var(--live))",
};

export function NeedsReviewRail({ collapsed = false }: { collapsed?: boolean }) {
  const { plans, open } = usePlanReview();
  const { selectedId } = useSelectedSession();

  if (plans.length === 0) return null;

  // Collapsed rail: just the plan avatars, stacked, each opening its review.
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 w-full">
        {plans.map((p) => (
          <button
            key={p.requestId}
            type="button"
            onClick={() => open(p.requestId)}
            title={`Review plan · ${p.title} · ${p.label}`}
            aria-label={`Review plan · ${p.label}`}
            className="avatar w-8 h-8 shrink-0 ring-1"
            style={{
              ...liveAvatar,
              // Selected session's plan gets a ring to echo the expanded row's tint.
              ...(p.sessionId === selectedId
                ? { outline: "2px solid color-mix(in oklab, rgb(var(--live)) 55%, transparent)" }
                : {}),
            }}
          >
            <ClipboardList className="w-3.5 h-3.5" />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="px-2 pb-2 shrink-0">
      <div className="flex items-center gap-2 px-2 pt-2 pb-1.5">
        <ClipboardCheck className="w-3.5 h-3.5 text-live" />
        <SectionTitle className="flex-1">Needs review</SectionTitle>
        <span className="chip font-mono text-[10px] px-1.5 py-0.5 text-live">{plans.length}</span>
      </div>
      {plans.map((p) => (
        <button
          key={p.requestId}
          type="button"
          onClick={() => open(p.requestId)}
          className="list-row w-full text-left flex items-center gap-2.5 px-2 py-2 mb-0.5"
          style={
            p.sessionId === selectedId
              ? { background: "color-mix(in oklab, rgb(var(--live)) 9%, transparent)" }
              : undefined
          }
          title={`Review plan · ${p.label}`}
        >
          <span className="avatar w-8 h-8 shrink-0" style={liveAvatar}>
            <ClipboardList className="w-3.5 h-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-semibold text-ink">{p.title}</span>
            <span className="block truncate text-[11px] text-ink-faint">{p.label}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
