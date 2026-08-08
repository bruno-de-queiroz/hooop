import { vi, describe, it, expect, beforeEach } from "vitest";
import { signPeerToken, PEER_COOKIE } from "@/lib/peer-token";

// The claim route reads the pending cookie via next/headers and promotes the
// signed token into the durable peer cookie. Mock both the cookie jar and the
// sandbox claim so we can exercise the cookie-setting behaviour in isolation.
const claimJoinMock = vi.fn();
let pendingCookieValue: string | undefined;

vi.mock("@/lib/sandbox-client", () => ({
  client: { claimJoin: (ticketId: string, secret: string) => claimJoinMock(ticketId, secret) },
}));

vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) =>
      name === "hooop_pending" && pendingCookieValue !== undefined
        ? { name, value: pendingCookieValue }
        : undefined,
  }),
}));

const PEER_SECRET = "p".repeat(48);
const TUNNEL_HOST = "abc123.trycloudflare.com";

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  claimJoinMock.mockReset();
  pendingCookieValue = "ticket-secret";
  process.env.HOOOP_PEER_SIGNING_SECRET = PEER_SECRET;
  mod = await import("./route");
});

async function mkToken(over: Record<string, unknown> = {}): Promise<string> {
  return signPeerToken(
    { sid: "share-1", ses: "sess-1", cap: "full", host: TUNNEL_HOST, ...over },
    PEER_SECRET,
  );
}

function claimReq(token: string, ticketId = "t1"): Request {
  return new Request(`https://${TUNNEL_HOST}/api/share/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", host: TUNNEL_HOST },
    body: JSON.stringify({ token, ticketId }),
  });
}

describe("POST /api/share/claim", () => {
  it("promotes the token into a SameSite=Lax peer cookie", async () => {
    // Regression: a Strict cookie is withheld on the cross-site top-level
    // navigation that reopening a share link performs, so the layout can't emit
    // the x-dashboard-token meta and the first mutation 401s. Lax fixes it.
    const token = await mkToken();
    claimJoinMock.mockResolvedValueOnce({ shareId: "share-1", sessionId: "sess-1", peerName: null });

    const res = await mod.POST(claimReq(token));
    expect(res.status).toBe(200);

    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${PEER_COOKIE}=${token}`);
    expect(setCookie).toContain("SameSite=lax");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    // Strict would be withheld on the cross-site top-level reopen navigation.
    expect(setCookie).not.toContain("SameSite=strict");
  });

  it("rejects when the sandbox does not confirm admission", async () => {
    const token = await mkToken();
    claimJoinMock.mockResolvedValueOnce(null);
    const res = await mod.POST(claimReq(token));
    expect(res.status).toBe(403);
  });

  it("rejects a token bound to a different host", async () => {
    const token = await mkToken({ host: "other.trycloudflare.com" });
    const res = await mod.POST(claimReq(token));
    expect(res.status).toBe(401);
  });
});
