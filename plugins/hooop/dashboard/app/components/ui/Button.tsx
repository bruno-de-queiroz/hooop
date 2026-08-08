import { forwardRef } from "react";
import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// Four variants, no more (DESIGN.md §5): accent (the single primary action),
// pill (secondary), ghost (tertiary), icon (square icon-only). Transitions are
// pure color/background/filter, ~150ms ease-out — never hover-scale.
export const button = tv({
  base: "inline-flex items-center justify-center gap-1.5 font-sans font-medium select-none transition-[background,color,filter] duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:opacity-50 disabled:pointer-events-none",
  variants: {
    variant: {
      accent: "bg-accent text-white rounded-control hover:brightness-110 active:bg-accent-press",
      pill: "bg-elevated text-ink-soft rounded-control hover:bg-elevated-2 hover:text-ink",
      ghost: "bg-transparent text-ink-faint rounded-control hover:text-ink",
      icon: "bg-transparent text-ink-mute rounded-control hover:bg-elevated hover:text-ink",
    },
    size: {
      sm: "text-xs px-2.5 py-1",
      md: "text-sm px-3.5 py-2",
    },
  },
  compoundVariants: [
    // Icon buttons are square; the size drives the box, not horizontal padding.
    { variant: "icon", size: "sm", class: "p-1.5" },
    { variant: "icon", size: "md", class: "p-2" },
  ],
  defaultVariants: { variant: "pill", size: "md" },
});

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={cn(button({ variant, size }), className)} {...rest} />
  );
});

export type IconButtonProps = Omit<ButtonProps, "variant"> & { label: string };

/**
 * Square icon-only button. `label` is required and becomes `aria-label` so the
 * control is never unlabeled for assistive tech.
 */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", className, children, ...rest },
  ref,
) {
  return (
    <Button ref={ref} variant="icon" size={size} aria-label={label} className={className} {...rest}>
      {children}
    </Button>
  );
});
