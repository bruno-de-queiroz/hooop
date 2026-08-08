import { vi, describe, it, expect, beforeEach } from "vitest";

const searchMock = vi.fn();
const validateShareMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    search: (q: string, type: string, limit: number, session?: string) =>
      searchMock(q, type, limit, session),
    validateShare: (...a: unknown[]) => validateShareMock(...a),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  searchMock.mockReset();
  searchMock.mockResolvedValue({
    results: [],
    type: "bm25",
    total: 0,
    meta: { bm25_used: true, semantic_used: false },
  });
  validateShareMock.mockReset();
  validateShareMock.mockResolvedValue({ shareId: "share1", sessionId: "s1" });
  mod = await import("./route");
});

function req(body: unknown, peer?: { session: string }): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (peer) {
    headers["x-hooop-participant"] = "peer:share1";
    headers["x-hooop-peer-session"] = peer.session;
  }
  return new Request("http://localhost/api/search", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/search — peer session scoping", () => {
  it("does not scope a host search (session undefined)", async () => {
    const res = await mod.POST(req({ q: "hello" }));
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "bm25", 20, undefined);
  });

  it("pins a peer search to their bound session, ignoring a client-supplied session", async () => {
    const res = await mod.POST(req({ q: "hello", session: "attacker-session" }, { session: "s1" }));
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "bm25", 20, "s1");
  });

  it("blocks a revoked peer with 403 before searching", async () => {
    validateShareMock.mockResolvedValue(null);
    const res = await mod.POST(req({ q: "hello" }, { session: "s1" }));
    expect(res.status).toBe(403);
    expect(searchMock).not.toHaveBeenCalled();
  });
});
