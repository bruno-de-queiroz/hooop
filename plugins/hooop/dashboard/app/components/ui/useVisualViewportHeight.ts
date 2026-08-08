"use client";
import { useEffect } from "react";

// Below this gap (px) we treat the layout viewport as already keyboard-aware and
// leave sizing to CSS `100dvh`. A real on-screen keyboard is far taller than this;
// the threshold just absorbs sub-pixel / toolbar jitter.
const KEYBOARD_GAP_THRESHOLD = 60;

/**
 * iOS-only fallback for keeping the composer above the on-screen keyboard.
 *
 * On Chromium, `interactiveWidget: "resizes-content"` (see app/layout.tsx) shrinks
 * the *layout* viewport when the keyboard opens, so `100dvh` already fits above it
 * and this hook stays inert. iOS Safari ignores that directive: the layout
 * viewport (and `dvh`) stay full-height and only `window.visualViewport` shrinks,
 * so a `100dvh` shell keeps its full height and the bottom-anchored composer ends
 * up behind the keyboard.
 *
 * We detect that case by the gap between `innerHeight` (layout viewport) and
 * `visualViewport.height` (visible area). Only when the gap is real (keyboard
 * present) do we:
 *   - mirror `visualViewport.height` into `--app-height` (read by AppShell as
 *     `height: var(--app-height, 100dvh)`), and
 *   - cap `html`/`body` height to the same value so the body can't show its
 *     background in the space the shorter shell no longer covers (the "black gap").
 * Otherwise we clear `--app-height` so the CSS `100dvh` fallback stands — which is
 * the normal path on Chromium, where the gap is ~0.
 *
 * Body scroll is locked while mounted so iOS can't scroll the (still full-height)
 * layout viewport and tuck the composer back under the keyboard.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const prevBodyOverflow = body.style.overflow;
    const prevBodyOverscroll = body.style.overscrollBehavior;
    const prevBodyHeight = body.style.height;
    const prevRootHeight = root.style.height;
    body.style.overflow = "hidden";
    body.style.overscrollBehavior = "none";

    const vv = window.visualViewport;

    const apply = () => {
      const gap = vv ? window.innerHeight - vv.height : 0;
      if (vv && gap > KEYBOARD_GAP_THRESHOLD) {
        // Keyboard open on a browser that didn't resize the layout viewport
        // (iOS Safari): pin the shell to the visible area and cap the document
        // so no background shows below it.
        const h = `${Math.round(vv.height)}px`;
        root.style.setProperty("--app-height", h);
        root.style.height = h;
        body.style.height = h;
      } else {
        // No keyboard, or the layout viewport already shrank (Chromium with
        // resizes-content): let CSS `100dvh` drive height.
        root.style.removeProperty("--app-height");
        root.style.height = prevRootHeight;
        body.style.height = prevBodyHeight;
      }
    };
    apply();

    vv?.addEventListener("resize", apply);
    vv?.addEventListener("scroll", apply);
    window.addEventListener("resize", apply);

    return () => {
      vv?.removeEventListener("resize", apply);
      vv?.removeEventListener("scroll", apply);
      window.removeEventListener("resize", apply);
      root.style.removeProperty("--app-height");
      root.style.height = prevRootHeight;
      body.style.height = prevBodyHeight;
      body.style.overflow = prevBodyOverflow;
      body.style.overscrollBehavior = prevBodyOverscroll;
    };
  }, []);
}
