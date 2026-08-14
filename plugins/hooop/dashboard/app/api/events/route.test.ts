import { vi, describe, it, expect, beforeEach } from "vitest";

const listEventsMock = vi.fn();
const validateShareMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    listEvents: (opts: unknown) => listEventsMock(opts),
    // revokedGrantGuard consults this for peer requests; default to a live share.
    validateShare: (...a: unknown[]) => validateShareMock(...a),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  listEventsMock.mockReset();
  listEventsMock.mockResolvedValue([]);
  validateShareMock.mockReset();
  validateShareMock.mockResolvedValue({ shareId: "share1", sessionId: "s1" });
  mod = await import("./route");
});

function makeReq(search: string): Request {
  return new Request(`http://localhost/api/events${search}`);
}

/** A peer request: middleware would have injected these trusted headers. */
function makePeerReq(search: string, session = "s1"): Request {
  return new Request(`http://localhost/api/events${search}`, {
    headers: {
      "x-hooop-participant": "peer:share1",
      "x-hooop-peer-session": session,
    },
  });
}

describe("GET /api/events — limit clamping", () => {
  it("uses default limit of 200 when no limit param is given", async () => {
    const res = await mod.GET(makeReq(""));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 })
    );
  });

  it("clamps limit=-1 to 1 (prevents SQLite LIMIT -1 full-table scan)", async () => {
    const res = await mod.GET(makeReq("?limit=-1"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 })
    );
  });

  it("clamps limit=0 to 1", async () => {
    const res = await mod.GET(makeReq("?limit=0"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 })
    );
  });

  it("clamps limit=99999 to max (1000)", async () => {
    const res = await mod.GET(makeReq("?limit=99999"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000 })
    );
  });

  it("passes through a valid limit unchanged", async () => {
    const res = await mod.GET(makeReq("?limit=50"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 })
    );
  });

  it("falls back to 200 when limit is a non-numeric string", async () => {
    const res = await mod.GET(makeReq("?limit=abc"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 })
    );
  });

  it("passes optional filter params through to the client", async () => {
    const res = await mod.GET(makeReq("?limit=10&hook=PreToolUse&session=s1"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 10, hook: "PreToolUse", session: "s1" })
    );
  });
});

describe("GET /api/events — peer session scoping (event history is host-only)", () => {
  it("rejects an unscoped peer request (the global Events panel feed) with 403", async () => {
    const res = await mod.GET(makePeerReq("?limit=200"));
    expect(res.status).toBe(403);
    expect(listEventsMock).not.toHaveBeenCalled();
  });

  it("rejects a peer request for a different session with 403", async () => {
    const res = await mod.GET(makePeerReq("?session=other", "s1"));
    expect(res.status).toBe(403);
    expect(listEventsMock).not.toHaveBeenCalled();
  });

  it("allows a peer to read their own bound session (the transcript path)", async () => {
    const res = await mod.GET(makePeerReq("?session=s1&limit=50", "s1"));
    expect(res.status).toBe(200);
    expect(listEventsMock).toHaveBeenCalledWith(
      expect.objectContaining({ session: "s1", limit: 50 })
    );
  });

  it("blocks a revoked peer (share gone) with 403 before touching events", async () => {
    validateShareMock.mockResolvedValue(null); // 404 = revoked/expired
    const res = await mod.GET(makePeerReq("?session=s1", "s1"));
    expect(res.status).toBe(403);
    expect(listEventsMock).not.toHaveBeenCalled();
  });
});
