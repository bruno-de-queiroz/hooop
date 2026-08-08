import { vi, describe, it, expect, beforeEach } from "vitest";

const startSkillRunMock = vi.fn();
const isValidSkillNameMock = vi.fn((_name: string) => true);

vi.mock("@/lib/sandbox-client", () => ({
  client: {
    startSkillRun: (skill: string, args?: string, participant?: string) =>
      startSkillRunMock(skill, args, participant),
    isValidSkillName: (name: string) => isValidSkillNameMock(name),
  },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  startSkillRunMock.mockReset();
  isValidSkillNameMock.mockReset();
  isValidSkillNameMock.mockReturnValue(true);
  mod = await import("./route");
});

function post(participant?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (participant) headers["x-hooop-participant"] = participant;
  const req = new Request("http://x/api/skill/foo/run", {
    method: "POST",
    headers,
    body: JSON.stringify({ args: "--flag" }),
  });
  return mod.POST(req as any, { params: Promise.resolve({ name: "foo" }) });
}

describe("POST /api/skill/[name]/run", () => {
  it("launches for the host and forwards the participant", async () => {
    startSkillRunMock.mockResolvedValueOnce({ sessionId: "s1" });
    const res = await post("host");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessionId: "s1" });
    expect(startSkillRunMock).toHaveBeenCalledWith("foo", "--flag", "host");
  });

  it("rejects a peer (any capability) with 403 and never launches", async () => {
    const res = await post("peer:share-abc");
    expect(res.status).toBe(403);
    expect(startSkillRunMock).not.toHaveBeenCalled();
  });

  it("rejects a request with no participant header", async () => {
    const res = await post(undefined);
    expect(res.status).toBe(403);
    expect(startSkillRunMock).not.toHaveBeenCalled();
  });
});
