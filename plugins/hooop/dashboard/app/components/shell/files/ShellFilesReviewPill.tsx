"use client";
import { PencilLine } from "lucide-react";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import { useAffectedFiles } from "./useSessionFiles";

// Inline "quick action" for the CURRENT session's affected files (added,
// changed, or removed — see useAffectedFiles), pinned above the composer.
// Deliberately a single-row, quiet chip (pill-btn) rather than an avatar+card
// like ShellPlanReviewCard/ShellPermissions: those are blocking decisions the
// user must make; this is a low-stakes FYI, and stacking it as an
// equally-weighted card competed for attention with an actual pending
// permission/plan card right below it. "Review" opens the files dock already
// focused on the first affected file (tree traversal order) and expands the
// right rail if it's collapsed to the mini strip.
// openFile() alone is enough on every viewport: ShellFilesDock (see its
// `max-lg:fixed max-lg:inset-0 max-lg:!w-full` classes) already turns itself
// into a full-screen overlay below `lg`, no separate mobileView wiring
// needed. Do NOT also call openMobile("files") here — that's the Details/
// Files TREE-browsing overlay (opened from the session-header ⋯ menu), a
// distinct, lower z-index (70 vs the file dock's 80) surface meant for the
// browse-then-open flow, where closing the dock intentionally reveals the
// list you drilled down from. This pill has no such list the user navigated
// from; forcing mobileView open behind the dock would leave it dangling and
// pop an unrequested full-screen file browser the moment the user closes the
// preview.

export function ShellFilesReviewPill() {
  const { selectedId } = useSelectedSession();
  const { setView, setRailCollapsed, openFile } = useFilesUI();
  const { count, first } = useAffectedFiles();

  if (!selectedId || count === 0 || !first) return null;

  const handleReview = () => {
    setView("files");
    setRailCollapsed(false);
    openFile({ sessionId: selectedId, path: first.path, name: first.name });
  };

  return (
    <div className="px-5 pb-2 shrink-0 flex justify-center">
      <div className="pill-btn inline-flex items-center gap-2 py-1.5 pl-3 pr-1.5 max-w-full">
        <PencilLine className="w-3.5 h-3.5 shrink-0" style={{ color: "rgb(var(--live))" }} />
        <span className="text-[11px] text-ink-soft truncate">
          {count} <span className="hidden sm:inline">files affected</span>
        </span>
        <button
          type="button"
          onClick={handleReview}
          className="ml-1 shrink-0 rounded-md px-2 py-1 text-[11px] font-semibold bg-accent/15 text-accent hover:bg-accent/25"
        >
          Review
        </button>
      </div>
    </div>
  );
}
