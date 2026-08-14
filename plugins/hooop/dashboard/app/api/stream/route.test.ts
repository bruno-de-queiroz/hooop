import { vi, describe, it, expect, beforeEach } from "vitest";

const fakeBus = () => ({ on: vi.fn(), off: vi.fn() });

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    boot: vi.fn(),
    eventBus: fakeBus(),
    sessionsBus: fakeBus(),
    activeSessionsBus: fakeBus(),
    skillsBus: fakeBus(),
    filesBus: fakeBus(),
  },
}));

vi.mock("@/lib/presence", () => ({
  presenceBus: () => fakeBus(),
  listPresence: () => [],
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  mod = await import("./route");
});

function reqWith(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/stream", { headers });
}

describe("GET /api/stream — host-only firehose", () => {
  it("serves the SSE stream to the host", async () => {
    const res = await mod.GET(reqWith({ "x-hooop-participant": "host" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("rejects a peer with 403 (would otherwise leak every session's events)", async () => {
    const res = await mod.GET(
      reqWith({ "x-hooop-participant": "peer:share1", "x-hooop-peer-session": "s1" }),
    );
    expect(res.status).toBe(403);
  });

  it("refuses an enrolled DEVICE, even though a device is the host elsewhere", async () => {
    // Two reasons, and the second is the load-bearing one: a device's browser reads
    // /api/ws like everyone else, so there is nothing here for it to want; and
    // revocation cannot reach a stream that is already open, since an SSE response
    // held open indefinitely is neither re-checked per request nor reaped. A device
    // revoked mid-stream would keep receiving every session's events. Refusing the
    // capability is smaller than policing the connection.
    const res = await mod.GET(reqWith({ "x-hooop-participant": "host:device-1" }));
    expect(res.status).toBe(403);
  });

  it("rejects an unidentified caller with 403", async () => {
    const res = await mod.GET(reqWith({}));
    expect(res.status).toBe(403);
  });
});
