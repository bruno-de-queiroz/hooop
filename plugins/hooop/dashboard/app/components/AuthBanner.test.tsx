import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { AuthBanner } from "./AuthBanner";

// Capture the SSE handlers that AuthBanner registers so each test can
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
  // Clipboard API needs an explicit polyfill in jsdom.
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AuthBanner", () => {
  it("renders nothing by default (no auth failure yet)", () => {
    const { container } = render(<AuthBanner />);
    expect(container.textContent ?? "").toBe("");
    expect(screen.queryByTestId("auth-banner")).toBeNull();
  });

  it("appears when a session-error SSE event with kind=auth arrives", () => {
    render(<AuthBanner />);
    act(() => handlers["session-error"]({ kind: "auth", sessionId: "uuid-1", message: "..." }));
    expect(screen.getByTestId("auth-banner")).toBeInTheDocument();
    expect(screen.getByText(/sandbox lost authentication/i)).toBeInTheDocument();
    // The recovery command is rendered inline so the user can read it
    // without copying.
    expect(screen.getByText("hooop login")).toBeInTheDocument();
  });

  it("ignores session-error events whose kind is NOT auth (e.g. spawn failures)", () => {
    render(<AuthBanner />);
    act(() => handlers["session-error"]({ kind: "spawn", sessionId: "uuid-1", message: "fork failed" }));
    expect(screen.queryByTestId("auth-banner")).toBeNull();
  });

  it("auto-clears on the first successful `event` SSE after the failure", () => {
    render(<AuthBanner />);
    act(() => handlers["session-error"]({ kind: "auth", sessionId: "uuid-1" }));
    expect(screen.getByTestId("auth-banner")).toBeInTheDocument();

    // Any subsequent event (PreToolUse, Stop, etc.) means the sandbox is
    // talking to Anthropic again → clear the banner.
    act(() => handlers["event"]({ id: 1, hook_type: "PreToolUse", session_id: "uuid-2" }));
    expect(screen.queryByTestId("auth-banner")).toBeNull();
  });

  it("does NOT re-render setShown(false) when there's no banner shown (no-op path)", () => {
    // Regression guard: the `event` handler's `setShown((s) => (s ? false : s))`
    // form is important — passing `setShown(false)` unconditionally would
    // create a render every event even when nothing is shown, which on a
    // busy session would mean dozens of needless reconciliations per turn.
    render(<AuthBanner />);
    act(() => {
      for (let i = 0; i < 5; i++) handlers["event"]({ id: i });
    });
    expect(screen.queryByTestId("auth-banner")).toBeNull();
  });

  it("Copy button writes `hooop login` to the clipboard", async () => {
    render(<AuthBanner />);
    act(() => handlers["session-error"]({ kind: "auth" }));
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hooop login");
  });

  it("Dismiss button hides the banner without a successful event", () => {
    render(<AuthBanner />);
    act(() => handlers["session-error"]({ kind: "auth" }));
    expect(screen.getByTestId("auth-banner")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("auth-banner")).toBeNull();
  });

  it("re-shows after dismissal if another auth failure arrives", () => {
    render(<AuthBanner />);
    act(() => handlers["session-error"]({ kind: "auth" }));
    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(screen.queryByTestId("auth-banner")).toBeNull();

    // A second auth failure (e.g. user dismissed before fixing) should
    // bring the banner back rather than stay dismissed forever.
    act(() => handlers["session-error"]({ kind: "auth" }));
    expect(screen.getByTestId("auth-banner")).toBeInTheDocument();
  });
});
