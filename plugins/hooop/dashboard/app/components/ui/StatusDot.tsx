import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// A small state dot that prefixes status-bearing rows. Cue color = state only
// (live/wrap/fail/sdk/direct). `pulse` runs a slow OPACITY cycle — never scale,
// honoring the calm-motion rule (and prefers-reduced-motion via the utility).
export const statusDot = tv({
  base: "inline-block rounded-full shrink-0",
  variants: {
    state: {
      live: "bg-live",
      wrap: "bg-wrap",
      sdk: "bg-sdk",
      direct: "bg-direct",
      fail: "bg-fail",
      idle: "bg-ink-hush",
    },
    size: {
      sm: "w-1.5 h-1.5",
      md: "w-2 h-2",
    },
    pulse: { true: "motion-safe:animate-pulse", false: "" },
  },
  defaultVariants: { state: "idle", size: "md", pulse: false },
});

export type StatusDotProps = Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> &
  VariantProps<typeof statusDot>;

export function StatusDot({ state, size, pulse, className, ...rest }: StatusDotProps) {
  return (
    <span
      role="status"
      className={cn(statusDot({ state, size, pulse }), className)}
      {...rest}
    />
  );
}
