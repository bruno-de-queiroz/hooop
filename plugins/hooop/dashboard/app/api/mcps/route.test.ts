import { vi, describe, it, expect, beforeEach } from "vitest";

const listMcpsMock = vi.fn();
vi.mock("@/lib/sandbox-client", () => ({
  client: { listMcps: () => listMcpsMock() },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  listMcpsMock.mockReset();
  mod = await import("./route");
});

describe("GET /api/mcps", () => {
  it("returns whatever the sandbox returns", async () => {
    listMcpsMock.mockReturnValueOnce({
      servers: [
        { name: "ct-docs", scope: "plugin", type: "stdio", target: "node x", envKeys: [], plugin: "hooop" },
      ],
    });
    const res = await mod.GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      servers: [
        { name: "ct-docs", scope: "plugin", type: "stdio", target: "node x", envKeys: [], plugin: "hooop" },
      ],
    });
  });

  it("propagates an empty list", async () => {
    listMcpsMock.mockReturnValueOnce({ servers: [] });
    const res = await mod.GET();
    expect(await res.json()).toEqual({ servers: [] });
  });

  it("returns response as JSON", async () => {
    listMcpsMock.mockReturnValueOnce({ servers: [] });
    const res = await mod.GET();
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
