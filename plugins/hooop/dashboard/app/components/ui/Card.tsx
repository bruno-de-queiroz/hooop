import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// A self-contained content card. `elevated` sits raised on the surface; `sunken`
// reads as an inset well (matches tool cards / field wells). Flat at rest — no
// shadow (shadow means genuinely-lifted overlay, per DESIGN.md §4).
export const card = tv({
  base: "rounded-card border",
  variants: {
    surface: {
      elevated: "bg-elevated border-divider",
      sunken: "bg-sunken border-divider",
    },
    padded: { true: "p-4", false: "" },
  },
  defaultVariants: { surface: "elevated", padded: true },
});

export type CardProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof card>;

export function Card({ surface, padded, className, children, ...rest }: CardProps) {
  return (
    <div className={cn(card({ surface, padded }), className)} {...rest}>
      {children}
    </div>
  );
}
