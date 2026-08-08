import { cn } from "./cn";

// A tool-call card: an inset `sunken` well with a divider border. Header carries
// the tool name (mono) + an optional status cue; the body holds args/result.
export type ToolCardProps = React.HTMLAttributes<HTMLDivElement> & {
  name: React.ReactNode;
  /** Right-aligned status/metadata in the header (chip, duration, dot). */
  status?: React.ReactNode;
};

export function ToolCard({ name, status, className, children, ...rest }: ToolCardProps) {
  return (
    <div className={cn("bg-sunken border border-divider rounded-[12px] overflow-hidden", className)} {...rest}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-divider">
        <span className="font-mono text-xs text-ink-mute truncate">{name}</span>
        {status && <div className="ml-auto flex items-center gap-1.5 shrink-0">{status}</div>}
      </div>
      {children != null && <div className="px-3 py-2 font-mono text-[12px] text-ink-faint">{children}</div>}
    </div>
  );
}
