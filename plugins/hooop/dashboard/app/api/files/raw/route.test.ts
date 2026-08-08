import { describe, it, expect, vi, beforeEach } from "vitest";

// The raw route's whole job is to turn the sandbox's base64 back into bytes with
// a Content-Type the browser will render — and to be the second closed door on
// which types may be served at all. These pin both, plus the headers that keep an
// SVG from being re-interpreted as HTML.

const getFileRaw = vi.fn();
vi.mock("@/lib/sandbox-client", () => ({ client: { getFileRaw: (...a: unknown[]) => getFileRaw(...a) } }));

const { GET } = await import("./route");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x43]);

function req(qs: string): Request {
  return new Request(`http://localhost/api/files/raw${qs}`);
}

beforeEach(() => {
  getFileRaw.mockReset();
});

describe("GET /api/files/raw", () => {
  it("serves the decoded bytes with the sandbox's agreed media type", async () => {
    getFileRaw.mockResolvedValue({ mediaType: "image/png", base64: PNG.toString("base64"), size: PNG.length });
    const res = await GET(req("?cwd=/w&path=a.png"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Length")).toBe(String(PNG.length));
    // Byte-exact: base64 is a transport detail of the socket hop, and it must
    // not survive into the response.
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(PNG)).toBe(true);
  });

  it("sets the headers that stop an SVG being sniffed into HTML", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
    getFileRaw.mockResolvedValue({ mediaType: "image/svg+xml", base64: svg.toString("base64"), size: svg.length });
    const res = await GET(req("?cwd=/w&path=logo.svg"));

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Content-Disposition")).toBe("inline");
  });

  it("keeps the response out of shared caches and gives it a validator", async () => {
    getFileRaw.mockResolvedValue({ mediaType: "image/png", base64: PNG.toString("base64"), size: PNG.length });
    const res = await GET(req("?cwd=/w&path=a.png"));
    // A file out of someone's working directory must not be cached publicly.
    expect(res.headers.get("Cache-Control")).toMatch(/private/);
    expect(res.headers.get("ETag")).toBeTruthy();
  });

  // The allowlist is the point: even if the sandbox drifted or were compromised
  // into returning text/html, this route must not put it on the wire.
  it("refuses a media type outside the allowlist", async () => {
    getFileRaw.mockResolvedValue({
      mediaType: "text/html",
      base64: Buffer.from("<script>alert(1)</script>").toString("base64"),
      size: 25,
    });
    const res = await GET(req("?cwd=/w&path=evil.html"));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unsupported media type: text/html" });
  });

  it("requires both cwd and path", async () => {
    expect((await GET(req("?path=a.png"))).status).toBe(400);
    expect((await GET(req("?cwd=/w"))).status).toBe(400);
    expect(getFileRaw).not.toHaveBeenCalled();
  });

  it("preserves the sandbox's status for a rejected path or oversized image", async () => {
    // CwdPolicyError surfaces as a 400 from the sandbox; a path escape must not
    // be reported as a server fault.
    getFileRaw.mockRejectedValue(Object.assign(new Error("path escapes cwd"), { status: 400 }));
    const res = await GET(req("?cwd=/w&path=../../etc/hosts"));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "path escapes cwd" });
  });

  it("falls back to 500 for an error with no status", async () => {
    getFileRaw.mockRejectedValue(new Error("socket gone"));
    const res = await GET(req("?cwd=/w&path=a.png"));
    expect(res.status).toBe(500);
  });

  it("passes cwd and path through decoded", async () => {
    getFileRaw.mockResolvedValue({ mediaType: "image/png", base64: PNG.toString("base64"), size: PNG.length });
    await GET(req(`?cwd=${encodeURIComponent("/w/my project")}&path=${encodeURIComponent("assets/a b.png")}`));
    expect(getFileRaw).toHaveBeenCalledWith("/w/my project", "assets/a b.png");
  });
});
