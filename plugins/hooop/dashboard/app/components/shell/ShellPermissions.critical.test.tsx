import { vi, describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ShellPermissions } from "./ShellPermissions";
import type { PendingPermissionRequest } from "@/app/context/hooks/usePendingRequests";

/**
 * How a CRITICAL ask is drawn, on both sides of it.
 *
 * Every assertion here comes from watching the real thing: a guest typed
 * `!rm -rf` over a tunnel, the host got a card, and three of these were wrong on
 * screen even though the enforcement underneath was correct.
 */
let pending: PendingPermissionRequest[] = [];
const decide = vi.fn(async () => {});
vi.mock("@/app/context/hooks/usePendingRequests", () => ({
  usePendingRequests: () => ({ pending, decide, error: null }),
}));
vi.mock("@/app/context/SelectedSessionProvider", () => ({
  useSelectedSession: () => ({ selectedId: "sess-1" }),
}));
const setAutoMode = vi.fn(async () => {});
vi.mock("@/app/context/ActiveSessionProvider", () => ({
  useActiveSession: () => ({ meta: { autoMode: false }, setAutoMode }),
}));

let viewerIsPeer = false;
let canDecide = true;
vi.mock("../lib/participant", () => ({
  isPeerClient: () => viewerIsPeer,
  canDecidePermissions: () => canDecide,
  useMounted: () => true,
}));

const ask = (over: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest => ({
  requestId: "r1",
  toolUseId: null,
  toolName: "Bash",
  input: { command: "rm -rf /workspace" },
  decisionReason: "`!bash` shortcut from Ana — runs directly in the session, without the model",
  receivedAt: Date.now(),
  author: "Ana",
  ...over,
});

beforeEach(() => {
  viewerIsPeer = false;
  canDecide = true;
  decide.mockClear();
});

describe("the host's view of a critical ask", () => {
  it("shows the command WITHOUT a click", () => {
    // Seen live: the host was asked to approve a guest's `rm -rf` with the command
    // itself hidden behind "show input". On the one class of ask that is host-only
    // because it is dangerous, what is being approved must be on screen.
    pending = [ask({ critical: true })];
    render(<ShellPermissions />);
    expect(screen.getByText(/rm -rf \/workspace/)).toBeTruthy();
  });

  it("keeps a routine ask collapsed, as before", () => {
    pending = [ask({ critical: false, input: { file_path: "/w/notes.md" } })];
    render(<ShellPermissions />);
    expect(screen.queryByText(/\/w\/notes\.md/)).toBeNull();
    expect(screen.getByText("show input")).toBeTruthy();
  });

  it("offers no standing-permission shortcuts on a critical ask", () => {
    // Not because they would be unsafe — the critical set is excluded from every
    // unattended approval, so both are honoured correctly. They read as "stop
    // asking me", and the next `rm -rf` asks again.
    pending = [ask({ critical: true })];
    render(<ShellPermissions />);
    expect(screen.queryByText(/Allow all from/)).toBeNull();
    expect(screen.queryByText(/^Auto$/)).toBeNull();
    // The real decisions are still there.
    expect(screen.getByText("Allow once")).toBeTruthy();
    expect(screen.getByText("Deny")).toBeTruthy();
  });

  it("still offers them on a routine peer-driven ask", () => {
    pending = [ask({ critical: false })];
    render(<ShellPermissions />);
    expect(screen.getByText("Allow all from Ana")).toBeTruthy();
  });
});

describe("a full peer's view of a critical ask", () => {
  it("gets the waiting state and an explanation, not buttons", () => {
    // Their share says they may approve tool use; this one still isn't theirs, and
    // the card has to say which kind it is or the buttons merely vanished.
    viewerIsPeer = true;
    canDecide = true; // full capability
    pending = [ask({ critical: true })];
    render(<ShellPermissions />);
    expect(screen.getByText(/Waiting for the host to approve/)).toBeTruthy();
    // Matched on wording without an apostrophe: the copy uses a typographic one.
    expect(screen.getByText(/destructive commands, git, secrets/)).toBeTruthy();
    expect(screen.queryByText("Allow once")).toBeNull();
  });

  it("still decides the routine ask sitting next to it", () => {
    viewerIsPeer = true;
    canDecide = true;
    pending = [ask({ critical: false })];
    render(<ShellPermissions />);
    expect(screen.getByText("Allow once")).toBeTruthy();
  });

  it("shows both states at once when both asks are open", () => {
    // The reason this is per-request and not per-viewer.
    viewerIsPeer = true;
    canDecide = true;
    pending = [ask({ requestId: "danger", critical: true }), ask({ requestId: "routine" })];
    render(<ShellPermissions />);
    expect(screen.getByText(/Waiting for the host to approve/)).toBeTruthy();
    expect(screen.getByText("Allow once")).toBeTruthy();
  });
});
