import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { HostDevicesSection } from "./HostDevicesSection";

/**
 * The host's add-a-device flow, which is the one loop a person actually performs:
 * press the button, look at a QR, scan it, and expect the laptop to acknowledge.
 *
 * That last step is the part worth pinning. The code is single-use, so a QR left
 * on screen after it has been redeemed is not merely stale, it is misleading —
 * and the panel has no way to learn it was used except by asking.
 */
vi.mock("qrcode.react", () => ({
  // The real one renders an <svg> full of paths; a marker is enough to assert
  // "the QR is up" without pinning the encoder's output.
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid="qr" data-value={value} />,
}));

const TUNNEL = "https://abc123.trycloudflare.com";

interface Device {
  deviceId: string;
  label: string;
  publicHost: string;
  createdAt: number;
  expiresAt: number | null;
  revoked: boolean;
  lastSeenAt: number | null;
}

function device(id: string, label: string): Device {
  return {
    deviceId: id, label, publicHost: "abc123.trycloudflare.com",
    createdAt: 0, expiresAt: null, revoked: false, lastSeenAt: null,
  };
}

/** Devices the fake server currently holds; mutate to simulate a phone landing. */
let serverDevices: Device[] = [];
let mintCalls = 0;

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (url === "/api/host-device") {
    return new Response(JSON.stringify({ devices: serverDevices, thisDevice: null }), { status: 200 });
  }
  if (url === "/api/host-device/code" && init?.method === "POST") {
    mintCalls += 1;
    return new Response(JSON.stringify({
      code: "ABCDEFGH",
      expiresAt: Date.now() + 120_000,
      deviceTtlMs: 43_200_000,
      link: `${TUNNEL}/enroll#c=ABCDEFGH`,
    }), { status: 200 });
  }
  throw new Error(`unexpected fetch: ${url}`);
});

beforeEach(() => {
  serverDevices = [];
  mintCalls = 0;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Let queued promises settle inside act, so state from awaited fetches lands. */
async function settle() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe("HostDevicesSection", () => {
  it("shows the QR and the typeable code after minting", async () => {
    render(<HostDevicesSection publicBaseUrl={TUNNEL} enabled />);
    await settle();

    await act(async () => { screen.getByRole("button", { name: /add a device/i }).click(); });
    await settle();

    expect(mintCalls).toBe(1);
    expect(screen.getByTestId("qr").getAttribute("data-value")).toBe(`${TUNNEL}/enroll#c=ABCDEFGH`);
    // The code is shown as text too: a QR is useless on a device that is doing
    // the scanning, and it has to survive being typed by hand.
    expect(screen.getByText("ABCDEFGH")).toBeTruthy();
  });

  it("replaces the QR with a confirmation once the device actually lands", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HostDevicesSection publicBaseUrl={TUNNEL} enabled />);
    await settle();

    await act(async () => { screen.getByRole("button", { name: /add a device/i }).click(); });
    await settle();
    expect(screen.queryByTestId("qr")).toBeTruthy();

    // The phone redeems the code.
    serverDevices = [device("d1", "Pixel 8")];

    // The watcher polls every few seconds; give it a couple of ticks.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await settle();

    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Pixel 8");
    expect(screen.getByTitle("last seen")).toBeTruthy();
  });

  it("does not declare success off a stale list (baseline is read fresh)", async () => {
    // A device enrolled between opening the dialog and pressing the button must
    // not be mistaken for the one being added now — otherwise the panel
    // congratulates you before you have scanned anything.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HostDevicesSection publicBaseUrl={TUNNEL} enabled />);
    await settle();

    serverDevices = [device("d0", "Older phone")];

    await act(async () => { screen.getByRole("button", { name: /add a device/i }).click(); });
    await settle();

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await settle();

    // Still waiting: the QR is up and nothing claims to have been added.
    expect(screen.queryByTestId("qr")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("drops the QR when the code expires, rather than showing a dead one", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<HostDevicesSection publicBaseUrl={TUNNEL} enabled />);
    await settle();

    await act(async () => { screen.getByRole("button", { name: /add a device/i }).click(); });
    await settle();

    await act(async () => { await vi.advanceTimersByTimeAsync(121_000); });
    await settle();

    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByText(/that code expired/i)).toBeTruthy();
  });

  it("cannot be used with no tunnel to bind a device to", async () => {
    render(<HostDevicesSection publicBaseUrl={null} enabled={false} />);
    await settle();
    const btn = screen.getByRole("button", { name: /add a device/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(mintCalls).toBe(0);
  });
});
