import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// An LED-style figure: monospace, tabular, for durations / token counts / PIDs.
// `tone` tints the value (accent for the headline stat, a cue for state-bearing
// numbers). Numbers always use tabular-nums so columns align across rows.
export const readout = tv({
  base: "font-mono tabular-nums leading-none",
  variants: {
    tone: {
      ink: "text-ink",
      soft: "text-ink-soft",
      mute: "text-ink-mute",
      accent: "text-accent",
      live: "text-live",
      wrap: "text-wrap",
      fail: "text-fail",
    },
    size: {
      sm: "text-[11px]",
      md: "text-sm",
      lg: "text-lg",
    },
  },
  defaultVariants: { tone: "ink", size: "md" },
});

export type ReadoutProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof readout>;

export function Readout({ tone, size, className, children, ...rest }: ReadoutProps) {
  return (
    <span className={cn(readout({ tone, size }), className)} {...rest}>
      {children}
    </span>
  );
}
