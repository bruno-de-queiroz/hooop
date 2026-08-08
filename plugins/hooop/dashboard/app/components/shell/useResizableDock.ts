"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Shared resize behaviour for the docked columns between the chat frame and the
// right rail (plan review + file preview). The dock is flush against the right
// rail, so its right edge is fixed and the width is the distance from the drag
// pointer to that edge. The width persists per dock via localStorage.
//
// Crucially, the dock can never grow so wide that the chat frame collapses: the
// chat pane has `min-w-0` (so flexbox alone would happily shrink it to nothing),
// so we clamp the width here against CHAT_MIN — both while dragging and when the
// viewport changes (a previously-saved wide width must not break a small window).

const MIN = 380;
const MAX = 760;
const DEFAULT = 480;
// Smallest the chat frame may become; every column's upper bound derives from it.
const CHAT_MIN = 420;

/** Bounds, for callers whose column is not one of the docks. */
export interface ResizableBounds {
  min?: number;
  max?: number;
  defaultWidth?: number;
}

export interface ResizableDock {
  width: number;
  dragging: boolean;
  asideRef: React.RefObject<HTMLElement | null>;
  /** Attach to the drag handle only; move/end are tracked on `window`. */
  onPointerDown: (e: React.PointerEvent) => void;
}

export function useResizableDock(
  storageKey: string,
  { min = MIN, max = MAX, defaultWidth = DEFAULT }: ResizableBounds = {},
): ResizableDock {
  const [width, setWidth] = useState(defaultWidth);
  const [dragging, setDragging] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  // Latest width, read by the drag-end persist without re-subscribing listeners.
  const widthRef = useRef(width);
  useEffect(() => {
    widthRef.current = width;
  }, [width]);

  // Largest width that still leaves the chat frame ≥ CHAT_MIN.
  //
  // Stated as "what I have now, plus the slack the chat can still give up",
  // because that holds however many columns sit between the two — the docks are
  // the chat's immediate neighbour, the right rail is not, and the older
  // previous-sibling version silently computed a nonsense bound for anything
  // that was not. The chat pane is the only <main> in the shell.
  const maxWidth = useCallback((): number => {
    const aside = asideRef.current;
    const chat = document.querySelector("main");
    if (!aside || !chat) return max;
    const here = aside.getBoundingClientRect().width;
    const slack = chat.getBoundingClientRect().width - CHAT_MIN;
    return Math.max(min, Math.min(max, here + slack));
  }, [min, max]);

  // Re-read on every key change, and fall back to the default rather than
  // keeping the last one: the right rail uses a key per section, so switching
  // from a widened Files to a never-resized Browser must land on Browser's own
  // default, not inherit whatever Files happened to be.
  useEffect(() => {
    let next = defaultWidth;
    try {
      const v = Number(localStorage.getItem(storageKey));
      if (Number.isFinite(v) && v >= min && v <= max) next = v;
    } catch {
      /* no storage */
    }
    setWidth(next);
  }, [storageKey, defaultWidth, min, max]);

  // Clamp on mount (covers a saved width too wide for the current window) and on
  // every viewport resize.
  useEffect(() => {
    const reclamp = () => setWidth((w) => Math.min(w, maxWidth()));
    reclamp();
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [maxWidth]);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  // Track the drag on `window`, not the handle. The handle is a 6px strip, so
  // once the pointer moves past it the element would stop receiving events;
  // pointer capture on the handle is fragile too, because every width change
  // re-renders the panel and can drop the capture, so the release (pointerup)
  // is silently missed and the drag gets stuck. Window listeners can't miss it.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const aside = asideRef.current;
      if (!aside) return;
      const right = aside.getBoundingClientRect().right;
      setWidth(Math.max(min, Math.min(maxWidth(), right - e.clientX)));
    };
    const onUp = () => {
      setDragging(false);
      try {
        localStorage.setItem(storageKey, String(Math.round(widthRef.current)));
      } catch {
        /* no storage */
      }
    };
    // Suppress text selection / text cursor while dragging over the transcript.
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [dragging, maxWidth, min, storageKey]);

  return { width, dragging, asideRef, onPointerDown };
}
