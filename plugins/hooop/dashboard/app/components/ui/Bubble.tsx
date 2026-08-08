import { tv, type VariantProps } from "tailwind-variants";
import { cn } from "./cn";

// A chat bubble. Assistant speaks from an `elevated` bubble on the left; host
// and peer speak from cue-colored bubbles on the right, inked with
// `bubble-ink` — white over the dark theme's deep fills, near-black over the
// light theme's pale ones. A bubble carrying a CodeBlock/ToolCard widens to a
// fixed ~48rem (`wide`), a bit past the permission popup — never the full
// pane. Text bubbles stay shrink-to-fit.
export const bubble = tv({
  base: "rounded-bubble px-3.5 py-2.5 font-sans text-sm leading-relaxed break-words",
  variants: {
    author: {
      assistant: "bg-elevated text-ink-soft rounded-bl-[5px] self-start",
      host: "bg-host-bubble text-bubble-ink rounded-br-[5px] self-end",
      peer: "bg-peer-bubble text-bubble-ink rounded-br-[5px] self-end",
    },
    wide: {
      true: "w-[48rem] max-w-full",
      false: "max-w-[min(82%,40rem)]",
    },
  },
  defaultVariants: { author: "assistant", wide: false },
});

export type BubbleProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof bubble>;

export function Bubble({ author, wide, className, children, ...rest }: BubbleProps) {
  return (
    <div className={cn(bubble({ author, wide }), className)} {...rest}>
      {children}
    </div>
  );
}
