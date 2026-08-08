import { cn } from "./cn";

// Loading placeholder. A sunken bar that gently pulses (motion-safe, so
// prefers-reduced-motion gets a static bar). Compose these into row shapes that
// mirror the real content's layout so the rail doesn't reflow when data lands —
// see SkeletonRows below and the rails' loading branches.
export function Skeleton({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      aria-hidden
      className={cn("rounded-md bg-sunken motion-safe:animate-pulse", className)}
      {...rest}
    />
  );
}

/**
 * A stack of list-row skeletons matching the rails' row rhythm: a small leading
 * glyph, a flexible label bar, and an optional trailing chip. `rows` controls
 * count; widths vary per row so it reads as content, not a progress bar.
 */
export function SkeletonRows({
  rows = 5,
  chip = true,
  className,
}: {
  rows?: number;
  chip?: boolean;
  className?: string;
}) {
  const widths = ["w-3/4", "w-1/2", "w-2/3", "w-3/5", "w-1/2", "w-4/5"];
  return (
    <div className={cn("space-y-1.5", className)} aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1.5">
          <Skeleton className="w-5 h-5 rounded-md shrink-0" />
          <Skeleton className={cn("h-3", widths[i % widths.length])} />
          {chip && <Skeleton className="ml-auto w-10 h-3.5 rounded shrink-0" />}
        </div>
      ))}
    </div>
  );
}
