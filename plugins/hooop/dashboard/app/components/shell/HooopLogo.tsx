import type { SVGProps } from "react";
import { cn } from "../ui/cn";

// hooop brand mark — an orbit ring with a filled upper-left node and a hollow
// lower-right node. Geometry is taken from the brand book; the fixed-color
// favicon lives at app/icon.svg and the README lockup at docs/logo.svg.
//
// In-app the mark is theme-aware rather than hard-coding the brand hexes: the
// ring and filled node take the rationed `accent` token, the hollow node is the
// page `bg` outlined in `ink` — so it re-skins with the dashboard (dark/light)
// exactly like the rest of the shell.
export function HooopMark({ size = 20, className, ...props }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      role="img"
      aria-label="hooop"
      className={cn("shrink-0", className)}
      {...props}
    >
      <circle cx="16" cy="16" r="8" className="stroke-accent" strokeWidth="1.9" />
      <circle cx="9.85" cy="9.85" r="2.2" className="fill-accent" />
      <circle cx="22.15" cy="22.15" r="2.2" className="fill-bg stroke-ink" strokeWidth="0.9" />
    </svg>
  );
}
