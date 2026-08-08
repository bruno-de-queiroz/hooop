"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// One overlay implementation, three presentations. Every overlay shares the
// same behavior contract: a dimming backdrop, click-out to close, Esc to close,
// a focus trap that keeps Tab within the panel, focus restore on unmount, body
// scroll lock, and `prefers-reduced-motion` honoring (transitions are opacity/
// transform only and the utilities carry `motion-safe:`). Modal = centered,
// SlideOver = right edge, Drawer = bottom edge.

const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

export const overlayPanel = tv({
  base: "relative bg-window text-ink-soft flex flex-col will-change-transform",
  variants: {
    placement: {
      center: "rounded-window shadow-overlay max-h-[85vh] w-full",
      right: "shadow-slideover h-full w-full ml-auto",
      bottom: "rounded-t-[18px] shadow-drawer w-full mt-auto max-h-[85vh]",
    },
  },
  defaultVariants: { placement: "center" },
});

// Enter/exit animation utilities per placement. Applied dynamically so the
// overlay can play an exit animation before it unmounts (see the `closing`
// state below) — `motion-safe:` keeps both gated on prefers-reduced-motion.
const enterAnim = {
  center: "motion-safe:animate-modal-in",
  right: "motion-safe:animate-slide-in-right",
  bottom: "motion-safe:animate-slide-in-bottom",
} as const;
const exitAnim = {
  center: "motion-safe:animate-modal-out",
  right: "motion-safe:animate-slide-out-right",
  bottom: "motion-safe:animate-slide-out-bottom",
} as const;
// Must outlast the longest exit animation above so the unmount timer fires
// after the animation, not during it.
const EXIT_MS = 260;

type OverlayProps = {
  open: boolean;
  onClose: () => void;
  placement?: VariantProps<typeof overlayPanel>["placement"];
  /** Extra classes for the panel (e.g. max-w-lg on a modal). */
  className?: string;
  /** Accessible label for the dialog when there's no visible titled heading. */
  label?: string;
  /**
   * Portal target. Defaults to `document.body` (correct for the real app,
   * where the theme lives on `<html>`). Override to portal into a themed
   * subtree — e.g. the gallery renders each theme column's overlays into that
   * column so the token vars cascade in and both themes preview correctly.
   */
  container?: HTMLElement | null;
  children: React.ReactNode;
};

function Overlay({
  open,
  onClose,
  placement = "center",
  className,
  label,
  container,
  children,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<Element | null>(null);
  // `render` keeps the overlay mounted through its exit animation; `closing`
  // swaps the enter animation for the exit one. When `open` goes false we play
  // the exit, then unmount after EXIT_MS (or immediately under reduced motion).
  const [render, setRender] = useState(open);
  const [closing, setClosing] = useState(false);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  // Opening: mount and (re)enter. Cancels any in-flight close.
  useEffect(() => {
    if (open) {
      setRender(true);
      setClosing(false);
    }
  }, [open]);

  // Closing: while still mounted, play the exit animation then unmount. Reduced
  // motion skips straight to unmount. Re-opening mid-close clears this timer via
  // the effect cleanup (deps change), so it never tears down a re-opened panel.
  useEffect(() => {
    if (open || !render) return;
    setClosing(true);
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const t = setTimeout(
      () => {
        setRender(false);
        setClosing(false);
      },
      reduce ? 0 : EXIT_MS,
    );
    return () => clearTimeout(t);
  }, [open, render]);

  // While mounted: remember the previously-focused element, lock body scroll,
  // and move focus into the panel. On unmount (after the exit): restore both.
  useEffect(() => {
    if (!render) return;
    restoreRef.current = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const panel = panelRef.current;
    const firstFocusable = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (firstFocusable ?? panel)?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      if (restoreRef.current instanceof HTMLElement) restoreRef.current.focus();
    };
  }, [render]);

  if (!render || typeof document === "undefined") return null;

  const align =
    placement === "center"
      ? "items-center justify-center p-4"
      : placement === "right"
        ? "items-stretch justify-end"
        : "items-end justify-center";

  return createPortal(
    <div
      className={cn(
        "fixed inset-0 z-50 flex overflow-hidden bg-black/50",
        closing ? "motion-safe:animate-fade-out" : "motion-safe:animate-fade-in",
        align,
      )}
      onMouseDown={(e) => {
        // Click-out: only when the press starts on the backdrop itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          overlayPanel({ placement }),
          closing ? exitAnim[placement] : enterAnim[placement],
          className,
        )}
      >
        {children}
      </div>
    </div>,
    container ?? document.body,
  );
}

export type ModalProps = Omit<OverlayProps, "placement">;
export function Modal(props: ModalProps) {
  return <Overlay {...props} placement="center" className={cn("max-w-lg", props.className)} />;
}

export type SlideOverProps = Omit<OverlayProps, "placement">;
export function SlideOver(props: SlideOverProps) {
  return <Overlay {...props} placement="right" className={cn("max-w-xl", props.className)} />;
}

export type DrawerProps = Omit<OverlayProps, "placement">;
export function Drawer(props: DrawerProps) {
  // Full-width bottom sheet (mockup). The panel already spans w-full; the
  // backdrop's padding insets it slightly. Pass a className to cap the width.
  return <Overlay {...props} placement="bottom" />;
}
