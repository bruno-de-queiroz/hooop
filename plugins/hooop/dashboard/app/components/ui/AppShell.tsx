"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "./cn";
import { useVisualViewportHeight } from "./useVisualViewportHeight";

// The desktop-app window and its regions. Composition:
//   <AppShell>
//     <TitleBar/>
//     <div className="flex flex-1">
//       <Rail side="left"/> <CenterPane/> <Rail side="right" collapsible/>
//     </div>
//     <StatusBar/>
//   </AppShell>
// These are presentational containers wired to the real providers/hooks by the
// consumer (Phase 2) — no data logic lives here.

export function AppShell({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  // Track the visual viewport so the composer isn't hidden behind the mobile
  // on-screen keyboard (see the hook for why `100dvh` alone isn't enough).
  useVisualViewportHeight();
  return (
    // Edge-to-edge on phones (no window padding/rounding) so the chat frame gets
    // the full viewport; the framed desktop-app window returns at `sm`.
    // Height comes from `--app-height` (the live visualViewport height, set by
    // the hook above) and falls back to `100dvh` before JS runs / on browsers
    // without visualViewport. `100dvh` already handles the address bar; the var
    // additionally shrinks the shell when the keyboard opens.
    <div className={cn("h-[var(--app-height,100dvh)] w-screen bg-bg p-0 sm:p-3", className)} {...rest}>
      <div className="h-full w-full flex flex-col bg-window overflow-hidden rounded-none sm:rounded-window sm:shadow-card">
        {children}
      </div>
    </div>
  );
}

export function TitleBar({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <header
      className={cn(
        "flex items-center gap-1 px-4 h-12 shrink-0 bg-rail border-b border-divider",
        className,
      )}
      {...rest}
    >
      {children}
    </header>
  );
}

export type RailProps = React.HTMLAttributes<HTMLElement> & {
  side: "left" | "right";
  /** When true, render the mid-edge collapse handle. */
  collapsible?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Rendered in place of `children` while collapsed (e.g. a mini icon strip). */
  collapsedContent?: React.ReactNode;
  /** Animate width changes (collapse/expand). The width itself comes from `className`. */
  animateWidth?: boolean;
  /**
   * A drag handle for the rail's inner edge, rendered outside the content clip.
   *
   * Supplied by the caller rather than built in, because only the caller knows
   * whether this rail is resizable, what it should be clamped to, and where the
   * width is remembered.
   */
  resizeHandle?: React.ReactNode;
  /**
   * The aside itself, for a caller that measures it.
   *
   * Declared explicitly: React 19 passes `ref` as an ordinary prop, but the
   * HTMLAttributes base this extends does not include it, so without this the
   * ref is a type error at every call site that needs one.
   */
  ref?: React.Ref<HTMLElement>;
};

export function Rail({
  side,
  collapsible,
  collapsed = false,
  onToggle,
  collapsedContent,
  animateWidth,
  resizeHandle,
  ref,
  className,
  children,
  ...rest
}: RailProps) {
  const edge = side === "left" ? "border-r" : "border-l";
  return (
    <aside
      ref={ref}
      className={cn(
        "relative bg-rail flex flex-col min-h-0",
        edge,
        "border-divider",
        animateWidth && "motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-smooth",
        className,
      )}
      {...rest}
    >
      {/* Inner clips content during a width animation so a fixed-width panel
        * reveals cleanly instead of reflowing. The handle sits on the aside
        * (outside this clip) so it stays visible at the edge. */}
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {collapsed ? collapsedContent : children}
      </div>
      {collapsible && <CollapseHandle side={side} collapsed={collapsed} onToggle={onToggle} />}
      {/* Outside the clip above, like the collapse handle, so it stays on the
        * edge rather than being scrolled away with the content. */}
      {resizeHandle}
    </aside>
  );
}

// The mid-edge pill that collapses/expands a rail. Sits on the rail's inner
// edge, vertically centered.
function CollapseHandle({
  side,
  collapsed,
  onToggle,
}: {
  side: "left" | "right";
  collapsed: boolean;
  onToggle?: () => void;
}) {
  // The handle hangs off the rail's inner edge (left rail → right edge, etc.).
  const edgeClass = side === "left" ? "right-0 translate-x-1/2" : "left-0 -translate-x-1/2";
  // The chevron points the direction the rail will MOVE. Right rail: collapsed
  // → points left (opens inward); expanded → points right (closes outward).
  // Left rail is the mirror.
  const pointLeft = side === "left" ? !collapsed : collapsed;
  const Icon = pointLeft ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "Expand panel" : "Collapse panel"}
      aria-expanded={!collapsed}
      className={cn(
        "absolute top-1/2 -translate-y-1/2 z-20 w-5 h-11 rounded-full flex items-center justify-center bg-elevated border border-divider text-ink-mute hover:text-ink shadow-card transition-colors",
        edgeClass,
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </button>
  );
}

export function CenterPane({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <main className={cn("relative flex-1 min-w-0 flex flex-col bg-center", className)} {...rest}>
      {/* Accent floor-glow behind the transcript (decorative, pointer-none). */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-0"
        style={{
          background:
            "radial-gradient(58% 42% at 50% 100%, color-mix(in oklab, rgb(var(--accent)) 9%, transparent), transparent 72%)",
        }}
      />
      <div className="relative z-10 flex-1 min-h-0 flex flex-col">{children}</div>
    </main>
  );
}

export function StatusBar({ className, children, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <footer
      className={cn(
        "flex items-center gap-3 px-4 h-8 shrink-0 bg-rail border-t border-divider font-mono text-[11px] text-ink-faint tabular-nums",
        className,
      )}
      {...rest}
    >
      {children}
    </footer>
  );
}
