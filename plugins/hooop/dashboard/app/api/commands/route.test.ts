import { vi, describe, it, expect, beforeEach } from "vitest";

const listSlashCommandsMock = vi.fn();
vi.mock("@/lib/sandbox-client", () => ({
  client: { listSlashCommands: (opts?: any) => listSlashCommandsMock(opts) },
}));

let mod: typeof import("./route");

beforeEach(async () => {
  vi.resetModules();
  listSlashCommandsMock.mockReset();
  mod = await import("./route");
});

describe("GET /api/commands", () => {
  it("returns empty array when listSlashCommands returns empty", async () => {
    listSlashCommandsMock.mockReturnValueOnce([]);

    const res = await mod.GET({ nextUrl: { searchParams: new URLSearchParams() } } as any);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns mixed command kinds: builtin, skill, command", async () => {
    listSlashCommandsMock.mockReturnValueOnce([
      {
        name: "compact",
        description: "Compact the conversation",
        plugin: "built-in",
        kind: "builtin",
      },
      {
        name: "my-skill",
        description: "A custom skill",
        plugin: "user-skill",
        kind: "skill",
      },
      {
        name: "my-plugin:my-cmd",
        description: "A plugin command",
        plugin: "my-plugin@marketplace",
        kind: "command",
      },
    ]);

    const res = await mod.GET({ nextUrl: { searchParams: new URLSearchParams() } } as any);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(3);
    expect(json[0].kind).toBe("builtin");
    expect(json[1].kind).toBe("skill");
    expect(json[2].kind).toBe("command");
  });

  it("returns response as JSON", async () => {
    listSlashCommandsMock.mockReturnValueOnce([
      {
        name: "test-cmd",
        description: "Test",
        plugin: "test",
        kind: "command",
      },
    ]);

    const res = await mod.GET({ nextUrl: { searchParams: new URLSearchParams() } } as any);
    expect(res.headers.get("content-type")).toBe("application/json");
  });
});
