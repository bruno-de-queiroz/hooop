import { vi, describe, it, expect, beforeEach } from "vitest";

const getEventMock = vi.fn();
const validateShareMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    getEvent: (id: number, opts?: unknown) => getEventMock(id, opts),
    validateShare: (...a: unknown[]) => validateShareMock(...a),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  getEventMock.mockReset();
  getEventMock.mockResolvedValue({ id: 42, session_id: "s1", payload: {} });
  validateShareMock.mockReset();
  validateShareMock.mockResolvedValue({ shareId: "share1", sessionId: "s1" });
  mod = await import("./route");
});

function hostReq(): Request {
  return new Request("http://localhost/api/events/42");
}
function peerReq(session = "s1"): Request {
  return new Request("http://localhost/api/events/42", {
    headers: {
      "x-hooop-participant": "peer:share1",
      "x-hooop-peer-session": session,
    },
  });
}
const params = Promise.resolve({ id: "42" });

describe("GET /api/events/:id — peer session scoping", () => {
  it("host reads any event with no session scope", async () => {
    const res = await mod.GET(hostReq(), { params });
    expect(res.status).toBe(200);
    expect(getEventMock).toHaveBeenCalledWith(42, undefined);
  });

  it("peer request forwards their bound session as the ownership scope", async () => {
    const res = await mod.GET(peerReq("s1"), { params });
    expect(res.status).toBe(200);
    expect(getEventMock).toHaveBeenCalledWith(42, { session: "s1" });
  });

  it("returns 404 when the sandbox denies the event (out of peer scope)", async () => {
    // Sandbox returns null when the event isn't in the peer's (expanded) session.
    getEventMock.mockResolvedValue(null);
    const res = await mod.GET(peerReq("s1"), { params });
    expect(res.status).toBe(404);
  });

  it("blocks a revoked peer before fetching the event", async () => {
    validateShareMock.mockResolvedValue(null);
    const res = await mod.GET(peerReq("s1"), { params });
    expect(res.status).toBe(403);
    expect(getEventMock).not.toHaveBeenCalled();
  });
});
