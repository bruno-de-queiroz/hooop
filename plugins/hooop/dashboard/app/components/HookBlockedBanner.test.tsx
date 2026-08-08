import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { HookBlockedBanner } from "./HookBlockedBanner";

// Capture the SSE handlers HookBlockedBanner registers so each test can
// inject the exact event shape the sandbox would send. No real
// EventSource, no real SSE — just direct handler invocation.
let handlers: Record<string, (data: unknown) => void> = {};
vi.mock("./useSSE", () => ({
  useSSE: (h: Record<string, (data: unknown) => void>) => {
    handlers = h;
  },
}));

beforeEach(() => {
  handlers = {};
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("HookBlockedBanner", () => {
  it("renders nothing by default (no blocked prompt yet)", () => {
    const { container } = render(<HookBlockedBanner />);
    expect(container.textContent ?? "").toBe("");
    expect(screen.queryByTestId("hook-blocked-banner")).toBeNull();
  });

  it("appears when a session-error SSE event with kind=hook-blocked arrives", () => {
    render(<HookBlockedBanner />);
    act(() =>
      handlers["session-error"]({
        kind: "hook-blocked",
        sessionId: "uuid-1",
        message: "claude-mem worker unreachable for 4 consecutive hooks.",
      }),
    );
    expect(screen.getByTestId("hook-blocked-banner")).toBeInTheDocument();
    expect(screen.getByText(/wasn.t sent to claude/i)).toBeInTheDocument();
    expect(screen.getByText(/claude-mem worker unreachable/i)).toBeInTheDocument();
  });

  it("falls back to a generic message when none is provided", () => {
    render(<HookBlockedBanner />);
    act(() => handlers["session-error"]({ kind: "hook-blocked", sessionId: "uuid-1" }));
    expect(screen.getByText(/a plugin hook blocked your last message/i)).toBeInTheDocument();
  });

  it("ignores session-error events whose kind is NOT hook-blocked (e.g. auth failures)", () => {
    render(<HookBlockedBanner />);
    act(() => handlers["session-error"]({ kind: "auth", sessionId: "uuid-1", message: "..." }));
    expect(screen.queryByTestId("hook-blocked-banner")).toBeNull();
  });

  it("does NOT auto-clear on a later `event` SSE — the block already happened and is over", () => {
    render(<HookBlockedBanner />);
    act(() => handlers["session-error"]({ kind: "hook-blocked", message: "blocked" }));
    expect(screen.getByTestId("hook-blocked-banner")).toBeInTheDocument();

    act(() => handlers["event"]?.({ id: 1, hook_type: "PreToolUse" }));
    expect(screen.getByTestId("hook-blocked-banner")).toBeInTheDocument();
  });

  it("Dismiss button hides the banner", () => {
    render(<HookBlockedBanner />);
    act(() => handlers["session-error"]({ kind: "hook-blocked", message: "blocked" }));
    expect(screen.getByTestId("hook-blocked-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("hook-blocked-banner")).toBeNull();
  });

  it("re-shows after dismissal if another block arrives", () => {
    render(<HookBlockedBanner />);
    act(() => handlers["session-error"]({ kind: "hook-blocked", message: "first" }));
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("hook-blocked-banner")).toBeNull();

    act(() => handlers["session-error"]({ kind: "hook-blocked", message: "second" }));
    expect(screen.getByTestId("hook-blocked-banner")).toBeInTheDocument();
    expect(screen.getByText(/second/i)).toBeInTheDocument();
  });
});
