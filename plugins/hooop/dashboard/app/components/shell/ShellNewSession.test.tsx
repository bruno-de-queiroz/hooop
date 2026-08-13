import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

type CreateOpts = {
  name?: string;
  model?: string;
  gitRepo?: string;
  idleTtlMs?: number;
  burnAfterUse?: boolean;
};
const createSession = vi.fn(async (_opts: CreateOpts) => ({ sessionId: "new-1" }));
vi.mock("@/app/context/SessionsProvider", () => ({
  useSessions: () => ({ createSession }),
}));

import { ShellNewSession } from "./ShellNewSession";

beforeEach(() => {
  createSession.mockClear();
});

describe("ShellNewSession", () => {
  it("renders the dormancy select and the burn checkbox", () => {
    render(<ShellNewSession />);
    expect(screen.getByText("goes dormant after")).toBeInTheDocument();
    expect(screen.getByText("burn after use")).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("burn helper copy claims an idle trigger for a positive/default dormancy", () => {
    render(<ShellNewSession />);
    expect(
      screen.getByText(
        "This session deletes its transcript, workspace, events, and share links when its idle window is up, when you end it, or if the sandbox restarts, instead of going dormant.",
      ),
    ).toBeInTheDocument();
  });

  it('burn helper copy drops the idle trigger when dormancy is "never"', () => {
    // Pinning this: the base copy used to unconditionally claim an idle-window
    // trigger and a second line then contradicted it for "never" dormancy —
    // a reader who stopped at the first sentence was misinformed for exactly
    // the combination the second line existed to fix.
    render(<ShellNewSession />);
    const selects = screen.getAllByRole("combobox");
    const dormancySelect = selects[1]; // model select is first, dormancy second
    fireEvent.change(dormancySelect, { target: { value: "never" } });
    expect(
      screen.getByText(
        "This session deletes its transcript, workspace, events, and share links when you end it or if the sandbox restarts, instead of going dormant.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/idle window/)).not.toBeInTheDocument();
  });

  it("submitting with defaults never sends idleTtlMs: 0 (that means 'never')", async () => {
    render(<ShellNewSession />);
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(createSession).toHaveBeenCalledOnce();
    const opts = createSession.mock.calls[0][0];
    expect(opts.idleTtlMs).not.toBe(0);
    expect(opts.idleTtlMs).toBeUndefined();
    expect(opts.burnAfterUse).toBe(false);
  });

  it("submitting with 'never' dormancy sends idleTtlMs: 0 (not undefined)", async () => {
    // Pinning this: an adversarial mutation of DORMANCY_MS (never: 0 ->
    // never: undefined) previously slipped past every existing test, which
    // would silently fall back to the install default while the UI still
    // showed "never" selected.
    render(<ShellNewSession />);
    const selects = screen.getAllByRole("combobox");
    const dormancySelect = selects[1]; // model select is first, dormancy second
    fireEvent.change(dormancySelect, { target: { value: "never" } });
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(createSession).toHaveBeenCalledOnce();
    const opts = createSession.mock.calls[0][0];
    expect(opts.idleTtlMs).toBe(0);
  });

  it("submitting with 5m dormancy + burn checked sends idleTtlMs: 300000, burnAfterUse: true", async () => {
    render(<ShellNewSession />);
    const selects = screen.getAllByRole("combobox");
    const dormancySelect = selects[1]; // model select is first, dormancy second
    fireEvent.change(dormancySelect, { target: { value: "5m" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Create session" }));
    expect(createSession).toHaveBeenCalledOnce();
    const opts = createSession.mock.calls[0][0];
    expect(opts.idleTtlMs).toBe(300_000);
    expect(opts.burnAfterUse).toBe(true);
  });

  it("Enter inside a text field still submits with the new controls present", async () => {
    render(<ShellNewSession />);
    const nameInput = screen.getByPlaceholderText("random haiku name if blank");
    fireEvent.change(nameInput, { target: { value: "my-session" } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
    expect(createSession).toHaveBeenCalledOnce();
    const opts = createSession.mock.calls[0][0];
    expect(opts.name).toBe("my-session");
  });

  it("Enter is not wired to the checkbox (Space toggles it, not Enter-to-submit)", () => {
    render(<ShellNewSession />);
    const checkbox = screen.getByRole("checkbox");
    fireEvent.keyDown(checkbox, { key: "Enter" });
    expect(createSession).not.toHaveBeenCalled();
  });
});
