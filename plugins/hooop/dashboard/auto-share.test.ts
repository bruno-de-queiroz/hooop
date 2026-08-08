import { describe, it, expect, vi, beforeEach } from "vitest";
import { autoShareSweep } from "./auto-share.mjs";

// The sweep exists so a preview in an already-shared session becomes shared
// without anyone clicking Share. Every side effect is injected, so these tests
// exercise the real decision path with no sandbox, no cloudflared and no server.

function preview(over: Record<string, unknown> = {}) {
  return {
    previewId: "pv-1", sessionId: "sess-a", slot: 1, slotPort: 7850,
    state: "running", publicUrl: null, spec: { name: "web" },
    ...over,
  };
}

let deps: any;

beforeEach(() => {
  deps = {
    fetchPreviews: vi.fn(async () => [preview()]),
    fetchShares: vi.fn(async () => [{ shareId: "sh-1", sessionId: "sess-a" }]),
    startPreviewTunnel: vi.fn(async () => ({ url: "https://x.trycloudflare.com" })),
    stopPreviewTunnel: vi.fn(),
    recordPreviewShared: vi.fn(async () => true),
    log: vi.fn(),
  };
});

describe("autoShareSweep", () => {
  it("shares a running preview whose session already has a live share", async () => {
    const r = await autoShareSweep(deps);
    expect(deps.startPreviewTunnel).toHaveBeenCalledWith(1);
    expect(deps.recordPreviewShared).toHaveBeenCalledWith("sess-a", "pv-1", "https://x.trycloudflare.com");
    expect(r).toMatchObject({ shared: ["pv-1"], failed: [] });
  });

  // The other order: a preview already running when the first peer joins. Same
  // sweep covers it, which is the whole reason this is a reconciler.
  it("covers the peer-joins-later order identically", async () => {
    deps.fetchShares = vi.fn(async () => []);
    expect(await autoShareSweep(deps)).toMatchObject({ shared: [], failed: [] });
    // The share now exists; nothing else changed.
    deps.fetchShares = vi.fn(async () => [{ shareId: "sh-9", sessionId: "sess-a" }]);
    expect((await autoShareSweep(deps)).shared).toEqual(["pv-1"]);
  });

  it("does nothing for a solo session, without even asking for shares", async () => {
    deps.fetchShares = vi.fn(async () => []);
    const r = await autoShareSweep(deps);
    expect(deps.startPreviewTunnel).not.toHaveBeenCalled();
    expect(r.shared).toEqual([]);
  });

  it("skips the shares lookup entirely when no preview is a candidate", async () => {
    deps.fetchPreviews = vi.fn(async () => []);
    await autoShareSweep(deps);
    expect(deps.fetchShares).not.toHaveBeenCalled();
  });

  // Re-sharing would strand a second tunnel on the slot with nothing tracking it.
  it("leaves an already-shared preview alone", async () => {
    deps.fetchPreviews = vi.fn(async () => [preview({ publicUrl: "https://old.trycloudflare.com" })]);
    await autoShareSweep(deps);
    expect(deps.startPreviewTunnel).not.toHaveBeenCalled();
  });

  it.each(["starting", "failed", "stopped"])("does not share a %s preview", async (state) => {
    deps.fetchPreviews = vi.fn(async () => [preview({ state })]);
    await autoShareSweep(deps);
    expect(deps.startPreviewTunnel).not.toHaveBeenCalled();
  });

  it("does not share a preview whose session has no share", async () => {
    deps.fetchShares = vi.fn(async () => [{ shareId: "sh-1", sessionId: "someone-else" }]);
    await autoShareSweep(deps);
    expect(deps.startPreviewTunnel).not.toHaveBeenCalled();
  });

  // A live tunnel the record does not know about is an ingress nothing will ever
  // close, because unshare and stop both work from the record.
  it("rolls the tunnel back when the sandbox refuses to record the share", async () => {
    deps.recordPreviewShared = vi.fn(async () => false);
    const r = await autoShareSweep(deps);
    expect(deps.stopPreviewTunnel).toHaveBeenCalledWith(1);
    expect(r).toMatchObject({ shared: [], failed: ["pv-1"] });
  });

  it("does not record anything when the tunnel fails to start", async () => {
    deps.startPreviewTunnel = vi.fn(async () => ({ error: "cloudflared missing" }));
    const r = await autoShareSweep(deps);
    expect(deps.recordPreviewShared).not.toHaveBeenCalled();
    expect(deps.stopPreviewTunnel).not.toHaveBeenCalled();
    expect(r.failed).toEqual(["pv-1"]);
  });

  it("keeps going after one preview fails, and shares each on its own slot", async () => {
    deps.fetchPreviews = vi.fn(async () => [
      preview({ previewId: "pv-1", slot: 1 }),
      preview({ previewId: "pv-2", slot: 2, sessionId: "sess-b" }),
    ]);
    deps.fetchShares = vi.fn(async () => [
      { shareId: "sh-1", sessionId: "sess-a" },
      { shareId: "sh-2", sessionId: "sess-b" },
    ]);
    deps.startPreviewTunnel = vi.fn(async (slot: number) =>
      slot === 1 ? { error: "boom" } : { url: "https://b.trycloudflare.com" });
    const r = await autoShareSweep(deps);
    expect(r).toMatchObject({ shared: ["pv-2"], failed: ["pv-1"] });
    expect(deps.recordPreviewShared).toHaveBeenCalledWith("sess-b", "pv-2", "https://b.trycloudflare.com");
  });

  // KNOWN GAP, asserted so it is a decision rather than a surprise.
  //
  // PreviewRecord.sessionId is documented as "canonical session id AT CREATION
  // TIME" and the sandbox re-keys a session on resume — it carries expandSessionIds
  // for exactly this. The front process has no alias data, so a share created
  // against a different id in the same alias chain will not match and the preview
  // silently stays private. Closing it needs the sandbox to expose the alias set
  // on the preview (or the share) record.
  it("MISSES a share recorded under an alias of the same session (documented gap)", async () => {
    deps.fetchShares = vi.fn(async () => [{ shareId: "sh-1", sessionId: "sess-a-OLD-ALIAS" }]);
    const r = await autoShareSweep(deps);
    expect(r.shared).toEqual([]);
    expect(deps.startPreviewTunnel).not.toHaveBeenCalled();
  });

  it("survives a preview list with no spec (logs by id instead of crashing)", async () => {
    deps.fetchPreviews = vi.fn(async () => [preview({ spec: undefined })]);
    expect((await autoShareSweep(deps)).shared).toEqual(["pv-1"]);
  });
});

/**
 * The other direction. Tunnels used to be created here and closed nowhere: every
 * way a preview could end — the dock's Stop, the settings inventory, and now the
 * idle sweeper releasing it — left cloudflared running against an empty slot,
 * still serving a public hostname. Reconciling teardown here covers all of them
 * at once instead of asking each caller to remember.
 */
describe("autoShareSweep: tunnel teardown", () => {
  it("closes the tunnel of a slot whose preview is gone", async () => {
    deps.fetchPreviews = vi.fn(async () => []);
    deps.liveTunnelSlots = () => [1];
    const r = await autoShareSweep(deps);
    expect(deps.stopPreviewTunnel).toHaveBeenCalledWith(1);
    expect(r.reclaimed).toEqual([1]);
  });

  it("closes the tunnel of a preview that is running but no longer shared", async () => {
    // Un-sharing already deletes its own tunnel; this is the backstop for every
    // path that does not, and for a record that changed underneath us.
    deps.fetchPreviews = vi.fn(async () => [preview({ publicUrl: null })]);
    deps.fetchShares = vi.fn(async () => []);
    deps.liveTunnelSlots = () => [1];
    await autoShareSweep(deps);
    expect(deps.stopPreviewTunnel).toHaveBeenCalledWith(1);
  });

  it("leaves the tunnel of a still-shared preview alone", async () => {
    deps.fetchPreviews = vi.fn(async () => [preview({ publicUrl: "https://x.trycloudflare.com" })]);
    deps.liveTunnelSlots = () => [1];
    const r = await autoShareSweep(deps);
    expect(deps.stopPreviewTunnel).not.toHaveBeenCalled();
    expect(r.reclaimed).toEqual([]);
  });

  it("only touches slots that actually hold a tunnel", async () => {
    deps.fetchPreviews = vi.fn(async () => []);
    deps.liveTunnelSlots = () => [2];
    await autoShareSweep(deps);
    expect(deps.stopPreviewTunnel).toHaveBeenCalledWith(2);
    expect(deps.stopPreviewTunnel).toHaveBeenCalledTimes(1);
  });
});

describe("autoShareSweep: the dashboard tunnel", () => {
  beforeEach(() => {
    deps.fetchPreviews = vi.fn(async () => []);
    deps.dashboardTunnelUp = () => true;
    deps.stopDashboardTunnel = vi.fn();
    deps.setSawAnyShare = vi.fn();
  });

  it("closes it once the last share is gone", async () => {
    deps.fetchShares = vi.fn(async () => []);
    deps.sawAnyShare = () => true;
    const r = await autoShareSweep(deps);
    expect(deps.stopDashboardTunnel).toHaveBeenCalled();
    expect(deps.setSawAnyShare).toHaveBeenCalledWith(false);
    expect(r.dashboardTunnelStopped).toBe(true);
  });

  it("does NOT close it when the host has started a tunnel but not yet invited anyone", async () => {
    // The invite flow is: start the tunnel, then mint a share. A bare
    // "no shares" test would kill the tunnel in between, which is why the latch
    // exists at all.
    deps.fetchShares = vi.fn(async () => []);
    deps.sawAnyShare = () => false;
    await autoShareSweep(deps);
    expect(deps.stopDashboardTunnel).not.toHaveBeenCalled();
  });

  it("latches once a share exists, so the next emptiness is a real departure", async () => {
    deps.fetchShares = vi.fn(async () => [{ shareId: "sh-1", sessionId: "sess-a" }]);
    deps.sawAnyShare = () => false;
    await autoShareSweep(deps);
    expect(deps.setSawAnyShare).toHaveBeenCalledWith(true);
    expect(deps.stopDashboardTunnel).not.toHaveBeenCalled();
  });

  it("leaves a stopped tunnel alone", async () => {
    deps.dashboardTunnelUp = () => false;
    deps.fetchShares = vi.fn(async () => []);
    deps.sawAnyShare = () => true;
    await autoShareSweep(deps);
    expect(deps.stopDashboardTunnel).not.toHaveBeenCalled();
  });
});
