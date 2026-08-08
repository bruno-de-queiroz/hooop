import { vi, describe, it, expect, beforeEach } from "vitest";

const startNewConversationMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    startNewConversation: (opts: any, participant?: string) => startNewConversationMock(opts, participant),
  },
}));

// The proxy always injects the authenticated participant; a host request
// carries `x-hooop-participant: host`. Tests mirror that.
const HOST_HEADERS = { "Content-Type": "application/json", "x-hooop-participant": "host" };

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  startNewConversationMock.mockReset();
  mod = await import("./route");
});

describe("POST /api/sessions/new", () => {
  it("forwards gitRepo/label/name to the sandbox client", async () => {
    startNewConversationMock.mockResolvedValueOnce({
      sessionId: "pending-123",
      meta: { cwd: "/home/agent/workspace", status: "alive" },
    });

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: HOST_HEADERS,
      body: JSON.stringify({ gitRepo: "https://github.com/o/r.git", label: "L", name: "N" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      sessionId: "pending-123",
      meta: { cwd: "/home/agent/workspace", status: "alive" },
    });
    expect(startNewConversationMock).toHaveBeenCalledWith({
      gitRepo: "https://github.com/o/r.git",
      label: "L",
      name: "N",
      model: undefined,
      via: "new-conversation",
    }, "host");
  });

  it("forwards model when provided", async () => {
    startNewConversationMock.mockResolvedValueOnce({
      sessionId: "pending-789",
      meta: { cwd: "/home/agent/workspace", status: "alive" },
    });

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: HOST_HEADERS,
      body: JSON.stringify({ gitRepo: "https://github.com/o/r.git", model: "opus" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(startNewConversationMock).toHaveBeenCalledWith({
      gitRepo: "https://github.com/o/r.git",
      label: undefined,
      name: undefined,
      model: "opus",
      via: "new-conversation",
    }, "host");
  });

  it("omits gitRepo/label/name when absent from body", async () => {
    startNewConversationMock.mockResolvedValueOnce({
      sessionId: "pending-456",
      meta: { cwd: undefined, status: "alive" },
    });

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: HOST_HEADERS,
      body: JSON.stringify({}),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(startNewConversationMock).toHaveBeenCalledWith({
      gitRepo: undefined,
      label: undefined,
      name: undefined,
      model: undefined,
      via: "new-conversation",
    }, "host");
  });

  it("forwards sandbox 400s (e.g. invalid gitRepo) as the same status", async () => {
    const err: any = new Error("invalid gitRepo");
    err.status = 400;
    startNewConversationMock.mockRejectedValueOnce(err);

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: HOST_HEADERS,
      body: JSON.stringify({ gitRepo: "not-a-url" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid gitRepo" });
  });

  it("returns 500 when the sandbox client throws without a status", async () => {
    startNewConversationMock.mockRejectedValueOnce(new Error("spawn failed"));

    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: HOST_HEADERS,
      body: JSON.stringify({ gitRepo: "https://github.com/o/r.git" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "spawn failed" });
  });

  it("rejects a peer (any capability) with 403 and never spawns", async () => {
    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hooop-participant": "peer:share-abc" },
      body: JSON.stringify({ gitRepo: "https://github.com/o/r.git" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(403);
    expect(startNewConversationMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no participant header (proxy always injects one)", async () => {
    const req = new Request("http://x/api/sessions/new", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ gitRepo: "https://github.com/o/r.git" }),
    });

    const res = await mod.POST(req as any);
    expect(res.status).toBe(403);
    expect(startNewConversationMock).not.toHaveBeenCalled();
  });
});
