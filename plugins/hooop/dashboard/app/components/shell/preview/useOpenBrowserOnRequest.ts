"use client";
import { useSSE } from "@/app/components/useSSE";

/**
 * Open the Browser section whenever the agent is working in the page.
 *
 * Two triggers, and both are needed:
 *
 * `PreviewNeedsViewer` is the agent BLOCKED — it tried to use the app, nobody
 * had it open, and there is deliberately no headless fallback, so it waits for a
 * bounded window while everyone is asked. A notification that still needs a
 * click is a notification the agent waits behind, so this opens the panel
 * outright. The intrusion is the point.
 *
 * `preview-drive` is the agent ACTING. It fires for every action, including when
 * other people already have the preview open — which is exactly the case the
 * first trigger cannot cover, because with a viewer somewhere the agent is not
 * blocked and never asks. Without it, closing your panel meant missing the rest
 * of the run with no way back in short of reopening it yourself.
 *
 * The cost is that closing the panel mid-run reopens it on the next action. That
 * is the intended reading of "the agent is using the page": if you want it to
 * stop, take control — the overlay is one click and it interrupts the turn.
 */
export function useOpenBrowserOnRequest({
  selectedId,
  openRail,
  openMobile,
  isMobile = () => false,
}: {
  selectedId: string | null;
  /** Show the Browser section in the right rail, expanding it if collapsed. */
  openRail: () => void;
  /** Show it in the mobile overlay, where the rail does not exist at all. */
  openMobile: () => void;
  /** Is the mobile layout on screen? Checked at call time, not render time. */
  isMobile?: () => boolean;
}): void {
  // Only ever for the session on screen. The dock is session-scoped, so acting
  // on another session's agent would open THIS session's preview while implying
  // somebody asked for it — and leave the actual asker unanswered.
  const openFor = (sessionId: string | undefined) => {
    if (sessionId && sessionId !== selectedId) return;
    openRail();
    // ONLY on a phone. Both layouts stay mounted behind a CSS `hidden`, so
    // opening the overlay on a desktop put a second, invisible copy of the
    // preview in the page — its own iframe, its own grant, its own socket in the
    // fan-out. The person saw one preview; the agent was driving two.
    if (isMobile()) openMobile();
  };

  useSSE({
    event: (row: unknown) => {
      const e = row as { hook_type?: string; session_id?: string } | null;
      if (e?.hook_type !== "PreviewNeedsViewer") return;
      openFor(e.session_id);
    },
    "preview-drive": (row: unknown) => {
      const d = row as { sessionId?: string } | null;
      if (!d) return;
      openFor(d.sessionId);
    },
  });
}
