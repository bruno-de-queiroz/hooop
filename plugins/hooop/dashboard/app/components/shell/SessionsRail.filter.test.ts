import { describe, it, expect } from "vitest";
import type { SessionInfo } from "@/lib/types/session";
import { isVisible } from "./SessionsRail";

function make(partial: Partial<SessionInfo>): SessionInfo {
  return {
    id: "row-1",
    path: "/x",
    mtime: new Date().toISOString(),
    size: 0,
    sessionId: "sid-1",
    lifecycle: "alive",
    ...partial,
  };
}

describe("SessionsRail isVisible", () => {
  it("shows a normal alive session", () => {
    expect(isVisible(make({ cwd: "/home/agent/workspace" }))).toBe(true);
  });

  it("shows resumable (dormant / ended) sessions", () => {
    expect(isVisible(make({ lifecycle: "dormant" }))).toBe(true);
    expect(isVisible(make({ lifecycle: "ended" }))).toBe(true);
  });

  it("hides expired and slot-less rows", () => {
    expect(isVisible(make({ lifecycle: "expired" }))).toBe(false);
    expect(isVisible(make({ sessionId: undefined }))).toBe(false);
  });

  // The point of the filter: claude-mem's observer plugin spawns background
  // sessions under ~/.claude-mem/observer-sessions. They must never appear in
  // the rail regardless of lifecycle.
  it("hides claude-mem observer sessions by cwd", () => {
    expect(
      isVisible(make({ cwd: "/home/agent/.claude-mem/observer-sessions/abc" })),
    ).toBe(false);
    // Even an ALIVE claude-mem session stays hidden.
    expect(
      isVisible(make({ lifecycle: "alive", cwd: "/home/agent/.claude-mem" })),
    ).toBe(false);
  });

  it("does not hide a normal session that merely mentions claude-mem elsewhere", () => {
    // A real workspace path containing the substring but not a .claude-mem dir
    // segment must still show (guards against an over-broad match).
    expect(isVisible(make({ cwd: "/home/agent/claude-mem-notes" }))).toBe(true);
  });
});
