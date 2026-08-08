import { describe, it, expect } from "vitest";
import { errorResponse, parseJsonBody, readTextBody, boundedString, proxy } from "./api-helpers";

describe("proxy", () => {
  it("forwards a resolved value as a 200 JSON response", async () => {
    const res = await proxy(async () => ({ items: [1, 2] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [1, 2] });
  });

  it("preserves the sandbox-side status on rejection (404 stays 404)", async () => {
    const err = Object.assign(new Error("not found"), { status: 404 });
    const res = await proxy(async () => { throw err; });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
  });

  it("preserves 429 with the upstream message", async () => {
    const err = Object.assign(new Error("max concurrent runs"), { status: 429 });
    const res = await proxy(async () => { throw err; });
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "max concurrent runs" });
  });

  it("falls back to 500 when the error has no status", async () => {
    const res = await proxy(async () => { throw new Error("kaboom"); });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "kaboom" });
  });

  it("applies the optional transform before serialising", async () => {
    const res = await proxy(async () => [1, 2, 3], (xs) => ({ runs: xs }));
    expect(await res.json()).toEqual({ runs: [1, 2, 3] });
  });
});

describe("errorResponse", () => {
  it("returns a Response with the error JSON and the given status", async () => {
    const res = errorResponse("nope", 404);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "nope" });
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("defaults to 500", () => {
    const res = errorResponse("boom");
    expect(res.status).toBe(500);
  });
});

describe("parseJsonBody", () => {
  function req(body: string | null, init: RequestInit = {}): Request {
    return new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(init.headers as any) },
      body,
      ...init,
    });
  }

  it("parses a valid JSON body and returns no error", async () => {
    const { body, error } = await parseJsonBody<{ x: number }>(req(JSON.stringify({ x: 7 })));
    expect(error).toBeNull();
    expect(body).toEqual({ x: 7 });
  });

  it("returns 400 with 'invalid JSON body' on malformed JSON", async () => {
    const { body, error } = await parseJsonBody(req("not json"));
    expect(error?.status).toBe(400);
    expect(await error!.json()).toEqual({ error: "invalid JSON body" });
    expect(body).toEqual({});
  });

  it("returns empty body + no error on an empty body (so optional-body routes still work)", async () => {
    const { body, error } = await parseJsonBody(req(null));
    expect(error).toBeNull();
    expect(body).toEqual({});
  });

  it("rejects non-application/json Content-Type with 415 (CORS-safelisted text/plain attack)", async () => {
    const r = new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ x: 1 }),
    });
    const { error } = await parseJsonBody(r);
    expect(error?.status).toBe(415);
    expect(await error!.json()).toEqual({ error: "Content-Type must be application/json" });
  });

  it("rejects with 413 when Content-Length exceeds maxBytes", async () => {
    const r = new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": "5000" },
      body: "{}",
    });
    const { error } = await parseJsonBody(r, { maxBytes: 100 });
    expect(error?.status).toBe(413);
  });

  it("rejects with 413 when the body text exceeds maxBytes even if Content-Length lied", async () => {
    const big = JSON.stringify({ x: "A".repeat(500) });
    const r = new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: big,
    });
    const { error } = await parseJsonBody(r, { maxBytes: 100 });
    expect(error?.status).toBe(413);
  });

  it("allows other content types when allowOtherContentTypes is true", async () => {
    const r = new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ ok: true }),
    });
    const { body, error } = await parseJsonBody(r, { allowOtherContentTypes: true });
    expect(error).toBeNull();
    expect(body).toEqual({ ok: true });
  });

  it("rejects missing Content-Type with 415 and 'missing content-type' message", async () => {
    // Using no body so the Request doesn't auto-assign 'text/plain'
    const r = new Request("http://x", { method: "POST" });
    const { error } = await parseJsonBody(r);
    expect(error?.status).toBe(415);
    expect(await error!.json()).toEqual({ error: "missing content-type" });
  });

  it("accepts Content-Type: application/json; charset=utf-8 (subtype/param variant)", async () => {
    const r = new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ x: 2 }),
    });
    const { body, error } = await parseJsonBody<{ x: number }>(r);
    expect(error).toBeNull();
    expect(body).toEqual({ x: 2 });
  });

  it("accepts Content-Type: APPLICATION/JSON (case-insensitive)", async () => {
    const r = new Request("http://x", {
      method: "POST",
      headers: { "Content-Type": "APPLICATION/JSON" },
      body: JSON.stringify({ x: 3 }),
    });
    const { body, error } = await parseJsonBody<{ x: number }>(r);
    expect(error).toBeNull();
    expect(body).toEqual({ x: 3 });
  });
});

describe("readTextBody", () => {
  it("returns the body text and no error within the cap", async () => {
    const r = new Request("http://x", { method: "POST", body: "hello" });
    const { text, error } = await readTextBody(r);
    expect(error).toBeNull();
    expect(text).toBe("hello");
  });

  it("rejects oversize bodies (413)", async () => {
    const r = new Request("http://x", { method: "POST", body: "A".repeat(200) });
    const { error } = await readTextBody(r, { maxBytes: 100 });
    expect(error?.status).toBe(413);
  });
});

describe("boundedString", () => {
  it("returns trimmed string when within the cap", () => {
    expect(boundedString("  hi  ", 10)).toBe("hi");
  });

  it("returns null when over the cap (rejects, does not silently truncate)", () => {
    expect(boundedString("a".repeat(50), 5)).toBeNull();
  });

  it("accepts exactly at the cap", () => {
    expect(boundedString("a".repeat(5), 5)).toBe("aaaaa");
  });

  it("returns null for missing / non-string / empty inputs", () => {
    expect(boundedString(null, 10)).toBeNull();
    expect(boundedString(123 as any, 10)).toBeNull();
    expect(boundedString("   ", 10)).toBeNull();
  });
});
