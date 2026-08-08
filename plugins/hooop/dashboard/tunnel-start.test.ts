import { describe, it, expect, vi } from "vitest";
import { cloudflaredArgs, startTunnelWithRetry } from "./tunnel-start.mjs";

// A retry loop is only worth having if it stops for the right reasons, so most
// of what is checked here is when it DOESN'T run again.

describe("cloudflaredArgs", () => {
  it("pins the transport off QUIC and the edge off IPv6", () => {
    const args = cloudflaredArgs("http://127.0.0.1:7842", {});
    expect(args).toEqual([
      "tunnel",
      "--no-autoupdate",
      "--protocol", "http2",
      "--edge-ip-version", "4",
      "--url", "http://127.0.0.1:7842",
    ]);
  });

  it("lets a healthy network ask for the upstream defaults back", () => {
    const args = cloudflaredArgs("http://127.0.0.1:7850", {
      HOOOP_TUNNEL_PROTOCOL: "quic",
      HOOOP_TUNNEL_EDGE_IP_VERSION: "auto",
    });
    expect(args).toContain("quic");
    expect(args).toContain("auto");
    expect(args).not.toContain("http2");
  });

  it("keeps --url last so the origin is never read as a flag value", () => {
    const args = cloudflaredArgs("http://127.0.0.1:1", {});
    expect(args.at(-2)).toBe("--url");
    expect(args.at(-1)).toBe("http://127.0.0.1:1");
  });
});

/** Attempt results in order; the last one repeats if the loop outlives them. */
const attemptsReturning = (...results: object[]) => {
  const calls: number[] = [];
  const attempt = vi.fn(async (n: number) => {
    calls.push(n);
    return results[Math.min(calls.length - 1, results.length - 1)];
  });
  return { attempt, calls };
};

const deps = (over: Record<string, unknown> = {}) => ({
  sleep: async () => {},
  now: () => 0,
  ...over,
});

describe("startTunnelWithRetry", () => {
  it("does not spawn twice when the first attempt works", async () => {
    const { attempt } = attemptsReturning({});
    const r = await startTunnelWithRetry({ attempt, ...deps() });
    expect(r.error).toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("recovers from a transient registration failure", async () => {
    // The real one: api.trycloudflare.com sinkholed for one lookup, fine the next.
    const { attempt } = attemptsReturning(
      { error: "cloudflared exited (1) before reporting a hostname" },
      { url: "https://x.trycloudflare.com" },
    );
    const r = await startTunnelWithRetry({ attempt, ...deps() });
    expect(r).toEqual({ url: "https://x.trycloudflare.com" });
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("gives up after the attempt budget and reports the last failure", async () => {
    const { attempt } = attemptsReturning({ error: "boom" });
    const r = await startTunnelWithRetry({ attempt, attempts: 3, ...deps() });
    expect(r).toEqual({ error: "boom" });
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("stops immediately on a fatal result — no retry installs a binary", async () => {
    const { attempt } = attemptsReturning({
      error: "could not start cloudflared: spawn cloudflared ENOENT",
      fatal: true,
    });
    const r = await startTunnelWithRetry({ attempt, attempts: 5, ...deps() });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(r.fatal).toBe(true);
  });

  it("stops once the wall-clock budget is spent, however many attempts remain", async () => {
    // Each attempt hangs for its full 20s start timeout. The attempt count would
    // allow 5 of those; the 30s deadline is what actually stops it at 2.
    let clock = 0;
    const attempt = vi.fn(async () => {
      clock += 20_000;
      return { error: "timed out waiting for tunnel hostname" };
    });
    const r = await startTunnelWithRetry({
      attempt,
      attempts: 5,
      deadlineMs: 30_000,
      sleep: async () => {},
      now: () => clock,
    });
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(r.error).toMatch(/timed out/);
  });

  it("backs off further on each successive attempt", async () => {
    const waits: number[] = [];
    const { attempt } = attemptsReturning({ error: "boom" });
    await startTunnelWithRetry({
      attempt,
      attempts: 4,
      sleep: async (ms: number) => { waits.push(ms); },
      now: () => 0,
    });
    expect(waits).toEqual([1_000, 2_000, 3_000]);
  });

  it("abandons the start when the host stops the tunnel mid-attempt", async () => {
    const { attempt } = attemptsReturning({ error: "boom" });
    const r = await startTunnelWithRetry({ attempt, attempts: 5, aborted: () => true, ...deps() });
    // One attempt ran, and its failure is flagged as cancelled rather than real —
    // the caller must not surface "tunnel failed" for a tunnel nobody wants.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(r.aborted).toBe(true);
  });

  it("abandons the start when the stop lands during the backoff wait", async () => {
    let stopped = false;
    const { attempt } = attemptsReturning({ error: "boom" });
    const r = await startTunnelWithRetry({
      attempt,
      attempts: 5,
      aborted: () => stopped,
      sleep: async () => { stopped = true; },
      now: () => 0,
    });
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(r.aborted).toBe(true);
  });

  it("never flags a success as aborted", async () => {
    // Success flips the very state the session tunnel's abort predicate reads
    // ("starting" -> "running"), so order matters: check the result first.
    const { attempt } = attemptsReturning({ url: "https://x.trycloudflare.com" });
    const r = await startTunnelWithRetry({ attempt, aborted: () => true, ...deps() });
    expect(r.aborted).toBeUndefined();
    expect(r.url).toBe("https://x.trycloudflare.com");
  });

  it("logs each retry so a flaky start is visible instead of just slow", async () => {
    const log = vi.fn();
    const { attempt } = attemptsReturning({ error: "boom" }, {});
    await startTunnelWithRetry({ attempt, label: "preview 1", log, ...deps() });
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0].join(" ")).toContain("tunnel[preview 1] attempt 1/3");
  });
});
