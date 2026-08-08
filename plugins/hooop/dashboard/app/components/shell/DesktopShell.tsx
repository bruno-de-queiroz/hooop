"use client";
import { useCallback, useEffect, useState } from "react";
import { ChevronLeft, Folder, Globe, NotebookText, RotateCw, X } from "lucide-react";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { AppShell, TitleBar, Rail, CenterPane } from "@/app/components/ui/AppShell";
import { cn } from "@/app/components/ui/cn";
import { EventStatusBar } from "./EventStatusBar";
import { ShellEventsDrawer } from "./ShellEventsDrawer";
import { SkillsRail } from "./SkillsRail";
import { AgentsRail } from "./AgentsRail";
import { SummaryRail } from "./SummaryRail";
import { SessionsRail } from "./SessionsRail";
import { PeerSharedPanel } from "./PeerSharedPanel";
import { GuestFooter } from "./GuestFooter";
import { IdentityFooter } from "./IdentityFooter";
import { SettingsSheet } from "./SettingsSheet";
import { ShellSearch } from "./ShellSearch";
import { ShellThemeSwitcher } from "./ShellThemeSwitcher";
import { ShellCenterPane } from "./ShellCenterPane";
import { ShellRightDock } from "./ShellRightDock";
import { LeftRailCollapsed } from "./LeftRailCollapsed";
import { ShellAdmissionToast } from "./ShellAdmissionToast";
import { CenterFullscreenContext, PlanReviewProvider } from "./ShellChrome";
import { FilesRail } from "./files/FilesRail";
import { StatusDot } from "@/app/components/ui/StatusDot";
import { ShellPreviewPanel } from "./preview/ShellPreviewDock";
import { useOpenBrowserOnRequest } from "./preview/useOpenBrowserOnRequest";
import { useIsMobile, isMobileNow } from "./useIsMobile";
import { previewCue } from "./preview/previewCue";
import { useResizableDock } from "./useResizableDock";
import { ComposerInsertProvider } from "@/app/context/ComposerInsertProvider";
import { FilesUIProvider, useFilesUI, type RailView } from "@/app/context/FilesUIProvider";
import { PreviewUIProvider, usePreviewUI } from "@/app/context/PreviewUIProvider";
import { HooopMark } from "./HooopLogo";
import { AuthBanner } from "../AuthBanner";
import { HookBlockedBanner } from "../HookBlockedBanner";

// "Details" section — the former Summary + Skills + Sub-agents rail, now
// consolidated under one view. Shared by the desktop rail and the mobile overlay.
function DetailsView() {
  return (
    <>
      <SummaryRail />
      <SkillsRail />
      <AgentsRail />
    </>
  );
}

// The right-rail mini strip shown when collapsed (mockup's rail-mini): Details
// and Files shortcuts that expand the rail onto that view, plus the preview
// globe. All three expand the rail onto their section; the globe is here as well
// as in the tab strip because the browser must be reachable AT ALL TIMES —
// collapsing the rail is not a reason to lose the route to a running app.
function RightRailMini({ onOpen }: { onOpen: (v: RailView) => void }) {
  const { preview } = usePreviewUI();
  return (
    <div className="flex flex-col items-center py-3 gap-1 w-12">
      <button className="icon-btn w-9 h-9" title="Details" onClick={() => onOpen("details")}>
        <NotebookText className="w-4 h-4" />
      </button>
      <button className="icon-btn w-9 h-9" title="Files" onClick={() => onOpen("files")}>
        <Folder className="w-4 h-4" />
      </button>
      <button
        className="icon-btn relative w-9 h-9"
        title={preview ? `Browser — ${preview.spec.name} is ${preview.state}` : "Browser"}
        onClick={() => onOpen("browser")}
      >
        <Globe className="w-4 h-4" />
        {/* The same cue the expanded tab strip carries. Without it, collapsing
          * the rail hid the only sign that an app is running — and collapsing
          * the rail is exactly when you most need telling. */}
        {preview && (
          <span className="absolute right-1.5 top-1.5">
            <StatusDot state={previewCue(preview.state)} size="sm" pulse={preview.state === "starting"} />
          </span>
        )}
      </button>
    </div>
  );
}

// Manual refresh for the Files navigator (mockup's ph-right button). The
// working tree has no push channel, so the tree + open preview only re-fetch
// on demand; one spin animation per click gives the action feedback.
function FilesRefreshButton({ onRefresh }: { onRefresh: () => void }) {
  const [spinning, setSpinning] = useState(false);
  return (
    <button
      className="icon-btn w-8 h-8"
      title="Refresh"
      aria-label="Refresh files"
      onClick={() => {
        onRefresh();
        setSpinning(true);
      }}
    >
      <RotateCw
        className={cn("w-4 h-4", spinning && "motion-safe:animate-spin")}
        onAnimationIteration={() => setSpinning(false)}
      />
    </button>
  );
}

// The rail's section switch (Details | Files | Browser), used in the expanded
// panel header and the mobile overlay header. Browser is always present, even
// with no preview running — the section owns the "nothing is running" state, so
// hiding the tab would make the feature undiscoverable.
function ViewTabs({ view, onView }: { view: RailView; onView: (v: RailView) => void }) {
  const { preview } = usePreviewUI();
  return (
    <div className="flex items-center gap-0.5 rounded-control bg-sunken p-0.5">
      {(["details", "files", "browser"] as RailView[]).map((v) => (
        <button
          key={v}
          onClick={() => onView(v)}
          className={cn(
            "px-2.5 py-1 rounded-[7px] text-[12px] capitalize transition-colors",
            "inline-flex items-center gap-1.5",
            view === v ? "bg-elevated text-ink shadow-card" : "text-ink-mute hover:text-ink",
          )}
        >
          {v}
          {/* A running app is worth knowing about from any section, so the cue
            * rides on the tab rather than only inside the panel. */}
          {v === "browser" && preview && (
            <StatusDot state={previewCue(preview.state)} size="sm" pulse={preview.state === "starting"} />
          )}
        </button>
      ))}
    </div>
  );
}

/** Preview state → one of the DS's six fixed cue meanings. */
/**
 * Desktop-app shell — the only shell (the legacy panel dashboard was removed at
 * the Phase 4 cutover). Composes the shell primitives — title bar, left rail,
 * center pane, docked right column, collapsible right rail, bottom status bar.
 *
 * DesktopShell just mounts the cross-cutting providers; ShellLayout renders the
 * chrome and consumes them (the Files UI provider must be an ancestor of the
 * layout so the rail, header menu, and dock all share one state).
 */
export function DesktopShell({ isPeer, port }: { isPeer: boolean; port: string }) {
  return (
    <ComposerInsertProvider>
      <FilesUIProvider>
        <PreviewUIProvider>
          <PlanReviewProvider>
            <ShellLayout isPeer={isPeer} port={port} />
          </PlanReviewProvider>
        </PreviewUIProvider>
      </FilesUIProvider>
    </ComposerInsertProvider>
  );
}

function ShellLayout({ isPeer, port }: { isPeer: boolean; port: string }) {
  const { view, setView, railCollapsed, setRailCollapsed, mobileView, openMobile, closeMobile, refreshFiles } = useFilesUI();
  const { selectedId, setSelected } = useSelectedSession();
  // Which layout is actually on screen. The other one stays mounted behind a
  // CSS `hidden`, so the preview must not be rendered into it — see useIsMobile.
  const isMobile = useIsMobile();

  // Left (sessions) rail collapse — like the right rail, lets the chat pane widen
  // without going full fullscreen. Persisted after mount (same SSR-safe pattern
  // as fullscreen); starts expanded.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // "Expand the main frame": collapse both rails so the center chat pane goes
  // full-width (mockup's session-header maximize). Persisted after mount to
  // avoid an SSR/hydration mismatch. Shared with the header button via context.
  const [fullscreen, setFullscreen] = useState(false);

  // The right rail's width, remembered per section. Each section wants a
  // different amount of room — a file tree is a list, the browser is a whole
  // application — and one shared number would make opening the Browser narrow
  // it, or opening Details leave two thirds of the window empty.
  const railWidths: Record<string, { key: string; defaultWidth: number }> = {
    details: { key: "hooop-rail-width-details", defaultWidth: 304 },
    files: { key: "hooop-rail-width-files", defaultWidth: 304 },
    browser: { key: "hooop-rail-width-browser", defaultWidth: 544 },
  };
  const railSize = railWidths[view] ?? railWidths.details;
  const {
    width: railWidth, dragging: railDragging,
    asideRef: railRef, onPointerDown: onRailPointerDown,
  } = useResizableDock(railSize.key, { min: 260, max: 900, defaultWidth: railSize.defaultWidth });
  // Collapsed and fullscreen own the width themselves (a fixed strip, or zero),
  // so the measured width applies only to an expanded rail.
  const sized = !railCollapsed && !fullscreen;
  useEffect(() => {
    try {
      setFullscreen(localStorage.getItem("hooop-center-fullscreen") === "1");
      setLeftCollapsed(localStorage.getItem("hooop-left-rail-collapsed") === "1");
    } catch {
      /* ignore */
    }
  }, []);
  const toggleLeftCollapsed = () =>
    setLeftCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem("hooop-left-rail-collapsed", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  const toggleFullscreen = () =>
    setFullscreen((v) => {
      const next = !v;
      try {
        localStorage.setItem("hooop-center-fullscreen", next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });

  const openMiniView = useCallback((v: RailView) => {
    setView(v);
    setRailCollapsed(false);
  }, [setView, setRailCollapsed]);

  useOpenBrowserOnRequest({
    selectedId,
    openRail: () => openMiniView("browser"),
    openMobile: () => openMobile("browser"),
    isMobile: isMobileNow,
  });

  return (
    <CenterFullscreenContext.Provider value={{ fullscreen, toggle: toggleFullscreen }}>
      <AppShell>
        {/* Expanding the main frame collapses ALL chrome — title bar, both
          * rails, and the event footer — leaving just the center pane. */}
        <TitleBar
          className={cn(
            "overflow-hidden motion-safe:transition-[height,opacity] motion-safe:duration-200 motion-safe:ease-smooth",
            "max-lg:hidden",
            fullscreen && "h-0 opacity-0 border-b-0 pointer-events-none",
          )}
        >
          <HooopMark size={18} className="mr-0.5" />
          <span className="font-sans font-bold tracking-tight text-ink">hooop</span>
          <div className="ml-auto flex items-center gap-2">
            <ShellSearch />
            <ShellThemeSwitcher />
          </div>
        </TitleBar>

        <div className="flex flex-1 min-h-0">
          {/* Left rail: sessions list + identity footer (peer: shared-session note).
            * Collapsible to a mini strip via the mid-edge handle (hidden while
            * fullscreen collapses everything). */}
          <Rail
            side="left"
            animateWidth
            collapsible={!fullscreen}
            collapsed={leftCollapsed}
            onToggle={toggleLeftCollapsed}
            collapsedContent={
              <LeftRailCollapsed
                isPeer={isPeer}
                onNew={() => { setSelected(null); setLeftCollapsed(false); }}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            }
            className={cn(
              "shrink-0",
              "max-lg:hidden",
              fullscreen ? "w-0 border-r-0" : leftCollapsed ? "w-12" : "w-[17rem]",
            )}
          >
            {isPeer ? (
              <PeerSharedPanel />
            ) : (
              <div className="flex-1 min-h-0 flex flex-col w-[17rem]">
                <SessionsRail />
              </div>
            )}
            {isPeer ? <GuestFooter /> : <IdentityFooter onOpenSettings={() => setSettingsOpen(true)} />}
          </Rail>

          <CenterPane>
            <AuthBanner />
            <HookBlockedBanner />
            <ShellCenterPane />
          </CenterPane>

          {/* Docked column between the chat frame and right rail: file preview
            * (precedence) or plan review, pushing the chat frame narrower. */}
          <ShellRightDock />

          <Rail
            side="right"
            animateWidth={!railDragging}
            collapsed={railCollapsed}
            ref={railRef}
            style={sized ? { width: railWidth } : undefined}
            className={cn(
              "shrink-0",
              "max-lg:hidden",
              fullscreen ? "w-0 border-l-0" : railCollapsed ? "w-12" : null,
            )}
            collapsedContent={<RightRailMini onOpen={openMiniView} />}
            resizeHandle={sized ? (
              // Left edge: the rail is pinned to the window's right, so this is
              // its only movable side. Hidden on phones, where the rail does not
              // exist and the sections open as a full-screen overlay.
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panel"
                onPointerDown={onRailPointerDown}
                className="group absolute inset-y-0 left-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize max-lg:hidden"
              >
                <div
                  className={cn(
                    "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors",
                    "group-hover:bg-accent",
                    railDragging && "bg-accent",
                  )}
                />
              </div>
            ) : undefined}
          >
            {/* Expanded: shared header (back to mini + Details/Files tabs), then
              * the selected view. Fixed width so the aside's width animation
              * reveals it cleanly. */}
            <div className="flex-1 min-h-0 flex flex-col w-full">
              <div className="shrink-0 flex items-center gap-2 px-2 h-14 border-b border-divider">
                <button
                  className="icon-btn w-8 h-8"
                  title="Back"
                  aria-label="Collapse panel"
                  onClick={() => setRailCollapsed(true)}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <ViewTabs view={view} onView={setView} />
                {view === "files" && (
                  <div className="ml-auto">
                    <FilesRefreshButton onRefresh={refreshFiles} />
                  </div>
                )}
              </div>
              {/* The browser owns its own scrolling (an iframe plus a footer of
                * controls), so it is NOT wrapped in the shared overflow-y box the
                * list sections need. */}
              {view === "browser" && !isMobile ? (
                <ShellPreviewPanel />
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                  {view === "files" ? <FilesRail /> : <DetailsView />}
                </div>
              )}
            </div>
          </Rail>
        </div>

        {/* Global Events feed (host-only; a peer is scoped to one session). */}
        {!isPeer && (
          <>
            <div
              className={cn(
                "shrink-0 overflow-hidden motion-safe:transition-[height] motion-safe:duration-200 motion-safe:ease-smooth",
                "max-lg:hidden",
                fullscreen ? "h-0" : "h-8",
              )}
            >
              <EventStatusBar port={port} onOpen={() => setEventsOpen(true)} />
            </div>

            <ShellEventsDrawer open={eventsOpen} onClose={() => setEventsOpen(false)} />
          </>
        )}

        {/* Mobile: the right rail is hidden, so Details/Files open here as a
          * full-screen overlay driven by the session-header ⋯ menu. */}
        {mobileView && (
          <div className="lg:hidden fixed inset-0 z-[70] flex flex-col bg-window">
            <div className="shrink-0 flex items-center gap-2 px-3 h-14 border-b border-divider">
              <ViewTabs
                view={mobileView}
                onView={(v) => {
                  setView(v); // keep desktop rail in sync on next open
                  openMobile(v);
                }}
              />
              <div className="ml-auto flex items-center gap-1">
                {mobileView === "files" && <FilesRefreshButton onRefresh={refreshFiles} />}
                <button className="icon-btn w-8 h-8" title="Close" aria-label="Close" onClick={closeMobile}>
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            {/* Same split as the desktop rail: the browser scrolls itself. It
              * was missing here, so the Browser tab on a phone quietly showed
              * Details — and the agent asking a mobile peer to open the preview
              * would have sent them somewhere it does not exist. */}
            {mobileView === "browser" && isMobile ? (
              // Immersive: the overlay already has a bar, so the panel drops its
              // own and the app gets the screen. Without it the phone showed two
              // headers, a spec block and a wrapped button grid around a letterbox
              // of the actual application.
              <ShellPreviewPanel immersive />
            ) : (
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
                {mobileView === "files" ? <FilesRail /> : <DetailsView />}
              </div>
            )}
          </div>
        )}

        <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} isPeer={isPeer} />

        <ShellAdmissionToast />
      </AppShell>
    </CenterFullscreenContext.Provider>
  );
}
