"use client";
import { ClipboardList } from "lucide-react";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { usePlanReview } from "./ShellChrome";
import { canDecidePlans, useMounted } from "../lib/participant";

// Inline "quick action" for a pending plan review in the CURRENT session —
// mirrors the permission card (ShellPermissions): a ClipboardList avatar + a
// live-tinted panel pinned above the composer, so a plan waiting on the viewer
// is never scrolled off. The plan also opens as a slide-over on first arrival;
// this card is the persistent re-entry point (and survives dismissing it).
// Shown to everyone — host/full-peers can decide, others open it to read/comment.

// color-mix against the live cue has no Tailwind utility, so the tinted chrome
// is inline (mirrors ShellPermissions). --divider is already rgba.
const liveAvatar = {
  background: "color-mix(in oklab, rgb(var(--live)) 18%, rgb(var(--elevated)))",
  color: "rgb(var(--live))",
};
const livePanel = {
  background: "rgb(var(--elevated))",
  border: "1px solid color-mix(in oklab, rgb(var(--live)) 45%, var(--divider))",
};
const liveHead = { background: "color-mix(in oklab, rgb(var(--live)) 12%, transparent)" };

export function ShellPlanReviewCard() {
  const { selectedId } = useSelectedSession();
  const { plans, open } = usePlanReview();
  // Mount-gated: the server always reads as host, so defer the peer-only copy
  // until after hydration to avoid a mismatch.
  const mounted = useMounted();
  const canDecide = !mounted || canDecidePlans();

  const plan = plans.find((p) => p.sessionId === selectedId);
  if (!plan) return null;

  return (
    <div className="px-5 pt-1 pb-2 shrink-0">
      <div className="flex items-start gap-2.5">
        <span className="avatar w-7 h-7 shrink-0 mt-0.5" style={liveAvatar}>
          <ClipboardList className="w-3.5 h-3.5" />
        </span>
        <div className="min-w-0 flex-1 max-w-[40rem] rounded-2xl overflow-hidden" style={livePanel}>
          <div className="px-3.5 py-2.5 flex items-center gap-2" style={liveHead}>
            <span className="text-[12px] font-semibold text-ink">Plan ready to review</span>
            <span className="ml-auto chip text-[9px] px-1.5 py-0.5 uppercase tracking-wide text-live">plan</span>
          </div>
          <div className="px-3.5 py-3 flex items-center gap-3">
            <p className="min-w-0 flex-1 text-[12.5px] text-ink-soft">
              {canDecide
                ? "Claude finished a plan and is waiting for your review."
                : "Claude submitted a plan — the host approves or rejects it."}
              {plan.title && <span className="text-ink-faint"> · {plan.title}</span>}
            </p>
            <button
              type="button"
              onClick={() => open(plan.requestId)}
              className="accent-btn shrink-0 text-[11px] px-3 py-1.5"
            >
              Review plan
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
