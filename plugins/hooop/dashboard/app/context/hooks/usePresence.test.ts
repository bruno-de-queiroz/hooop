import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * What `active` means on the wire — and it is load-bearing far from here.
 *
 * The sandbox skips notifying anyone it believes is watching a session
 * (push.ts's isWatching). This heartbeat is the only thing that tells it who
 * that is, so being too generous with `active` does not merely dim an avatar:
 * it silently disables push. That is what happened with an installed PWA left
 * open behind other windows — `visibilityState` stays "visible" indefinitely,
 * so notifications never arrived and minimising the app was the only cure.
 */

vi.mock("@/app/components/useSSE", () => ({ useSSE: () => {} }));
vi.mock("@/app/components/lib/participant", () => ({
  myDisplayName: () => "Bruno",
  // Fixed rather than random: the beat carries it verbatim, so a stable value
  // keeps the body assertions below readable.
  viewerId: () => "tab-a",
}));

import { usePresence } from "./usePresence";

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

/** The `active` flag from the most recent presence POST. */
function lastActive(): boolean | undefined {
  const calls = fetchMock.mock.calls.filter((c: any) => String(c[0]).includes("/api/presence"));
  const last = calls[calls.length - 1] as any;
  if (!last) return undefined;
  return JSON.parse(last[1].body).active;
}

let focused = true;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  fetchMock.mockClear();
  focused = true;
  visibility = "visible";
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("usePresence — who counts as watching", () => {
  it("reports active while the window is visible and focused", () => {
    renderHook(() => usePresence("s1"));
    expect(lastActive()).toBe(true);
  });

  it("reports AWAY for a window that is open but not focused", () => {
    // The PWA-behind-your-editor case. Open, on screen, `visible` — and not
    // being looked at. Reporting this as active is what muted every
    // notification for the session.
    focused = false;
    renderHook(() => usePresence("s1"));
    expect(lastActive()).toBe(false);
  });

  it("reports away when hidden, focus notwithstanding", () => {
    visibility = "hidden";
    renderHook(() => usePresence("s1"));
    expect(lastActive()).toBe(false);
  });

  it("beats immediately on blur, rather than waiting out the interval", () => {
    renderHook(() => usePresence("s1"));
    expect(lastActive()).toBe(true);

    focused = false;
    act(() => { window.dispatchEvent(new Event("blur")); });
    // Alt-tabbing should start letting notifications through in about a second,
    // not up to a full heartbeat later.
    expect(lastActive()).toBe(false);
  });

  it("beats immediately on focus, so watching suppresses again at once", () => {
    focused = false;
    renderHook(() => usePresence("s1"));
    expect(lastActive()).toBe(false);

    focused = true;
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(lastActive()).toBe(true);
  });
});
