import { vi, describe, it, expect, beforeEach } from "vitest";

const searchMock = vi.fn();

vi.mock("@/lib/sandbox-client", () => ({
  client: { search: (q: string, type: string, limit: number) => searchMock(q, type, limit) },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  searchMock.mockReset();
  mod = await import("./route");
});

function makeReq(
  body: unknown,
  opts: { contentType?: string | null; contentLength?: string } = {}
): Request {
  const contentType =
    opts.contentType === null
      ? undefined
      : opts.contentType ?? "application/json";
  const headers: Record<string, string> = {};
  if (contentType) headers["Content-Type"] = contentType;
  if (opts.contentLength) headers["Content-Length"] = opts.contentLength;
  return new Request("http://x/api/search", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_RESULT = {
  results: [],
  type: "bm25",
  total: 0,
  meta: { bm25_used: true, semantic_used: false },
};

describe("POST /api/search", () => {
  // --- body-parsing hardening ---

  it("returns 415 when the body is absent (no Content-Type, no body)", async () => {
    const req = new Request("http://x/api/search", { method: "POST" });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(415);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("returns 415 for wrong Content-Type (text/plain)", async () => {
    const req = makeReq({ q: "hello" }, { contentType: "text/plain" });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(415);
    const json = await res.json();
    expect(json).toHaveProperty("error");
  });

  it("returns 400 for malformed JSON body (not 200 with empty results)", async () => {
    const req = new Request("http://x/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "this is not json {{{",
    });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty("error");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns 413 for oversized body (1 MB string)", async () => {
    const big = "A".repeat(1024 * 1024);
    const req = new Request("http://x/api/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": String(big.length),
      },
      body: big,
    });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json).toHaveProperty("error");
    expect(searchMock).not.toHaveBeenCalled();
  });

  // --- field validation ---

  it("returns 400 when q is longer than 1024 chars", async () => {
    const req = makeReq({ q: "x".repeat(5000), limit: 10, type: "bm25" });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty("error");
    expect(searchMock).not.toHaveBeenCalled();
  });

  it("returns 400 when q is a number (not a string)", async () => {
    const req = makeReq({ q: 42, limit: 10 });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json).toHaveProperty("error");
    expect(searchMock).not.toHaveBeenCalled();
  });

  // --- limit clamping ---

  it("clamps limit=-1 to 1 before forwarding to the sandbox", async () => {
    searchMock.mockResolvedValueOnce(VALID_RESULT);
    const req = makeReq({ q: "hello", limit: -1 });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "bm25", 1);
  });

  it("clamps limit=99999 to 200", async () => {
    searchMock.mockResolvedValueOnce(VALID_RESULT);
    const req = makeReq({ q: "hello", limit: 99999 });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "bm25", 200);
  });

  it("falls back to default limit (20) when limit is NaN string 'abc'", async () => {
    searchMock.mockResolvedValueOnce(VALID_RESULT);
    const req = makeReq({ q: "hello", limit: "abc" });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "bm25", 20);
  });

  // --- mode/type defaulting ---

  it("defaults mode to bm25 when type is missing", async () => {
    searchMock.mockResolvedValueOnce(VALID_RESULT);
    const req = makeReq({ q: "hello" });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "bm25", 20);
  });

  it("defaults mode to bm25 for an invalid type value", async () => {
    searchMock.mockResolvedValueOnce(VALID_RESULT);
    const req = makeReq({ q: "hello", type: "full-text" });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "bm25", 20);
  });

  it("accepts mode via the 'mode' field (not just 'type')", async () => {
    searchMock.mockResolvedValueOnce(VALID_RESULT);
    const req = makeReq({ q: "hello", mode: "semantic", limit: 10 });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("hello", "semantic", 10);
  });

  // --- happy path ---

  it("forwards valid body to sandbox and returns results", async () => {
    const mockResult = {
      results: [
        { id: 1, ts: "2026-01-01T00:00:00Z", session_id: "s1", hook_type: "post", tool_name: "bash", text: "hello world", score: 0.9, rank: 1 },
      ],
      type: "bm25" as const,
      total: 1,
      meta: { bm25_used: true, semantic_used: false },
    };
    searchMock.mockResolvedValueOnce(mockResult);

    const req = makeReq({ q: "hello world", type: "bm25", limit: 50 });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(mockResult);
    expect(searchMock).toHaveBeenCalledWith("hello world", "bm25", 50);
  });

  it("accepts hybrid as a valid search type", async () => {
    searchMock.mockResolvedValueOnce({ ...VALID_RESULT, type: "hybrid" });
    const req = makeReq({ q: "test", type: "hybrid", limit: 20 });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("test", "hybrid", 20);
  });

  it("accepts semantic as a valid search type", async () => {
    searchMock.mockResolvedValueOnce({ ...VALID_RESULT, type: "semantic" });
    const req = makeReq({ q: "test", type: "semantic", limit: 5 });
    const res = await mod.POST(req as any);
    expect(res.status).toBe(200);
    expect(searchMock).toHaveBeenCalledWith("test", "semantic", 5);
  });
});
