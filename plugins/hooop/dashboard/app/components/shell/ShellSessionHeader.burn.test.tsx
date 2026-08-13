import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionInfo } from "@/lib/types/session";
import type { SessionMeta } from "@/app/context/hooks/useSessionMeta";

// ShellSessionHeader pulls in half a dozen contexts to render at all; mock
// each to its minimal shape rather than standing up real providers, same
// approach as LeftRailCollapsed.test.tsx.
vi.mock("@/app/context/SessionsProvider", () => ({
  useSessions: () => ({ sessions: [] }),
}));
vi.mock("@/app/context/hooks/useSharingLive", () => ({
  useSharingLive: () => false,
}));
vi.mock("./ShellChrome", () => ({
  useCenterFullscreen: () => ({ fullscreen: false, toggle: vi.fn() }),
}));
vi.mock("@/app/context/FilesUIProvider", () => ({
  useFilesUI: () => ({ openMobile: vi.fn() }),
}));
vi.mock("@/app/context/NotificationsProvider", () => ({
  useNotifications: () => ({
    state: "off",
    globalMuted: false,
    isMuted: () => false,
    setSessionMuted: vi.fn(),
  }),
}));

const activeSession = vi.hoisted(() => ({ setBurnAfterUse: vi.fn(), setAutoMode: vi.fn() }));
vi.mock("@/app/context/ActiveSessionProvider", () => ({
  useActiveSession: () => activeSession,
}));

const participant = vi.hoisted(() => ({ mounted: true }));
vi.mock("../lib/participant", () => ({
  useMounted: () => participant.mounted,
  isHostClient: () => true,
  isPeerClient: () => false,
  canAdmitPeers: () => true,
  canDecidePermissions: () => true,
}));

import { ShellSessionHeader } from "./ShellSessionHeader";

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "s1",
    path: "/x",
    mtime: new Date().toISOString(),
    size: 0,
    sessionId: "s1",
    startedAt: 0,
    lifecycle: "alive",
    ...over,
  } as SessionInfo;
}

function meta(over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    session: null,
    model: null,
    lifecycle: "alive",
    cwd: null,
    displayName: null,
    autoMode: false,
    ...over,
  } as SessionMeta;
}

beforeEach(() => {
  activeSession.setBurnAfterUse.mockClear();
  participant.mounted = true;
});

describe("ShellSessionHeader burn/dormancy chips", () => {
  it("shows the burn pill when meta.burnAfterUse is true, and the ✕ cancels it", () => {
    render(
      <ShellSessionHeader
        session={session()}
        meta={meta({ burnAfterUse: true } as Partial<SessionMeta>)}
        selectedId="s1"
        participants={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onShare={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("Burn after use")).toBeInTheDocument();
    // The pill's title (and an aria-label carrying the same text) is the only
    // thing that says WHEN the data goes once the text label is dropped below
    // `sm` — hover doesn't exist on touch, so the aria-label has to stand in.
    expect(
      screen.getByTitle(
        "This session deletes itself (transcript, workspace, events, share links) when it's ended, when the sandbox restarts, or once its idle window elapses, rather than going dormant.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Burn after use")).toBeInTheDocument();
    // The ✕ is the safe direction (no confirm modal), but it's a one-way
    // door: the API refuses to re-arm burn once cancelled. Title and
    // aria-label both have to say so, since neither alone reaches every user.
    const cancelName =
      "Cancel burn after use. This can't be undone: only a new session can arm burn again.";
    const cancelButton = screen.getByRole("button", { name: cancelName });
    expect(cancelButton).toHaveAttribute("title", cancelName);
    cancelButton.click();
    expect(activeSession.setBurnAfterUse).toHaveBeenCalledWith(false);
  });

  it("does not show the dormancy chip when idleTtlMs is null (install default)", () => {
    render(
      <ShellSessionHeader
        session={session()}
        meta={meta({ idleTtlMs: null } as Partial<SessionMeta>)}
        selectedId="s1"
        participants={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onShare={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.queryByText(/sleeps/)).not.toBeInTheDocument();
  });

  it('shows "never sleeps" when idleTtlMs is 0', () => {
    render(
      <ShellSessionHeader
        session={session()}
        meta={meta({ idleTtlMs: 0 } as Partial<SessionMeta>)}
        selectedId="s1"
        participants={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onShare={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("never sleeps")).toBeInTheDocument();
    expect(screen.getByTitle("This session never goes dormant on its own.")).toBeInTheDocument();
  });

  it("burn + positive idleTtlMs shows burn wording, not a sleep/dormancy claim", () => {
    render(
      <ShellSessionHeader
        session={session()}
        meta={meta({ burnAfterUse: true, idleTtlMs: 1_800_000 } as Partial<SessionMeta>)}
        selectedId="s1"
        participants={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onShare={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // The contradiction case: a burn session with a positive idle window used
    // to also render a "sleeps after 30m" chip right next to the burn pill,
    // even though the session is destroyed (not parked) at that window.
    expect(screen.getByText("burns after 30m")).toBeInTheDocument();
    expect(
      screen.getByTitle("This session deletes itself after 30 minutes of inactivity, instead of going dormant."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/sleeps/)).not.toBeInTheDocument();
    expect(screen.queryByText(/goes dormant/)).not.toBeInTheDocument();
  });

  it("burn + idleTtlMs: 0 states the true triggers instead of showing nothing", () => {
    render(
      <ShellSessionHeader
        session={session()}
        meta={meta({ burnAfterUse: true, idleTtlMs: 0 } as Partial<SessionMeta>)}
        selectedId="s1"
        participants={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onShare={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    // This session never burns from idleness alone (only ending it or a
    // sandbox restart takes it) — that's a true, important fact (it says WHEN
    // the data goes), so the chip states it instead of rendering nothing.
    expect(screen.queryByText("never sleeps")).not.toBeInTheDocument();
    expect(screen.queryByText(/sleeps/)).not.toBeInTheDocument();
    expect(screen.getByText("burns on end or restart")).toBeInTheDocument();
    expect(
      screen.getByTitle(
        "This session deletes itself when it's ended or the sandbox restarts, never from sitting idle.",
      ),
    ).toBeInTheDocument();
  });

  it("a sub-minute idle window reads as neither '0m' nor 'never'", () => {
    render(
      <ShellSessionHeader
        session={session()}
        meta={meta({ idleTtlMs: 15_000 } as Partial<SessionMeta>)}
        selectedId="s1"
        participants={[]}
        onSelect={vi.fn()}
        onRename={vi.fn()}
        onShare={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getByText("sleeps in under a minute")).toBeInTheDocument();
    expect(screen.queryByText(/0m/)).not.toBeInTheDocument();
    expect(screen.queryByText("never sleeps")).not.toBeInTheDocument();
  });
});
