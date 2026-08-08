import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionInfo } from "@/lib/types/session";

const sessionsState = vi.hoisted(() => ({ sessions: [] as SessionInfo[] }));
vi.mock("@/app/context/SessionsProvider", () => ({
  useSessions: () => ({ sessions: sessionsState.sessions }),
}));
vi.mock("@/app/context/SelectedSessionProvider", () => ({
  useSelectedSession: () => ({ selectedId: null, setSelected: vi.fn() }),
}));
vi.mock("@/app/context/hooks/useUnseenSessions", () => ({
  useUnseenSessions: () => () => false,
}));
vi.mock("./ShellChrome", () => ({
  usePlanReview: () => ({ plans: [], open: null }),
}));
vi.mock("./NeedsReviewRail", () => ({
  NeedsReviewRail: () => null,
}));
vi.mock("./IdentityFooter", () => ({
  IdentityFooter: () => null,
}));

const participant = vi.hoisted(() => ({
  mounted: true,
  name: "Ana",
  cap: "drive" as "full" | "drive" | "spectate" | null,
}));
vi.mock("../lib/participant", () => ({
  useMounted: () => participant.mounted,
  myDisplayName: () => participant.name,
  peerCapability: () => participant.cap,
  CAPABILITY_LABEL: { full: "Full co-drive", drive: "Drive", spectate: "Spectate" },
}));

import { LeftRailCollapsed } from "./LeftRailCollapsed";

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    sessionId: "s1",
    id: "s1",
    startedAt: 0,
    lifecycle: "alive",
    ...over,
  } as SessionInfo;
}

beforeEach(() => {
  sessionsState.sessions = [];
  participant.mounted = true;
  participant.name = "Ana";
  participant.cap = "drive";
});

describe("LeftRailCollapsed", () => {
  it("shows dormant sessions alongside active ones, not just the alive ones", () => {
    // Was filtered to lifecycle === "alive" only, so a resumable session
    // reachable from the expanded rail simply vanished on collapse.
    sessionsState.sessions = [
      session({ sessionId: "a1", id: "a1", lifecycle: "alive" }),
      session({ sessionId: "d1", id: "d1", lifecycle: "dormant" }),
    ];
    render(<LeftRailCollapsed isPeer={false} onNew={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByRole("button", { name: "a1" })).toBeInTheDocument();
    const dormantButton = screen.getByRole("button", { name: "d1" });
    expect(dormantButton).toBeInTheDocument();
    expect(dormantButton).toHaveAttribute("title", expect.stringContaining("resume"));
  });

  it("hides expired sessions in the collapsed strip too", () => {
    sessionsState.sessions = [session({ sessionId: "e1", id: "e1", lifecycle: "expired" })];
    render(<LeftRailCollapsed isPeer={false} onNew={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "e1" })).not.toBeInTheDocument();
  });

  it("shows a peer's name and share capability instead of an empty strip", () => {
    render(<LeftRailCollapsed isPeer onNew={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByTitle("Ana · Drive")).toBeInTheDocument();
    expect(screen.getByLabelText("Drive")).toBeInTheDocument();
  });

  it("does not claim a capability before the client has mounted", () => {
    // useMounted() gates sessionStorage/meta reads to avoid a hydration
    // mismatch — the first client render must match the server's.
    participant.mounted = false;
    render(<LeftRailCollapsed isPeer onNew={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.getByTitle("Guest")).toBeInTheDocument();
    expect(screen.queryByLabelText("Drive")).not.toBeInTheDocument();
  });
});
