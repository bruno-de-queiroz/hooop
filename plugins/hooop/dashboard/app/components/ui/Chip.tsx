import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// A tiny classification pill, matching the mockup's `.chip`: JetBrains Mono,
// 10px, elevated background, NOT uppercased by default (namespace chips read
// lowercase, e.g. `claude-mem`). A cue tone tints the foreground only. For
// uppercase classification pills (transport, entrypoint), pass `uppercase
// tracking-wide` via className, as the mockup does.
export const chip = tv({
  base: "inline-flex items-center gap-1 rounded-[6px] px-1.5 py-0.5 font-mono text-[10px] leading-none",
  variants: {
    tone: {
      neutral: "bg-elevated text-ink-faint",
      accent: "bg-accent/15 text-accent",
      live: "bg-live/15 text-live",
      wrap: "bg-wrap/15 text-wrap",
      sdk: "bg-sdk/15 text-sdk",
      direct: "bg-direct/15 text-direct",
      fail: "bg-fail/15 text-fail",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type ChipProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof chip>;

export function Chip({ tone, className, children, ...rest }: ChipProps) {
  return (
    <span className={cn(chip({ tone }), className)} {...rest}>
      {children}
    </span>
  );
}
