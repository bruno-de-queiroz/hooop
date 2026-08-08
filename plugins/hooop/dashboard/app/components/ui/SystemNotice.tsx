import { cn } from "./cn";

// A centered, muted line for lifecycle/system events in the transcript
// (session started, resumed, interrupted). Not a bubble — it reads as a quiet
// separator between turns, never competing with the conversation.
export type SystemNoticeProps = React.HTMLAttributes<HTMLDivElement>;

export function SystemNotice({ className, children, ...rest }: SystemNoticeProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 my-1 text-center justify-center font-mono text-[11px] text-ink-faint",
        className,
      )}
      {...rest}
    >
      <span className="h-px flex-1 max-w-[4rem] bg-divider" aria-hidden />
      <span>{children}</span>
      <span className="h-px flex-1 max-w-[4rem] bg-divider" aria-hidden />
    </div>
  );
}
