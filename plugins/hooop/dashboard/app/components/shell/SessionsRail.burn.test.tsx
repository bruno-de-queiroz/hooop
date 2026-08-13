import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionInfo } from "@/lib/types/session";

// The burn marker is the row's AVATAR, not a badge beside the label — so it is
// the rail's only carrier of "this session deletes itself". Lose it in a
// refactor and the list goes silent about the one row whose data is going away,
// which is exactly the regression these tests exist to catch.
// Provider mocking mirrors LeftRailCollapsed.test.tsx.

const sessionsState = vi.hoisted(() => ({ sessions: [] as SessionInfo[] }));
vi.mock("@/app/context/SessionsProvider", () => ({
  useSessions: () => ({
    sessions: sessionsState.sessions,
    deleteSession: vi.fn(),
    renameSession: vi.fn(),
  }),
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
vi.mock("./NeedsReviewRail", () => ({ NeedsReviewRail: () => null }));
vi.mock("./ConfirmDeleteSessionModal", () => ({ ConfirmDeleteSessionModal: () => null }));

import { SessionsRail } from "./SessionsRail";

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "f1",
    path: "/p/f1",
    mtime: new Date().toISOString(),
    size: 0,
    sessionId: "sid-1",
    displayName: "quiet-morning-fog",
    lifecycle: "alive",
    cwd: "/w/repo",
    ...over,
  };
}

beforeEach(() => {
  sessionsState.sessions = [];
});

describe("SessionsRail burn-after-use avatar", () => {
  it("gives a burn session the flame avatar", () => {
    sessionsState.sessions = [session({ burnAfterUse: true })];
    render(<SessionsRail />);
    expect(screen.getByLabelText("burns after use")).toBeTruthy();
  });

  it("marks a burn row exactly once (the flame is the avatar, not an extra badge)", () => {
    // The flame used to render BOTH as a glyph next to the label and (later) as
    // the avatar. Two flames on one row is the regression this pins.
    sessionsState.sessions = [session({ burnAfterUse: true })];
    render(<SessionsRail />);
    expect(screen.getAllByLabelText("burns after use")).toHaveLength(1);
  });

  it("leaves an ordinary session's initials avatar alone", () => {
    sessionsState.sessions = [session()];
    render(<SessionsRail />);
    expect(screen.queryByLabelText("burns after use")).toBeNull();
    // "quiet-morning-fog" -> "qm" (sessionInitials)
    expect(screen.getByText("qm")).toBeTruthy();
  });

  it("prefers the flame over the dormant moon, and still says the row is resumable", () => {
    // A burn session only reads "dormant" in the window between a sandbox
    // restart and the next boot destroying it. "About to delete itself" outranks
    // "asleep" for the avatar, but the dormant state must not vanish from the
    // row entirely — the preview line still carries it.
    sessionsState.sessions = [session({ burnAfterUse: true, lifecycle: "dormant" })];
    render(<SessionsRail />);
    expect(screen.getByLabelText("burns after use")).toBeTruthy();
    expect(screen.getByText(/resume · dormant/)).toBeTruthy();
  });
});
