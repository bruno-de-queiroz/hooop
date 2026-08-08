import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { PreviewRecord } from "@/lib/sandbox-types";

const capability = vi.hoisted(() => ({ mayAct: true }));
vi.mock("@/app/components/lib/participant", () => ({
  canDecidePermissions: () => capability.mayAct,
}));

const ui = vi.hoisted(() => ({
  value: null as unknown,
  viewerLink: vi.fn(),
  act: vi.fn(),
  share: vi.fn(),
  unshare: vi.fn(),
  takeControl: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("@/app/context/PreviewUIProvider", () => ({
  usePreviewUI: () => ui.value,
}));
vi.mock("@/app/context/ActiveSessionProvider", () => ({
  useActiveSession: () => ({ stop: ui.stop }),
}));

import { ShellPreviewPanel } from "./ShellPreviewDock";

function preview(over: Partial<PreviewRecord> = {}): PreviewRecord {
  return {
    previewId: "pv-1",
    sessionId: "sess-a",
    slot: 1,
    spec: { name: "web", run: "npm run dev", setup: ["npm ci"] },
    workdir: "/home/agent/workspace/sessions/sess-a",
    appPort: 20001,
    slotPort: 7850,
    state: "running",
    phase: { kind: "run" },
    failedStep: null,
    failureReason: null,
    publicUrl: null,
    createdAt: 0,
    ...over,
  } as PreviewRecord;
}

function setUI(over: Record<string, unknown> = {}) {
  ui.value = {
    preview: preview(),
    slots: { total: 3, used: 1 },
    available: true,
    loading: false,
    actionError: null,
    open: true,
    setOpen: vi.fn(),
    logs: [],
    logsLoading: false,
    loadLogs: vi.fn(),
    refresh: vi.fn(),
    act: ui.act,
    share: ui.share,
    unshare: ui.unshare,
    viewerLink: ui.viewerLink,
    publicTunnelGaveUp: false,
    driving: false,
    takeControl: ui.takeControl,
    ...over,
  };
}

beforeEach(() => {
  capability.mayAct = true;
  ui.viewerLink.mockReset().mockResolvedValue({
    url: "http://127.0.0.1:7850/__hooop/preview-auth#tok",
    origin: "http://127.0.0.1:7850",
  });
  ui.act.mockReset();
  ui.share.mockReset();
  ui.unshare.mockReset();
  ui.takeControl.mockReset();
  ui.stop.mockReset();
  setUI();
});

describe("ShellPreviewPanel", () => {
  it("loads the app in an iframe pointed at the SERVER-MINTED redemption url", async () => {
    // Never a hand-built origin: the grant redemption is what authorizes the
    // separate origin the preview lives on.
    render(<ShellPreviewPanel />);
    const frame = await screen.findByTitle("Preview: web");
    expect(frame).toHaveAttribute("src", "http://127.0.0.1:7850/__hooop/preview-auth#tok");
  });

  // Visibility moved OUT of this component. The browser is a rail section now
  // (Details | Files | Browser), so the rail decides whether to render it at all
  // and the panel no longer carries an `open` flag of its own — which is what
  // stopped it from having to evict the docked file preview to be seen.
  it("renders its content whenever mounted — the rail owns visibility", () => {
    setUI({});
    const { container } = render(<ShellPreviewPanel />);
    expect(container).not.toBeEmptyDOMElement();
  });

  it("shows the running step while starting, instead of a blank frame", () => {
    setUI({ preview: preview({ state: "starting", phase: { kind: "setup", index: 0, command: "npm ci" } }) });
    render(<ShellPreviewPanel />);
    expect(screen.getByText(/Running setup 1\/1/)).toBeInTheDocument();
    // The command shows in the status area AND in the spec list below it; the
    // status one is the <code> element.
    expect(screen.getAllByText("npm ci").some((el) => el.tagName === "CODE")).toBe(true);
  });

  it("surfaces the failure reason rather than an empty panel", () => {
    setUI({
      preview: preview({ state: "failed", failedStep: 0, failureReason: "setup step 1 exited 1" }),
    });
    render(<ShellPreviewPanel />);
    expect(screen.getByText("Preview failed")).toBeInTheDocument();
    expect(screen.getByText("setup step 1 exited 1")).toBeInTheDocument();
  });

  it("shows the spec, so whoever shares it can see what will be published", () => {
    render(<ShellPreviewPanel />);
    expect(screen.getAllByText("npm ci").length).toBeGreaterThan(0);
    expect(screen.getAllByText("npm run dev").length).toBeGreaterThan(0);
  });

  describe("capability gating", () => {
    it("enables the controls for a decider", () => {
      render(<ShellPreviewPanel />);
      expect(screen.getByRole("button", { name: /Rebuild/ })).toBeEnabled();
      expect(screen.getByRole("button", { name: /Share/ })).toBeEnabled();
    });

    it("disables every mutating control for a view-only participant", () => {
      // A spectate/drive peer can watch the preview but must not stop, rebuild
      // or publish it — the sandbox enforces this too; this is the UI half.
      capability.mayAct = false;
      render(<ShellPreviewPanel />);
      for (const name of [/Restart/, /Rebuild/, /Stop/, /Share/]) {
        expect(screen.getByRole("button", { name })).toBeDisabled();
      }
      expect(screen.getByText("view only")).toBeInTheDocument();
    });
  });

  it("offers Unshare once a preview has a public url", () => {
    setUI({ preview: preview({ state: "shared", publicUrl: "https://x.trycloudflare.com" }) });
    render(<ShellPreviewPanel />);
    expect(screen.getByRole("button", { name: /Unshare/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Share/ })).not.toBeInTheDocument();
  });

  it("cannot share a preview that is not up yet", () => {
    setUI({ preview: preview({ state: "starting" }) });
    render(<ShellPreviewPanel />);
    expect(screen.getByRole("button", { name: /Share/ })).toBeDisabled();
  });

  it("wires the actions through to the provider", async () => {
    render(<ShellPreviewPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Rebuild/ }));
    await waitFor(() => expect(ui.act).toHaveBeenCalledWith("rebuild"));
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));
    await waitFor(() => expect(ui.act).toHaveBeenCalledWith("stop"));
  });

  it("mints a grant once per preview, not once per poll", async () => {
    // The provider replaces the preview OBJECT on every poll. Re-minting on
    // each one would reload the iframe every few seconds and throw away
    // whatever state the app was in.
    const { rerender } = render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    expect(ui.viewerLink).toHaveBeenCalledTimes(1);

    setUI({ preview: preview() }); // same ids, fresh object — a poll tick
    rerender(<ShellPreviewPanel />);
    await waitFor(() => expect(ui.viewerLink).toHaveBeenCalledTimes(1));
  });

  it("re-mints when the preview becomes shared, so the peer url is used", async () => {
    const { rerender } = render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    ui.viewerLink.mockResolvedValue({
      url: "https://x.trycloudflare.com/__hooop/preview-auth#tok2",
      origin: "https://x.trycloudflare.com",
    });
    setUI({ preview: preview({ state: "shared", publicUrl: "https://x.trycloudflare.com" }) });
    rerender(<ShellPreviewPanel />);
    await waitFor(() =>
      expect(screen.getByTitle("Preview: web")).toHaveAttribute(
        "src", "https://x.trycloudflare.com/__hooop/preview-auth#tok2",
      ),
    );
  });

  it("explains itself when a grant cannot be minted", async () => {
    ui.viewerLink.mockResolvedValue(null);
    render(<ShellPreviewPanel />);
    expect(await screen.findByText("Could not get access to this preview.")).toBeInTheDocument();
  });

  describe("refresh", () => {
    it("reloads the frame without minting a new grant", async () => {
      // Redemption is idempotent, so a plain reload of the same url needs no
      // round trip to viewerLink — only Restart/Rebuild/Share touch the provider.
      render(<ShellPreviewPanel />);
      const before = await screen.findByTitle("Preview: web");
      fireEvent.click(screen.getByRole("button", { name: /Refresh/ }));
      await waitFor(() => expect(screen.getByTitle("Preview: web")).not.toBe(before));
      expect(screen.getByTitle("Preview: web")).toHaveAttribute(
        "src", "http://127.0.0.1:7850/__hooop/preview-auth#tok",
      );
      expect(ui.viewerLink).toHaveBeenCalledTimes(1);
      expect(ui.act).not.toHaveBeenCalled();
    });

    it("stays usable for a view-only participant, unlike the process controls", async () => {
      // Reloading your own frame changes nothing for anyone else, so it isn't
      // gated behind the same capability check as Restart/Rebuild/Stop/Share.
      capability.mayAct = false;
      render(<ShellPreviewPanel />);
      await screen.findByTitle("Preview: web");
      expect(screen.getByRole("button", { name: /Refresh/ })).toBeEnabled();
    });

    it("disables itself when there is no frame to reload", () => {
      setUI({ preview: preview({ state: "starting" }) });
      render(<ShellPreviewPanel />);
      expect(screen.getByRole("button", { name: /Refresh/ })).toBeDisabled();
    });
  });
});

/**
 * The overlay is the only thing standing between two actors clicking the same
 * stateful app. If it fails open, a human and the model race; if it fails shut,
 * the page is unusable. Both directions are pinned here.
 */
/**
 * On a phone the rail does not exist, so the overlay supplies the only bar there
 * is room for. The panel repeating it cost the app a fifth of the screen — two
 * headers, a spec block and a wrapped grid of buttons around a letterbox of the
 * actual application.
 */
describe("a shared link that never came up", () => {
  it("asks for patience only while the answer can still change", async () => {
    setUI({ preview: preview({ state: "shared", publicUrl: "https://x.trycloudflare.com" }), publicReachable: false });
    render(<ShellPreviewPanel />);
    expect(await screen.findByText(/still coming up/)).toBeInTheDocument();
  });

  it("says it is not coming once we have stopped waiting", async () => {
    // The same `reachable: false` used to mean both, so the panel promised a
    // link for hours that was never arriving — and anyone who opened it got a
    // blank window with nothing to explain why.
    setUI({
      preview: preview({ state: "shared", publicUrl: "https://x.trycloudflare.com" }),
      publicReachable: false, publicTunnelGaveUp: true,
    });
    render(<ShellPreviewPanel />);
    expect(await screen.findByText(/never came up/)).toBeInTheDocument();
    expect(screen.queryByText(/still coming up/)).toBeNull();
  });

  it("names the likely cause and what to do, not just the failure", async () => {
    setUI({
      preview: preview({ state: "shared", publicUrl: "https://x.trycloudflare.com" }),
      publicReachable: false, publicTunnelGaveUp: true,
    });
    render(<ShellPreviewPanel />);
    const msg = await screen.findByText(/never came up/);
    expect(msg.textContent).toMatch(/network or VPN/);
    expect(msg.textContent).toMatch(/Unshare and Share again/);
  });

  it("says neither once the link is actually serving", async () => {
    setUI({ preview: preview({ state: "shared", publicUrl: "https://x.trycloudflare.com" }), publicReachable: true });
    render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    expect(screen.queryByText(/still coming up/)).toBeNull();
    expect(screen.queryByText(/never came up/)).toBeNull();
  });
});

describe("the preview on a phone", () => {
  it("drops its own header, which the overlay already provides", async () => {
    setUI({});
    const { rerender } = render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    expect(screen.getAllByText("web").length).toBeGreaterThan(0);

    rerender(<ShellPreviewPanel immersive />);
    await screen.findByTitle("Preview: web");
    expect(screen.queryByText("web")).toBeNull();
  });

  it("hides the spec, which is reference material", async () => {
    setUI({});
    render(<ShellPreviewPanel immersive />);
    await screen.findByTitle("Preview: web");
    expect(screen.getByText("Spec").closest("details")).toHaveClass("hidden");
  });

  it("keeps the controls, on one row that scrolls rather than three that wrap", async () => {
    // Restart and Stop are not optional on a phone just because it is small.
    setUI({});
    render(<ShellPreviewPanel immersive />);
    await screen.findByTitle("Preview: web");
    for (const label of ["Restart", "Rebuild", "Stop"]) {
      expect(screen.getByTitle(label)).toBeInTheDocument();
    }
    const footer = screen.getByTitle("Restart").closest("footer")!;
    expect(footer.className).toContain("overflow-x-auto");
    expect(footer.className).not.toContain("flex-wrap");
  });

  it("still offers a way into a real tab, which the header used to carry", async () => {
    setUI({});
    render(<ShellPreviewPanel immersive />);
    await screen.findByTitle("Preview: web");
    expect(screen.getByLabelText("Open in a new tab")).toBeInTheDocument();
  });

  it("changes nothing on a desktop", async () => {
    setUI({});
    render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    expect(screen.getByText("Spec").closest("details")).not.toHaveClass("hidden");
    expect(screen.getByTitle("Restart").closest("footer")!.className).toContain("flex-wrap");
  });
});

describe("while the agent is driving the page", () => {
  it("shows nothing over the frame when the agent is not driving", async () => {
    render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    expect(screen.queryByTestId("preview-driving-overlay")).toBeNull();
  });

  it("covers the frame and says who has it", async () => {
    setUI({ driving: true });
    render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    const overlay = screen.getByTestId("preview-driving-overlay");
    expect(overlay).toHaveTextContent("The agent is using this page");
    expect(overlay).toHaveTextContent("Click to take control");
  });

  it("stops covering this window once its viewer has taken control", async () => {
    // The bug a multi-peer session produced: "the agent is acting" is broadcast
    // to the whole SESSION, but the agent only drives FOLLOWING pages. A viewer
    // who had taken control still got "the agent is using this page" over their
    // own window every time it drove somebody else's.
    setUI({ driving: true });
    render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    expect(screen.getByTestId("preview-driving-overlay")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("preview-driving-overlay"));
    expect(ui.takeControl).toHaveBeenCalledTimes(1);
  });

  it("hands the page over without stopping the turn from here", async () => {
    // Whether the agent should STOP depends on how many viewers are still
    // following, which only the server knows — and it has to cover the other way
    // of taking over, clicking inside the frame, which this component never sees.
    // So the server interrupts when the last follower leaves, and one of five
    // people reaching in no longer halts the run for the other four.
    setUI({ driving: true });
    render(<ShellPreviewPanel />);
    await screen.findByTitle("Preview: web");
    fireEvent.click(screen.getByTestId("preview-driving-overlay"));

    expect(ui.takeControl).toHaveBeenCalledTimes(1);
    expect(ui.stop).not.toHaveBeenCalled();
  });

  it("tells the frame it has been taken over, since the overlay ate the click", async () => {
    // The overlay covers the iframe, so the click never reaches the page — which
    // means taking control used to hide the overlay and nothing else: the copy
    // stayed in the fan-out and the agent kept driving it.
    setUI({ driving: true });
    render(<ShellPreviewPanel />);
    const frame = await screen.findByTitle("Preview: web") as HTMLIFrameElement;
    const postMessage = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { postMessage }, configurable: true });

    fireEvent.click(screen.getByTestId("preview-driving-overlay"));
    expect(postMessage).toHaveBeenCalledWith(
      { source: "hooop-preview-panel", type: "take-control" }, "*");
  });

  it("is not shown when there is no frame to cover", () => {
    // A starting or failed preview has no iframe; an overlay over the status
    // text would block the one thing worth reading.
    setUI({ driving: true, preview: preview({ state: "starting", phase: { kind: "setup", index: 0 } }) });
    render(<ShellPreviewPanel />);
    expect(screen.queryByTestId("preview-driving-overlay")).toBeNull();
  });
});
