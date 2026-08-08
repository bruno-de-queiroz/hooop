import { cn } from "./cn";

// The small uppercase rail sub-header (DESIGN.md "section-title" tier):
// Archivo 600, 11px, tracked, uppercase, ink-faint.
export function SectionTitle({
  className,
  children,
  ...rest
}: React.HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3
      className={cn(
        "font-sans text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint",
        className,
      )}
      {...rest}
    >
      {children}
    </h3>
  );
}
