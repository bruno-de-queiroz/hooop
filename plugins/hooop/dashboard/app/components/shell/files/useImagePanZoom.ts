"use client";
import { useCallback, useEffect, useRef, useState } from "react";

// Zoom + pan for the file preview's image view.
//
// The drag half deliberately copies useResizableDock's idiom: move/up are
// tracked on `window`, never on the element. That hook documents why, and it
// applies here with more force — panning re-renders on every pointer move, and a
// re-render can drop element pointer capture, so the pointerup is silently
// missed and the gesture wedges "stuck to the cursor". Window listeners cannot
// miss the release. Same reason `body.style.userSelect`/`cursor` are saved and
// restored rather than toggled with a class.

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const STEP = 1.4;

export interface ImagePanZoom {
  scale: number;
  /** Translation in CSS px, applied after the scale. */
  offset: { x: number; y: number };
  panning: boolean;
  /** True at the resting state — nothing to reset. */
  isFit: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  /** Back to fit (scale 1, centred). */
  reset: () => void;
  onWheel: (e: React.WheelEvent) => void;
  onPointerDown: (e: React.PointerEvent) => void;
  /** Attach to the element the gesture is measured against (the viewport box). */
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

function clampScale(s: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));
}

/**
 * `resetKey` changes → back to fit. Pass the file path so opening another image
 * never inherits the previous one's zoom.
 */
export function useImagePanZoom(resetKey: string): ImagePanZoom {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Where the pointer went down, plus the offset at that moment: the delta is
  // measured from the gesture's origin rather than accumulated per event, so a
  // dropped/coalesced move can't make the image drift away from the cursor.
  const dragOrigin = useRef({ x: 0, y: 0, offX: 0, offY: 0 });

  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, [resetKey]);

  // At scale 1 the image is fit to the box, so panning it would only reveal
  // empty space. Above that, allow travel over the overflow the zoom created,
  // which keeps some of the image on screen at every zoom level.
  const clampOffset = useCallback((next: { x: number; y: number }, s: number) => {
    const box = viewportRef.current?.getBoundingClientRect();
    if (!box) return next;
    const maxX = Math.max(0, (box.width * (s - 1)) / 2);
    const maxY = Math.max(0, (box.height * (s - 1)) / 2);
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);

  const applyScale = useCallback(
    (next: number) => {
      const s = clampScale(next);
      setScale(s);
      // Re-clamp on the way out: zooming back down must pull the image back into
      // frame instead of leaving it parked off-centre.
      setOffset((o) => clampOffset(o, s));
      return s;
    },
    [clampOffset],
  );

  const zoomIn = useCallback(() => applyScale(scale * STEP), [applyScale, scale]);
  const zoomOut = useCallback(() => applyScale(scale / STEP), [applyScale, scale]);
  const reset = useCallback(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  }, []);

  // Wheel zoom anchored at the cursor: the point under the pointer stays put, so
  // zooming into a detail doesn't send it off-screen. Ctrl+wheel (pinch on a
  // trackpad) and a plain wheel both zoom — the pane has no other scroll axis
  // once an image is showing, so there's nothing to steal.
  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const box = viewportRef.current?.getBoundingClientRect();
      const factor = Math.exp(-e.deltaY / 300);
      const nextScale = clampScale(scale * factor);
      if (nextScale === scale) return;
      if (box) {
        // Cursor position relative to the box centre, which is the transform
        // origin; the offset has to grow with the scale about that point.
        const cx = e.clientX - (box.left + box.width / 2);
        const cy = e.clientY - (box.top + box.height / 2);
        const ratio = nextScale / scale;
        setOffset((o) => clampOffset({ x: cx - (cx - o.x) * ratio, y: cy - (cy - o.y) * ratio }, nextScale));
      }
      setScale(nextScale);
    },
    [clampOffset, scale],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      // Nothing to pan at rest; let the click through so it can't feel dead.
      if (scale <= MIN_SCALE) return;
      e.preventDefault();
      dragOrigin.current = { x: e.clientX, y: e.clientY, offX: offset.x, offY: offset.y };
      setPanning(true);
    },
    [offset.x, offset.y, scale],
  );

  useEffect(() => {
    if (!panning) return;
    const onMove = (e: PointerEvent) => {
      const o = dragOrigin.current;
      setOffset(clampOffset({ x: o.offX + (e.clientX - o.x), y: o.offY + (e.clientY - o.y) }, scale));
    };
    const onUp = () => setPanning(false);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "grabbing";
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
  }, [panning, clampOffset, scale]);

  return {
    scale,
    offset,
    panning,
    isFit: scale === 1 && offset.x === 0 && offset.y === 0,
    zoomIn,
    zoomOut,
    reset,
    onWheel,
    onPointerDown,
    viewportRef,
  };
}
