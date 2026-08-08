import { vi, describe, it, expect, beforeEach } from "vitest";

const listFilesMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    listFiles: (opts: unknown) => listFilesMock(opts),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  listFilesMock.mockReset();
  listFilesMock.mockResolvedValue([
    { name: "README.md", isDir: false },
    { name: "src", isDir: true },
  ]);
  mod = await import("./route");
});

function makeReq(search: string): Request {
  return new Request(`http://localhost/api/files${search}`);
}

describe("GET /api/files", () => {
  it("400s when cwd is missing", async () => {
    const res = await mod.GET(makeReq(""));
    expect(res.status).toBe(400);
    expect(listFilesMock).not.toHaveBeenCalled();
  });

  it("wraps the sandbox response in { entries }", async () => {
    const res = await mod.GET(makeReq("?cwd=/workspace"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      entries: [
        { name: "README.md", isDir: false },
        { name: "src", isDir: true },
      ],
    });
    expect(listFilesMock).toHaveBeenCalledWith({
      cwd: "/workspace",
      q: undefined,
      limit: 20,
    });
  });

  it("forwards optional q and limit", async () => {
    const res = await mod.GET(makeReq("?cwd=/workspace&q=read&limit=5"));
    expect(res.status).toBe(200);
    expect(listFilesMock).toHaveBeenCalledWith({
      cwd: "/workspace",
      q: "read",
      limit: 5,
    });
  });

  it("clamps an absurd limit", async () => {
    await mod.GET(makeReq("?cwd=/workspace&limit=99999"));
    expect(listFilesMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    );
  });

  it("propagates upstream policy errors with their status", async () => {
    listFilesMock.mockRejectedValueOnce(
      Object.assign(new Error("policy: out of scope"), { status: 400 }),
    );
    const res = await mod.GET(makeReq("?cwd=/forbidden"));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("out of scope");
  });
});
