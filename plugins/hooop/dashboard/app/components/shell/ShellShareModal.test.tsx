import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ShellShareModal } from "./ShellShareModal";

/**
 * The dialog's SHAPE, not its plumbing.
 *
 * It answers three questions in order — is the tunnel up, which of my devices are
 * on it, who else is in — and it previously mixed them: the tunnel sat inside a
 * column, the peer form was on one side with its own results on the other, and
 * devices were bolted to the bottom of the results column. Layout is easy to
 * undo by accident during an unrelated edit, so the order and the pairing are
 * asserted rather than left to the eye.
 */
vi.mock("qrcode.react", () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}));

const TUNNEL_URL = "https://abc123.trycloudflare.com";

let tunnelRunning = true;

const fetchMock = vi.fn(async (url: string) => {
  if (url === "/api/tunnel") {
    return new Response(JSON.stringify({
      status: tunnelRunning ? "running" : "stopped",
      url: tunnelRunning ? TUNNEL_URL : null,
      error: null,
    }), { status: 200 });
  }
  if (url === "/api/share") return new Response(JSON.stringify({ shares: [] }), { status: 200 });
  if (url === "/api/host-device") {
    return new Response(JSON.stringify({ devices: [], thisDevice: null }), { status: 200 });
  }
  throw new Error(`unexpected fetch: ${url}`);
});

beforeEach(() => {
  tunnelRunning = true;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => { vi.unstubAllGlobals(); });

async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

/** The bands of the scrolling body, in document order.
 *  Walk up from the tunnel heading: section-title → its band → the flex column. */
function bands(label = "Public tunnel"): HTMLElement[] {
  const body = screen.getByText(label).parentElement!.parentElement!;
  return [...body.children] as HTMLElement[];
}

describe("ShellShareModal layout", () => {
  it("puts the tunnel on top, spanning the width", async () => {
    render(<ShellShareModal open sessionId="sess-1" onClose={() => {}} />);
    await settle();

    const [first] = bands();
    expect(first.textContent).toContain("Public tunnel");
    expect(first.textContent).toContain(TUNNEL_URL);
    // Not inside a column: the band is a direct child of the body, and the grid
    // that holds the two audiences is a LATER sibling.
    expect(first.className).not.toContain("grid-cols");
  });

  it("pairs devices and peers as two columns below it", async () => {
    render(<ShellShareModal open sessionId="sess-1" onClose={() => {}} />);
    await settle();

    const grid = bands()[1];
    expect(grid.className).toContain("sm:grid-cols-2");
    const [left, right] = [...grid.children] as HTMLElement[];
    // Left is mine, right is other people's. Adjacent on purpose: the whole point
    // is that one column is you and the other is not.
    expect(left.textContent).toContain("Your devices");
    expect(right.textContent).toContain("Peers");
    expect(right.textContent).toContain("Create share link");
  });

  it("keeps the peer form and its results in the SAME column", async () => {
    // They used to face each other across the dialog, so creating a link made
    // something appear on the far side of the screen.
    render(<ShellShareModal open sessionId="sess-1" onClose={() => {}} />);
    await settle();

    const right = [...bands()[1].children][1] as HTMLElement;
    expect(right.textContent).toContain("Suggested name");
    expect(right.textContent).toContain("Capability");
  });

  it("shows the start control, and no URL, while the tunnel is off", async () => {
    tunnelRunning = false;
    render(<ShellShareModal open sessionId="sess-1" onClose={() => {}} />);
    await settle();

    expect(screen.getByText("tunnel is off")).toBeTruthy();
    expect(screen.getByRole("button", { name: /start tunnel/i })).toBeTruthy();
    // Devices are bound to the tunnel, so adding one is refused until it is up.
    const addDevice = screen.getByRole("button", { name: /add a device/i }) as HTMLButtonElement;
    expect(addDevice.disabled).toBe(true);
  });

  it("drops the devices column entirely for a peer", async () => {
    // A guest cannot enroll devices — that would hand out host authority from a
    // guest seat — so the column would be a dead end rather than a disabled one.
    render(<ShellShareModal open sessionId="sess-1" onClose={() => {}} peerMode />);
    await settle();

    expect(screen.queryByText(/your devices/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /add a device/i })).toBeNull();
    // And the peers column takes the full width rather than leaving a hole.
    const grid = bands("Public URL")[1];
    expect(grid.className).not.toContain("sm:grid-cols-2");
    // A peer never sees host tunnel controls.
    expect(screen.queryByRole("button", { name: /start tunnel/i })).toBeNull();
  });
});
