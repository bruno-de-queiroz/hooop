import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// A pill tab. Active state is an accent foreground on an `elevated` chip
// (`tone="accent"`), or a neutral ink foreground (`tone="neutral"`) for
// segmented switches where accent would over-signal.
export const tab = tv({
  base: "inline-flex items-center justify-center gap-1 rounded-lg px-2.5 py-1 font-sans text-[10px] font-medium uppercase tracking-[0.06em] transition-[background,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
  variants: {
    tone: { accent: "", neutral: "" },
    active: { true: "bg-elevated", false: "text-ink-faint hover:text-ink-soft" },
  },
  compoundVariants: [
    { tone: "accent", active: true, class: "text-accent" },
    { tone: "neutral", active: true, class: "text-ink" },
  ],
  defaultVariants: { tone: "accent", active: false },
});

export type TabProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof tab>;

export function Tab({ tone, active, className, type = "button", ...rest }: TabProps) {
  return (
    <button
      type={type}
      role="tab"
      aria-selected={active ?? false}
      className={cn(tab({ tone, active }), className)}
      {...rest}
    />
  );
}

export type TabGroupProps = React.HTMLAttributes<HTMLDivElement>;

/** Horizontal group wrapper. Wire selection in the consumer; Tab is presentational. */
export function TabGroup({ className, children, ...rest }: TabGroupProps) {
  return (
    <div role="tablist" className={cn("inline-flex items-center gap-1", className)} {...rest}>
      {children}
    </div>
  );
}
