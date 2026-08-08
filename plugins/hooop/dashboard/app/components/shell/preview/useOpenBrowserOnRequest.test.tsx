import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

// Same pattern as AuthBanner.test: capture the handlers and invoke them with the
// exact frame the sandbox would send, rather than standing up a live channel.
let handlers: Record<string, (data: unknown) => void> = {};
vi.mock("@/app/components/useSSE", () => ({
  useSSE: (h: Record<string, (data: unknown) => void>) => { handlers = h; },
}));

import { useOpenBrowserOnRequest } from "./useOpenBrowserOnRequest";

const openRail = vi.fn();
const openMobile = vi.fn();

function mount(selectedId: string | null = "sess-a", isMobile = () => true) {
  function Probe() {
    useOpenBrowserOnRequest({ selectedId, openRail, openMobile, isMobile });
    return null;
  }
  render(<Probe />);
}

function send(row: Record<string, unknown>) {
  handlers.event?.(row);
}
function drive(row: Record<string, unknown>) {
  handlers["preview-drive"]?.(row);
}

beforeEach(() => {
  handlers = {};
  openRail.mockReset();
  openMobile.mockReset();
});

/**
 * The agent waits behind this. If it fails to open, the agent is stuck on a
 * request nobody acted on; if it opens too eagerly, it hijacks a rail somebody
 * was using for something else. Both directions are pinned.
 */
describe("opening the browser when the agent asks for a viewer", () => {
  it("opens both surfaces for this session's request", () => {
    mount("sess-a");
    send({ hook_type: "PreviewNeedsViewer", session_id: "sess-a" });
    expect(openRail).toHaveBeenCalledTimes(1);
    // The rail does not exist on a phone, so switching it there would be
    // invisible — the overlay is the only place the preview can appear.
    expect(openMobile).toHaveBeenCalledTimes(1);
  });

  it("does NOT open the mobile overlay on a desktop", () => {
    // Both layouts stay mounted behind a CSS `hidden`, so opening the overlay
    // here mounted a SECOND preview panel: another iframe, another grant,
    // another page in the fan-out that nobody could see. Caught live as a
    // viewer count that grew from 3 to 5 across one navigation.
    mount("sess-a", () => false);
    send({ hook_type: "PreviewNeedsViewer", session_id: "sess-a" });
    expect(openRail).toHaveBeenCalledTimes(1);
    expect(openMobile).not.toHaveBeenCalled();
  });

  it("ignores another session's request", () => {
    // The dock is session-scoped: acting on this would open the preview of the
    // session on screen, implying somebody asked for it, and leave the real
    // asker still waiting.
    mount("sess-a");
    send({ hook_type: "PreviewNeedsViewer", session_id: "sess-b" });
    expect(openRail).not.toHaveBeenCalled();
  });

  it("opens for a request that names no session", () => {
    mount("sess-a");
    send({ hook_type: "PreviewNeedsViewer" });
    expect(openRail).toHaveBeenCalledTimes(1);
  });

  it("leaves the rail alone for ordinary preview lifecycle events", () => {
    // Started/shared/stopped are news. Taking over somebody's rail to announce
    // them would make the feature something people turn off.
    mount("sess-a");
    for (const hook of ["PreviewStarted", "PreviewShared", "PreviewStopped", "PreviewFailed", "Stop"]) {
      send({ hook_type: hook, session_id: "sess-a" });
    }
    expect(openRail).not.toHaveBeenCalled();
    expect(openMobile).not.toHaveBeenCalled();
  });

  it("opens on an ordinary action, not only when the agent is blocked", () => {
    // The blocked case cannot cover this one: with somebody else watching, the
    // agent is not blocked and never asks — so closing your panel used to mean
    // missing the rest of the run.
    mount("sess-a");
    drive({ sessionId: "sess-a", previewId: "pv-1", action: "click" });
    expect(openRail).toHaveBeenCalledTimes(1);
    expect(openMobile).toHaveBeenCalledTimes(1);
  });

  it("ignores an action in another session's preview", () => {
    mount("sess-a");
    drive({ sessionId: "sess-b", previewId: "pv-9", action: "click" });
    expect(openRail).not.toHaveBeenCalled();
  });

  it("survives a frame that is not an event at all", () => {
    mount("sess-a");
    expect(() => { send(null as unknown as Record<string, unknown>); }).not.toThrow();
    expect(openRail).not.toHaveBeenCalled();
  });
});
