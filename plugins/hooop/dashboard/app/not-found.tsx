import Link from "next/link";
import { Compass } from "lucide-react";
import { AppShell, TitleBar, CenterPane } from "./components/ui/AppShell";
import { HooopMark } from "./components/shell/HooopLogo";
import { ShellThemeSwitcher } from "./components/shell/ShellThemeSwitcher";
import { button } from "./components/ui/Button";

// App Router's catch-all for unmatched routes. Mirrors the desktop-app chrome
// (title bar + centered pane) so a bad URL still looks like hooop, not a bare
// Next.js error page — same empty-state language as ShellNewSession (icon
// badge + title + subtitle + one accent action). No DashboardProviders here:
// this page must render for any URL, authenticated or not, so it carries no
// session/data dependency.
export default function NotFound() {
  return (
    <AppShell>
      <TitleBar className="max-lg:hidden">
        <HooopMark size={18} className="mr-0.5" />
        <span className="font-sans font-bold tracking-tight text-ink">hooop</span>
        <div className="ml-auto flex items-center gap-2">
          <ShellThemeSwitcher />
        </div>
      </TitleBar>
      <CenterPane>
        <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
          <span
            className="avatar w-9 h-9 shrink-0 mb-4"
            style={{
              background: "color-mix(in oklab, rgb(var(--accent)) 16%, rgb(var(--elevated)))",
              color: "rgb(var(--accent))",
            }}
          >
            <Compass className="w-4 h-4" />
          </span>
          <h1 className="text-[17px] font-semibold text-ink mb-1">Page not found</h1>
          <p className="text-[12px] text-ink-faint mb-6 max-w-xs">
            There&apos;s nothing at this address — it may have moved, or never existed.
          </p>
          <Link href="/" className={button({ variant: "accent", size: "md" })}>
            Go home
          </Link>
        </div>
      </CenterPane>
    </AppShell>
  );
}
