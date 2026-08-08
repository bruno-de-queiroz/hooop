import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { NotificationsProvider, useNotifications } from "./NotificationsProvider";

/**
 * Enrolment state machine + mute bookkeeping. The service worker and PushManager
 * don't exist in jsdom, so they're stubbed onto navigator/window; what's under
 * test is our logic, not the browser's.
 */

const SUB = {
  endpoint: "https://push.example/abc",
  toJSON: () => ({ endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } }),
  unsubscribe: vi.fn(async () => true),
};

let getSubscription: ReturnType<typeof vi.fn>;
let subscribe: ReturnType<typeof vi.fn>;
let requestPermission: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

function stubBrowser(opts: { permission?: NotificationPermission; secure?: boolean; existing?: unknown } = {}) {
  getSubscription = vi.fn(async () => opts.existing ?? null);
  subscribe = vi.fn(async () => SUB);
  requestPermission = vi.fn(async () => opts.permission ?? "granted");

  const registration = { pushManager: { getSubscription, subscribe } };
  Object.defineProperty(window, "isSecureContext", { value: opts.secure ?? true, configurable: true });
  Object.defineProperty(navigator, "serviceWorker", {
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
    configurable: true,
  });
  Object.defineProperty(window, "PushManager", { value: function PushManager() {}, configurable: true });
  Object.defineProperty(window, "Notification", {
    value: Object.assign(function Notification() {}, {
      permission: opts.permission ?? "default",
      requestPermission,
    }),
    configurable: true,
  });
}

function Probe() {
  const n = useNotifications();
  return (
    <div>
      <span data-testid="state">{n.state}</span>
      <span data-testid="global">{String(n.globalMuted)}</span>
      <span data-testid="s1">{String(n.isMuted("s1"))}</span>
      <span data-testid="s2">{String(n.isMuted("s2"))}</span>
      <button onClick={() => void n.enable()}>enable</button>
      <button onClick={() => void n.disable()}>disable</button>
      <button onClick={() => void n.setSessionMuted("s2", true)}>mute-s2</button>
      <button onClick={() => void n.setGlobalMuted(true)}>mute-all</button>
    </div>
  );
}

function renderProbe() {
  return render(<NotificationsProvider><Probe /></NotificationsProvider>);
}

describe("NotificationsProvider", () => {
  beforeEach(() => {
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url === "/api/push/mute" && method === "GET") {
        return { ok: true, json: async () => ({ global: false, sessions: ["s1"] }) };
      }
      if (url === "/api/push/key") return { ok: true, json: async () => ({ publicKey: "aGVsbG8" }) };
      return { ok: true, json: async () => ({ ok: true }) };
    });
    vi.stubGlobal("fetch", fetchMock);
    // btoa/atob exist in jsdom; the VAPID key above is valid base64url.
    stubBrowser();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reports unsupported on an insecure origin", async () => {
    stubBrowser({ secure: false });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("unsupported"));
  });

  it("reports denied without prompting when the user already blocked us", async () => {
    stubBrowser({ permission: "denied" });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("denied"));
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it("starts off when supported but not yet subscribed", async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("off"));
  });

  it("starts on when a subscription already exists (survives reload)", async () => {
    stubBrowser({ existing: SUB });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("on"));
  });

  it("enrols: prompts, subscribes, and registers with the sandbox", async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("off"));

    await act(async () => { screen.getByText("enable").click(); });

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("on"));
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
    expect(fetchMock).toHaveBeenCalledWith("/api/push/subscribe", expect.objectContaining({ method: "POST" }));
  });

  it("stays off when the user dismisses the prompt", async () => {
    stubBrowser({ permission: "default" });
    requestPermission.mockResolvedValue("default");
    renderProbe();
    await act(async () => { screen.getByText("enable").click(); });
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("off"));
    expect(fetchMock).not.toHaveBeenCalledWith("/api/push/subscribe", expect.anything());
  });

  it("tells the sandbox before unsubscribing locally, so no dead endpoint is left behind", async () => {
    stubBrowser({ existing: SUB });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("on"));

    await act(async () => { screen.getByText("disable").click(); });

    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("off"));
    expect(fetchMock).toHaveBeenCalledWith("/api/push/subscribe", expect.objectContaining({ method: "DELETE" }));
    expect(SUB.unsubscribe).toHaveBeenCalled();
  });

  it("runs no keepalive of its own — suppression rides the presence heartbeat", async () => {
    // "Don't notify me about what I'm looking at" is decided from the existing
    // presence beat (usePresence → /api/presence → sandbox), not from a second
    // timer here. Two timers answering one question is how their timings drift
    // apart.
    stubBrowser({ existing: SUB });
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("state").textContent).toBe("on"));

    const urls = fetchMock.mock.calls.map((c: unknown[]) => c[0]);
    expect(urls).not.toContain("/api/push/viewing");
    expect(urls).not.toContain("/api/push/presence");
  });

  it("loads existing mutes for this viewer", async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("s1").textContent).toBe("true"));
    expect(screen.getByTestId("s2").textContent).toBe("false");
  });

  it("a global mute covers every session", async () => {
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("s1").textContent).toBe("true"));

    await act(async () => { screen.getByText("mute-all").click(); });

    await waitFor(() => expect(screen.getByTestId("global").textContent).toBe("true"));
    expect(screen.getByTestId("s2").textContent).toBe("true");
  });

  it("rolls back an optimistic mute when the write fails", async () => {
    // Otherwise the UI would claim a preference that was never saved, and the
    // next reload would silently contradict it.
    renderProbe();
    await waitFor(() => expect(screen.getByTestId("s2").textContent).toBe("false"));

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/api/push/mute" && init?.method === "POST") return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => ({ global: false, sessions: ["s1"] }) };
    });

    await act(async () => { screen.getByText("mute-s2").click(); });

    await waitFor(() => expect(screen.getByTestId("s2").textContent).toBe("false"));
  });
});
