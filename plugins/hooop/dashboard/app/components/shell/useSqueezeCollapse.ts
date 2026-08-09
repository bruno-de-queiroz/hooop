"use client";
import { useCallback, useEffect, useRef, type RefObject } from "react";

/**
 * Auto-collapses the left (sessions) rail when the chat frame gets too narrow
 * to lay out its own header.
 *
 * With the file dock and an expanded right rail both open, the center pane can
 * fall to ~200px on a 1280px window. The session header's actions are
 * `shrink-0`, so the only thing left to give is the session NAME, which
 * collapses to zero width while the id chip and avatars keep their space — the
 * header reads as a scrambled row of icons. Reclaiming the left rail's 224px is
 * enough to lay it out again.
 *
 * Three rules make this help instead of fight:
 *   - it only ever gives back what it took (a hand-collapsed rail stays shut),
 *   - a manual expand wins, and is not undone on the next resize tick,
 *   - it never writes the persisted preference: this is a response to transient
 *     layout pressure, not a choice the user made, and opening a panel once
 *     must not silently rewrite how their next session opens.
 */

/** Width the left rail hands back when it drops to the mini strip (17rem → 3rem). */
export const LEFT_RAIL_RECLAIM = 224;
/** Below this the chat header can no longer lay out. */
export const SQUEEZE_AT = 480;
/**
 * Restore only well above the reclaim, never at `SQUEEZE_AT + RECLAIM` exactly.
 * Collapsing at 479 yields 703, and restoring at 737 yields 513 — both land
 * clear of the opposite threshold, so the rail cannot oscillate when the pane
 * sits near the boundary.
 */
export const RESTORE_AT = SQUEEZE_AT + LEFT_RAIL_RECLAIM + 32;

export type SqueezeAction = "collapse" | "restore" | null;

export interface SqueezeState {
  /** Is the left rail currently collapsed? */
  collapsed: boolean;
  /** Did WE collapse it (vs. the user)? Only then may we expand it again. */
  autoCollapsed: boolean;
  /** Has the user expanded it by hand since the last comfortable width? While
   *  true we stand down, or the expand button would appear not to work. */
  userExpanded: boolean;
}

/** The whole policy, as a pure function so the hysteresis is testable without a
 *  layout engine. Returns null when the current width warrants no change. */
export function squeezeDecision(width: number, state: SqueezeState): SqueezeAction {
  // 0 means unmeasured or display:none — never act on it. The desktop tree stays
  // mounted behind a CSS `hidden` on mobile, and would otherwise report 0 and
  // collapse a rail nobody can see.
  if (width <= 0) return null;
  if (!state.collapsed) {
    if (state.userExpanded) return null;
    return width < SQUEEZE_AT ? "collapse" : null;
  }
  if (!state.autoCollapsed) return null;
  return width > RESTORE_AT ? "restore" : null;
}

export interface SqueezeCollapse {
  /** Call from the rail's own collapse/expand handler with the NEW collapsed
   *  value. Telling us directly beats inferring a manual toggle from a state
   *  change: the toggle handler is the only user-driven path, it knows the new
   *  value, and inferring would mean reading refs during render — which races
   *  the ResizeObserver callback that the expand itself triggers. */
  onUserToggle: (nextCollapsed: boolean) => void;
}

export function useSqueezeCollapse({
  paneRef,
  collapsed,
  enabled,
  onCollapse,
  onRestore,
}: {
  paneRef: RefObject<HTMLElement | null>;
  collapsed: boolean;
  /** Off for mobile and fullscreen, where the left rail isn't in the layout. */
  enabled: boolean;
  onCollapse: () => void;
  onRestore: () => void;
}): SqueezeCollapse {
  const autoCollapsed = useRef(false);
  const userExpanded = useRef(false);

  const onUserToggle = useCallback((nextCollapsed: boolean) => {
    // Either way the rail is now the user's, not ours: we may no longer expand
    // it back, and if they opened it we stand down until the pane is roomy.
    autoCollapsed.current = false;
    userExpanded.current = !nextCollapsed;
  }, []);

  // Depends on its inputs directly rather than reading them from a "latest" ref
  // during render. That needs `onCollapse`/`onRestore` to be stable (they are —
  // useCallback in DesktopShell), leaving only `collapsed` and `enabled` to
  // re-subscribe the observer, and both change on a real user action, not on
  // every frame of a rail drag.
  useEffect(() => {
    const el = paneRef.current;
    if (!el || !enabled || typeof ResizeObserver === "undefined") return;

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // Once the pane is comfortable again a past manual expand stops binding
      // us, or one expand would disable the behaviour for the whole session.
      if (width > RESTORE_AT) userExpanded.current = false;
      const action = squeezeDecision(width, {
        collapsed,
        autoCollapsed: autoCollapsed.current,
        userExpanded: userExpanded.current,
      });
      if (action === "collapse") {
        autoCollapsed.current = true;
        onCollapse();
      } else if (action === "restore") {
        autoCollapsed.current = false;
        onRestore();
      }
    });
    // observe() fires once immediately. That re-check after a collapse sees the
    // now-wider pane, which is still below RESTORE_AT by design, so re-subscribing
    // cannot bounce the rail straight back open.
    ro.observe(el);
    return () => ro.disconnect();
  }, [paneRef, collapsed, enabled, onCollapse, onRestore]);

  return { onUserToggle };
}
