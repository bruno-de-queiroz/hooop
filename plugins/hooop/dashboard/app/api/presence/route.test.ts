import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * The presence heartbeat doubles as the notification-suppression signal: the
 * sandbox can't see this registry (presence is dashboard-local), so the route
 * relays each beat. These tests pin that relay — and, more importantly, that a
 * sandbox failure never degrades presence itself, which is the reason the call
 * is fire-and-forget rather than awaited into the response.
 */

const pushPresence = vi.fn(async () => ({ ok: true }));
vi.mock("@/lib/sandbox-client", () => ({ client: { pushPresence: (...a: unknown[]) => pushPresence(...(a as [])) } }));

let participant: { kind: "host" | "peer" | "none"; shareId?: string } = { kind: "host" };
vi.mock("@/lib/peer-auth", () => ({
  participantOf: () => participant,
  forwardedParticipant: () => (participant.kind === "host" ? "host" : `peer:${participant.shareId}`),
}));

let mod: typeof import("./route");

function post(body: unknown): Request {
  return new Request("http://localhost/api/presence", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(async () => {
  vi.resetModules();
  pushPresence.mockClear();
  pushPresence.mockResolvedValue({ ok: true });
  participant = { kind: "host" };
  mod = await import("./route");
});

describe("presence heartbeat → notification suppression relay", () => {
  it("relays an active beat so the sender can skip a watching participant", async () => {
    const res = await mod.POST(post({ sessionId: "s1", name: "Bruno", active: true }) as never);
    expect(res.status).toBe(200);
    expect(pushPresence).toHaveBeenCalledWith("s1", true, "host");
  });

  it("relays a backgrounded tab as inactive, so notifications resume at once", async () => {
    await mod.POST(post({ sessionId: "s1", active: false }) as never);
    expect(pushPresence).toHaveBeenCalledWith("s1", false, "host");
  });

  it("treats an absent active flag as present", async () => {
    await mod.POST(post({ sessionId: "s1" }) as never);
    expect(pushPresence).toHaveBeenCalledWith("s1", true, "host");
  });

  it("relays a departure as inactive rather than leaving them marked present", async () => {
    await mod.POST(post({ sessionId: "s1", leaving: true }) as never);
    expect(pushPresence).toHaveBeenCalledWith("s1", false, "host");
  });

  it("forwards a peer under their own share identity", async () => {
    participant = { kind: "peer", shareId: "share-1" };
    await mod.POST(post({ sessionId: "s1", active: true }) as never);
    expect(pushPresence).toHaveBeenCalledWith("s1", true, "peer:share-1");
  });

  it("still answers with the roster when the sandbox relay fails", async () => {
    // Presence is UI awareness. A sandbox blip must not stop avatars updating —
    // the beat simply ages out sandbox-side and we notify, which is the safe
    // direction.
    pushPresence.mockRejectedValue(new Error("socket down"));
    const res = await mod.POST(post({ sessionId: "s1", active: true }) as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("participants");
  });

  it("rejects a non-participant before relaying anything", async () => {
    participant = { kind: "none" };
    const res = await mod.POST(post({ sessionId: "s1" }) as never);
    expect(res.status).toBe(403);
    expect(pushPresence).not.toHaveBeenCalled();
  });

  it("requires a session id", async () => {
    const res = await mod.POST(post({ active: true }) as never);
    expect(res.status).toBe(400);
    expect(pushPresence).not.toHaveBeenCalled();
  });
});
