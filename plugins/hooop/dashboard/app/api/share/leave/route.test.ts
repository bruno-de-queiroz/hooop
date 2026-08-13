import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * "Leave session" is the SINGLE source of a durable `PeerLeft` marker, which is
 * what makes it worth testing now that one guest can be watching from two
 * screens: leaving on the phone while the laptop is still open is not leaving, and
 * announcing it would tell the room something untrue.
 */
const peerLeave = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/sandbox-client", () => ({
  client: { peerLeave: (...a: unknown[]) => peerLeave(...(a as [])) },
}));

let participant: { kind: "host" | "peer" | "none"; shareId?: string } = { kind: "peer", shareId: "share-1" };
vi.mock("@/lib/peer-auth", () => ({
  participantOf: () => participant,
  peerSessionId: () => "sess-1",
}));

let gone = true;
const leave = vi.fn(() => ({ gone }));
vi.mock("@/lib/presence", () => ({
  leave: (...a: unknown[]) => leave(...(a as [])),
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  peerLeave.mockClear();
  leave.mockClear();
  participant = { kind: "peer", shareId: "share-1" };
  gone = true;
  mod = await import("./route");
});

function post(body: unknown): Request {
  return new Request("https://abc.trycloudflare.com/api/share/leave", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/share/leave", () => {
  it("drops only the leaving SCREEN from the roster", async () => {
    await mod.POST(post({ name: "Ana", viewerId: "phone" }) as never);
    expect(leave).toHaveBeenCalledWith("sess-1", "peer:share-1", "phone");
  });

  it("emits the leave marker when that was their last screen", async () => {
    gone = true;
    await mod.POST(post({ name: "Ana", viewerId: "phone" }) as never);
    expect(peerLeave).toHaveBeenCalledWith("sess-1", "Ana", "share-1");
  });

  it("stays QUIET when the person is still watching elsewhere", async () => {
    // No marker, because they have not left — their laptop is still in the room.
    gone = false;
    const res = await mod.POST(post({ name: "Ana", viewerId: "phone" }) as never);
    expect(res.status).toBe(200);
    expect(peerLeave).not.toHaveBeenCalled();
  });

  it("clears the peer cookie on THIS device either way", async () => {
    // Leaving on one screen must still sign that screen out, even when the marker
    // is withheld — otherwise "leave" did nothing visible where it was pressed.
    gone = false;
    const res = await mod.POST(post({ viewerId: "phone" }) as never);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("hooop_peer=;");
  });

  it("drops every screen when the client names none (older client)", async () => {
    await mod.POST(post({ name: "Ana" }) as never);
    expect(leave).toHaveBeenCalledWith("sess-1", "peer:share-1", undefined);
  });

  it("is peers only", async () => {
    participant = { kind: "host" };
    expect((await mod.POST(post({}) as never)).status).toBe(403);
  });
});
