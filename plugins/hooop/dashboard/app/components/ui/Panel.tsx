import { cn } from "./cn";
import { SectionTitle } from "./SectionTitle";

// A titled information region — the rail's macro unit. Flat at rest; a divider
// hairline separates the header from the body. Composed from slots:
//   <Panel><Panel.Header icon title count actions/><Panel.Body/></Panel>

export type PanelProps = React.HTMLAttributes<HTMLDivElement>;

function PanelRoot({ className, children, ...rest }: PanelProps) {
  return (
    <section className={cn("flex flex-col min-h-0", className)} {...rest}>
      {children}
    </section>
  );
}

export type PanelHeaderProps = React.HTMLAttributes<HTMLDivElement> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  /** Optional count rendered muted next to the title, e.g. Skills (14). */
  count?: number;
  /** Right-aligned actions (buttons, tabs). */
  actions?: React.ReactNode;
};

function PanelHeader({ icon, title, count, actions, className, ...rest }: PanelHeaderProps) {
  return (
    <header
      className={cn(
        "flex items-center gap-2 px-3.5 py-2.5 border-b border-divider shrink-0",
        className,
      )}
      {...rest}
    >
      {icon && <span className="text-ink-mute shrink-0">{icon}</span>}
      <SectionTitle className="text-[13px] normal-case tracking-normal text-ink-soft">
        {title}
      </SectionTitle>
      {typeof count === "number" && (
        <span className="font-mono text-xs text-ink-faint tabular-nums">({count})</span>
      )}
      {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
    </header>
  );
}

export type PanelBodyProps = React.HTMLAttributes<HTMLDivElement>;
function PanelBody({ className, children, ...rest }: PanelBodyProps) {
  return (
    <div className={cn("flex-1 min-h-0 overflow-y-auto p-3.5", className)} {...rest}>
      {children}
    </div>
  );
}

export const Panel = Object.assign(PanelRoot, { Header: PanelHeader, Body: PanelBody });
