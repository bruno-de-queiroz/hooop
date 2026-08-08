import { describe, it, expect, vi } from "vitest";
import { waitForTunnelReachable } from "./tunnel-reachability.mjs";

// Fake sleep throughout: the real policy waits minutes, and none of what is
// under test here is about wall-clock time.
const nap = () => Promise.resolve();

describe("waitForTunnelReachable", () => {
  it("returns immediately when the first probe answers", async () => {
    const probe = vi.fn(async () => true);
    const sleep = vi.fn(nap);
    const r = await waitForTunnelReachable({ url: "https://x.example", probe, sleep });
    expect(r).toEqual({ reachable: true, attempts: 1 });
    expect(probe).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled(); // no needless delay on the happy path
  });

  it("keeps probing while the hostname is still propagating", async () => {
    // The real shape of a quick tunnel: unreachable for a while, then fine.
    let n = 0;
    const probe = vi.fn(async () => ++n >= 4);
    const r = await waitForTunnelReachable({ url: "https://x.example", probe, sleep: nap });
    expect(r).toEqual({ reachable: true, attempts: 4 });
  });

  it("gives up after the attempt budget and reports failure", async () => {
    const probe = vi.fn(async () => false);
    const log = vi.fn();
    const r = await waitForTunnelReachable({
      url: "https://x.example", probe, sleep: nap, attempts: 3, log,
    });
    expect(r).toEqual({ reachable: false, attempts: 3 });
    expect(probe).toHaveBeenCalledTimes(3);
    // A tunnel that never comes up has to leave a trace; its silence is what
    // made this class of failure so hard to diagnose in the first place.
    expect(log).toHaveBeenCalled();
  });

  it("waits BETWEEN probes but not after the last one", async () => {
    const sleep = vi.fn(nap);
    await waitForTunnelReachable({
      url: "https://x.example", probe: async () => false, sleep, attempts: 3,
    });
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("treats a throwing probe as 'not yet', not as an error", async () => {
    // DNS failing to resolve REJECTS rather than returning a status, and that is
    // the overwhelmingly common early state. If it aborted the wait, the poll
    // would give up on precisely the tunnels it exists to wait for.
    let n = 0;
    const probe = vi.fn(async () => {
      if (++n < 3) throw new Error("ENOTFOUND");
      return true;
    });
    const r = await waitForTunnelReachable({ url: "https://x.example", probe, sleep: nap });
    expect(r).toEqual({ reachable: true, attempts: 3 });
  });

  it("passes the url through to the probe", async () => {
    const probe = vi.fn(async () => true);
    await waitForTunnelReachable({ url: "https://abc.trycloudflare.com", probe, sleep: nap });
    expect(probe).toHaveBeenCalledWith("https://abc.trycloudflare.com");
  });
});
