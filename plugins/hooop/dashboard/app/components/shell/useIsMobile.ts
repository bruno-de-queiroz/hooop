"use client";
import { useEffect, useState } from "react";

/**
 * Is the mobile layout the one on screen?
 *
 * The shell hides the right rail with `max-lg:hidden` and the mobile overlay
 * with `lg:hidden`, which is fine for text: the hidden one costs a few DOM
 * nodes. It is NOT fine for the preview, because a mounted-but-hidden
 * `ShellPreviewPanel` is a second iframe — it redeems its own grant, loads the
 * app again, and registers as another page for the agent to drive. Two of them
 * in one browser is invisible to the person and very visible to the fan-out.
 *
 * So the preview's mount has to follow the breakpoint in JS, not just in CSS.
 * Matches Tailwind's `lg` (1024px).
 */
const MOBILE_QUERY = "(max-width: 1023.98px)";

export function useIsMobile(): boolean {
  // Starts false and corrects after mount: `window` does not exist during SSR,
  // and guessing would flash the wrong layout.
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const sync = () => setIsMobile(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);
  return isMobile;
}

/** The same question, for code that cannot hold state (event handlers). */
export function isMobileNow(): boolean {
  return typeof window !== "undefined" && window.matchMedia(MOBILE_QUERY).matches;
}
