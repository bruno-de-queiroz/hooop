import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * What a viewer is sent to, and why the answer is TWO urls.
 *
 * The grant is a cookie, and a cookie in a cross-site iframe is not the same
 * animal as one in a top-level tab: `SameSite` withholds it from a nested
 * context whose site differs from the top-level site. So once a preview was
 * shared and the host was routed to the tunnel hostname, the dashboard's own
 * panel redeemed the grant successfully and was then refused on the very next
 * request — "Not available" inside the panel, while the identical URL worked
 * perfectly when opened in a new tab.
 *
 * The fix splits the question in two: what do I FRAME (same-site, so the cookie
 * survives) versus what URL IS this preview publicly (the tunnel). These tests
 * pin that split, because collapsing it back into one URL is exactly the
 * regression, and it presents as a UI bug nowhere near this file.
 */

const listPreviews = vi.fn();
vi.mock("@/lib/sandbox-client", () => ({
  client: { listPreviews: (...a: unknown[]) => listPreviews(...(a as [])) },
}));

let participant: { kind: "host" | "peer" | "none"; shareId?: string } = { kind: "host" };
vi.mock("@/lib/peer-auth", () => ({
  participantOf: () => participant,
  forwardedParticipant: () => (participant.kind === "host" ? "host" : `peer:${participant.shareId}`),
  canAccessSession: () => true,
}));
vi.mock("@/lib/peer-token", () => ({ peerSigningSecret: () => "test-secret" }));

let mod: typeof import("./route");

const PREVIEW = {
  previewId: "pv1",
  sessionId: "ses1",
  slot: 1,
  slotPort: 7850,
  state: "running",
  publicUrl: null as string | null,
};

function get(host = "localhost:7842"): Request {
  return new Request("http://localhost/api/sessions/ses1/previews/pv1/link", { headers: { host } });
}
const params = Promise.resolve({ id: "ses1", pid: "pv1" });

/** The grant travels in the fragment, so that is where the claim is. */
function tokenOf(url: string) {
  return JSON.parse(Buffer.from(url.split("#")[1].split(".")[0], "base64url").toString());
}

beforeEach(async () => {
  vi.resetModules();
  participant = { kind: "host" };
  listPreviews.mockResolvedValue({ previews: [{ ...PREVIEW }] });
  mod = await import("./route");
});

describe("preview link — framing vs sharing", () => {
  it("frames the host's slot port on the hostname they reached us on", async () => {
    const res = await mod.GET(get("host.docker.internal:7842") as never, { params });
    const body = await res.json();
    // Not a hardcoded 127.0.0.1: that assumes the browser runs on the Docker
    // host, which breaks over an SSH tunnel or from another machine.
    expect(body.origin).toBe("http://host.docker.internal:7850");
    expect(body.shared).toBe(false);
    expect(body.publicUrl).toBeNull();
  });

  it("keeps framing same-site once shared, so the iframe cookie survives", async () => {
    listPreviews.mockResolvedValue({
      previews: [{ ...PREVIEW, state: "shared", publicUrl: "https://t.trycloudflare.com" }],
    });
    const res = await mod.GET(get("host.docker.internal:7842") as never, { params });
    const body = await res.json();
    // THE regression guard: sharing must not change what the host frames.
    expect(body.origin).toBe("http://host.docker.internal:7850");
    expect(body.url).toContain("host.docker.internal:7850");
    expect(body.shared).toBe(true);
  });

  it("offers the tunnel URL separately once shared, with its own grant", async () => {
    listPreviews.mockResolvedValue({
      previews: [{ ...PREVIEW, state: "shared", publicUrl: "https://t.trycloudflare.com" }],
    });
    const body = await (await mod.GET(get() as never, { params })).json();
    expect(body.publicUrl).toContain("https://t.trycloudflare.com/__hooop/preview-auth#");
    // A grant is pinned to ONE hostname (the front process rejects a mismatch),
    // so the framed and public links cannot share a token. Hostname only — the
    // port is stripped, since the preview differs from the dashboard by port.
    expect(tokenOf(body.publicUrl).host).toBe("t.trycloudflare.com");
    expect(tokenOf(body.url).host).toBe("localhost");
  });

  it("sends a peer to the tunnel, the only address that means anything to them", async () => {
    participant = { kind: "peer", shareId: "sh1" };
    listPreviews.mockResolvedValue({
      previews: [{ ...PREVIEW, state: "shared", publicUrl: "https://t.trycloudflare.com" }],
    });
    const body = await (await mod.GET(get() as never, { params })).json();
    expect(body.origin).toBe("https://t.trycloudflare.com");
    expect(tokenOf(body.url).sid).toBe("sh1");
  });

  it("refuses a peer an unshared preview rather than leaking a loopback port", async () => {
    participant = { kind: "peer", shareId: "sh1" };
    const res = await mod.GET(get() as never, { params });
    expect(res.status).toBe(409);
  });

  it("404s an unknown preview", async () => {
    listPreviews.mockResolvedValue({ previews: [] });
    expect((await mod.GET(get() as never, { params })).status).toBe(404);
  });
});
