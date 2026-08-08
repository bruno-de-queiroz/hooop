import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// Round avatar: initials or an icon on an `elevated` disc. Optional `ring`
// draws a cue-colored ring (e.g. presence). Host/peer chat coloring lives on
// the Bubble, not here.
export const avatar = tv({
  base: "inline-flex items-center justify-center rounded-full bg-elevated text-ink-soft font-sans font-semibold shrink-0 overflow-hidden",
  variants: {
    size: {
      sm: "w-6 h-6 text-[10px]",
      md: "w-8 h-8 text-xs",
      lg: "w-10 h-10 text-sm",
    },
    ring: {
      none: "",
      accent: "ring-2 ring-accent ring-offset-2 ring-offset-window",
      host: "ring-2 ring-host-bubble ring-offset-2 ring-offset-window",
      peer: "ring-2 ring-peer-bubble ring-offset-2 ring-offset-window",
    },
  },
  defaultVariants: { size: "md", ring: "none" },
});

export type AvatarProps = React.HTMLAttributes<HTMLSpanElement> &
  VariantProps<typeof avatar> & {
    /** Initials to render when no icon child is supplied. */
    initials?: string;
  };

export function Avatar({ size, ring, initials, className, children, ...rest }: AvatarProps) {
  return (
    <span className={cn(avatar({ size, ring }), className)} {...rest}>
      {children ?? initials}
    </span>
  );
}
