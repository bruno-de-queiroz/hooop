"use client";
import { useEffect, useState } from "react";
import PlanPanel from "../PlanPanel";
import { cn } from "../ui/cn";
import { usePlanReviewPanel } from "./ShellChrome";
import { useResizableDock } from "./useResizableDock";

// Docked plan-review column. The panel used to be a fixed full-viewport overlay;
// it now sits as a real sibling of the chat frame — between the center pane and
// the right rail — so opening it pushes the chat frame narrower instead of
// covering it. The user can drag its left edge to resize; the width persists.
//
// Below `lg` the shell already makes the chat full-screen (both rails hidden),
// so here the dock falls back to a full-viewport overlay rather than trying to
// be a fourth column on a phone.

export function ShellPlanDock() {
  const panel = usePlanReviewPanel();
  const { width, dragging, asideRef, onPointerDown } = useResizableDock("hooop-plan-dock-width");
  // Enter animation: mount at width 0, then grow to `width` on the next frame so
  // the CSS width transition plays (a push-open, matching the right rail).
  const [entered, setEntered] = useState(false);

  const open = panel != null;
  useEffect(() => {
    if (!open) {
      setEntered(false);
      return;
    }
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, [open]);

  if (!panel) return null;

  return (
    <aside
      ref={asideRef}
      // Desktop: fixed-width, resizable column that pushes the chat frame. The
      // width is an inline style; on mobile `max-lg:!w-full` (an !important
      // utility) overrides it so the fixed overlay fills the viewport.
      style={{ width: entered ? width : 0 }}
      className={cn(
        "relative shrink-0 flex flex-col min-h-0 overflow-hidden bg-window",
        "border-divider lg:border-l",
        // Full-screen on phones — the rails are already hidden below lg.
        "max-lg:fixed max-lg:inset-0 max-lg:z-[60] max-lg:!w-full",
        // Animate the width open/resize, but not while actively dragging.
        !dragging && "motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-smooth",
      )}
    >
      {/* Resize handle on the LEFT edge (between chat frame and panel). Hidden on
        * phones where the panel is a full-screen overlay. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize plan panel"
        onPointerDown={onPointerDown}
        className="group absolute inset-y-0 left-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize max-lg:hidden"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors",
            "group-hover:bg-accent",
            dragging && "bg-accent",
          )}
        />
      </div>

      <PlanPanel key={panel.requestId} {...panel} />
    </aside>
  );
}
