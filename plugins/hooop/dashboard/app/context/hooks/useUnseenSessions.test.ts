import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import type { SessionInfo } from "@/lib/types/session";
import { useUnseenSessions } from "./useUnseenSessions";

function sess(id: string, updatedAt: number): SessionInfo {
  return { id, path: `/${id}`, mtime: "2026-07-15T00:00:00.000Z", size: 0, sessionId: id, updatedAt };
}

describe("useUnseenSessions", () => {
  it("seeds the initial list as seen (nothing flagged on load)", () => {
    const sessions = [sess("a", 100), sess("b", 100)];
    const { result } = renderHook(() => useUnseenSessions(sessions, null));
    expect(result.current(sessions[0])).toBe(false);
    expect(result.current(sessions[1])).toBe(false);
  });

  it("flags a session that gains newer activity after mount", () => {
    const { result, rerender } = renderHook(
      ({ s, sel }: { s: SessionInfo[]; sel: string | null }) => useUnseenSessions(s, sel),
      { initialProps: { s: [sess("a", 100), sess("b", 100)], sel: "a" } },
    );
    // b gets a new turn while "a" is open.
    const next = [sess("a", 100), sess("b", 200)];
    rerender({ s: next, sel: "a" });
    expect(result.current(next[1])).toBe(true); // b is unseen
    expect(result.current(next[0])).toBe(false); // a is the open one
  });

  it("never flags the open session, even with new activity", () => {
    const { result, rerender } = renderHook(
      ({ s, sel }: { s: SessionInfo[]; sel: string | null }) => useUnseenSessions(s, sel),
      { initialProps: { s: [sess("a", 100)], sel: "a" } },
    );
    const next = [sess("a", 500)];
    rerender({ s: next, sel: "a" });
    expect(result.current(next[0])).toBe(false);
  });

  it("clears the flag once the session is opened", () => {
    const { result, rerender } = renderHook(
      ({ s, sel }: { s: SessionInfo[]; sel: string | null }) => useUnseenSessions(s, sel),
      { initialProps: { s: [sess("a", 100), sess("b", 100)], sel: "a" } },
    );
    const bumped = [sess("a", 100), sess("b", 200)];
    rerender({ s: bumped, sel: "a" });
    expect(result.current(bumped[1])).toBe(true);
    // Open b → it should no longer be flagged.
    rerender({ s: bumped, sel: "b" });
    expect(result.current(bumped[1])).toBe(false);
  });
});
