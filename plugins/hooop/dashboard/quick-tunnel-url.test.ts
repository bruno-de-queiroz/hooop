import { describe, it, expect } from "vitest";
import { parseQuickTunnelUrl } from "./quick-tunnel-url.mjs";

// Fixtures are real cloudflared output, kept verbatim. The bug this module
// exists for was invisible precisely because a hand-simplified "error line"
// does not contain the thing that caused it.

const BANNER = [
  "2026-08-08T01:12:04Z INF +---------------------------------------------------------------------+",
  "2026-08-08T01:12:04Z INF |  Your quick Tunnel has been created! Visit it at (it may take some   |",
  "2026-08-08T01:12:04Z INF |  time to be reachable):                                              |",
  "2026-08-08T01:12:04Z INF |  https://plain-liver-mining-parks.trycloudflare.com                  |",
  "2026-08-08T01:12:04Z INF +---------------------------------------------------------------------+",
].join("\n");

// The line behind the reported WSL failure: cloudflared could not reach its own
// control plane, and said so with the endpoint in the message.
const REGISTRATION_FAILED =
  '2026-08-08T01:12:04Z ERR Failed to serve quick tunnel error="failed to request quick ' +
  'Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\": dial tcp: lookup ' +
  'api.trycloudflare.com: no such host"';

describe("parseQuickTunnelUrl", () => {
  it("reads the hostname out of the success banner", () => {
    expect(parseQuickTunnelUrl(BANNER)).toBe(
      "https://plain-liver-mining-parks.trycloudflare.com",
    );
  });

  it("does not mistake the registration endpoint for a tunnel", () => {
    // The regression. Reading api.trycloudflare.com here made Share return 200
    // with a link that pointed at Cloudflare's API instead of this machine.
    expect(parseQuickTunnelUrl(REGISTRATION_FAILED)).toBeNull();
  });

  it("refuses the service host even when the line does not read as an error", () => {
    // SERVICE_HOSTS stands on its own, so a reworded failure can't slip past.
    expect(
      parseQuickTunnelUrl('Post "https://api.trycloudflare.com/tunnel"'),
    ).toBeNull();
  });

  it("refuses any hostname a failure line merely mentions", () => {
    // A future release blaming some other trycloudflare host is still a failure,
    // not an announcement.
    expect(
      parseQuickTunnelUrl(
        '2026-08-08T01:12:04Z ERR connection failed error="https://edge-x.trycloudflare.com unreachable"',
      ),
    ).toBeNull();
  });

  it("still finds the tunnel when a failure line shares the chunk", () => {
    // Chunks split wherever the pipe pleases, so the banner and an unrelated
    // error routinely arrive together. Rejecting the chunk would lose a tunnel
    // that genuinely came up.
    expect(parseQuickTunnelUrl(`${REGISTRATION_FAILED}\n${BANNER}`)).toBe(
      "https://plain-liver-mining-parks.trycloudflare.com",
    );
  });

  it("is not tripped by benign warnings", () => {
    const chunk = [
      "2026-08-08T01:12:04Z WRN Your version 2024.1.0 is outdated. We recommend upgrading.",
      BANNER,
    ].join("\n");
    expect(parseQuickTunnelUrl(chunk)).toBe(
      "https://plain-liver-mining-parks.trycloudflare.com",
    );
  });

  it("returns null for output that announces nothing", () => {
    expect(parseQuickTunnelUrl("2026-08-08T01:12:04Z INF Registered tunnel connection")).toBeNull();
    expect(parseQuickTunnelUrl("")).toBeNull();
    expect(parseQuickTunnelUrl(undefined as unknown as string)).toBeNull();
  });
});
