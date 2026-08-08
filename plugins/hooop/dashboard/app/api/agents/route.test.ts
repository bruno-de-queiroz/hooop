import { vi, describe, it, expect, beforeEach } from "vitest";

const listAgentRunsMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    listAgentRuns: (limit: number) => listAgentRunsMock(limit),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  listAgentRunsMock.mockReset();
  listAgentRunsMock.mockResolvedValue([]);
  mod = await import("./route");
});

function makeReq(search: string): Request {
  return new Request(`http://localhost/api/agents${search}`);
}

describe("GET /api/agents — limit clamping", () => {
  it("uses default limit of 50 when no limit param is given", async () => {
    const res = await mod.GET(makeReq(""));
    expect(res.status).toBe(200);
    expect(listAgentRunsMock).toHaveBeenCalledWith(50);
  });

  it("clamps limit=-1 to 1 (prevents SQLite LIMIT -1 full-table scan)", async () => {
    const res = await mod.GET(makeReq("?limit=-1"));
    expect(res.status).toBe(200);
    expect(listAgentRunsMock).toHaveBeenCalledWith(1);
  });

  it("clamps limit=0 to 1", async () => {
    const res = await mod.GET(makeReq("?limit=0"));
    expect(res.status).toBe(200);
    expect(listAgentRunsMock).toHaveBeenCalledWith(1);
  });

  it("clamps limit=99999 to max (500)", async () => {
    const res = await mod.GET(makeReq("?limit=99999"));
    expect(res.status).toBe(200);
    expect(listAgentRunsMock).toHaveBeenCalledWith(500);
  });

  it("passes through a valid limit unchanged", async () => {
    const res = await mod.GET(makeReq("?limit=25"));
    expect(res.status).toBe(200);
    expect(listAgentRunsMock).toHaveBeenCalledWith(25);
  });

  it("falls back to 50 when limit is a non-numeric string", async () => {
    const res = await mod.GET(makeReq("?limit=bad"));
    expect(res.status).toBe(200);
    expect(listAgentRunsMock).toHaveBeenCalledWith(50);
  });
});
