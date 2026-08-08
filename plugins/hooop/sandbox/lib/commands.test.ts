import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("listSlashCommands — cwd-scoped project commands", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  let projectCwd: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-cmd-home-"));
    projectCwd = mkdtempSync(join(tmpdir(), "sandbox-cmd-project-"));
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeProjectCommand(cwd: string, name: string) {
    mkdirSync(join(cwd, ".claude", "commands"), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "commands", `${name}.md`),
      `---\ndescription: project command ${name}\n---\n# ${name}\n`
    );
  }

  it("includes commands from <cwd>/.claude/commands/ when cwd is provided", async () => {
    writeProjectCommand(projectCwd, "ship");
    const { listSlashCommands } = await import("./commands");
    const cmds = listSlashCommands(projectCwd).filter((c) => c.plugin === "project");
    expect(cmds.map((c) => c.name)).toEqual(["ship"]);
    expect(cmds[0].kind).toBe("command");
    expect(cmds[0].description).toBe("project command ship");
  });

  it("excludes project commands when no cwd is passed", async () => {
    writeProjectCommand(projectCwd, "ship");
    const { listSlashCommands } = await import("./commands");
    const names = listSlashCommands().map((c) => c.name);
    expect(names).not.toContain("ship");
  });
});

describe("built-in commands", () => {
  beforeEach(() => vi.resetModules());

  it("offers /compact and /cost but NOT /clear or /init", async () => {
    const { listSlashCommands } = await import("./commands");
    const builtins = listSlashCommands().filter((c) => c.kind === "builtin").map((c) => c.name);
    expect(builtins).toContain("compact");
    expect(builtins).toContain("cost");
    // Removed from the dashboard surface: /clear wipes a persistent session and
    // /init writes CLAUDE.md — neither belongs here.
    expect(builtins).not.toContain("clear");
    expect(builtins).not.toContain("init");
    // Intercepted commands still offered for autocomplete.
    expect(builtins).toEqual(expect.arrayContaining(["plan", "stop", "model", "auto-mode"]));
  });

  it("marks /auto-mode as requiring permission capability (and nothing else)", async () => {
    const { listSlashCommands } = await import("./commands");
    const builtins = listSlashCommands().filter((c) => c.kind === "builtin");
    const autoMode = builtins.find((c) => c.name === "auto-mode");
    expect(autoMode?.requires).toBe("permission");
    // Turn-capable commands (usable by any driver) carry no capability gate.
    expect(builtins.find((c) => c.name === "model")?.requires).toBeUndefined();
    expect(builtins.find((c) => c.name === "compact")?.requires).toBeUndefined();
  });

  it("marks exactly /compact and /cost as native passthrough (bare-forwarded)", async () => {
    const { NATIVE_PASSTHROUGH_COMMANDS } = await import("./commands");
    expect([...NATIVE_PASSTHROUGH_COMMANDS].sort()).toEqual(["compact", "cost"]);
    // hooop-intercepted commands must never be passed through to the model.
    expect(NATIVE_PASSTHROUGH_COMMANDS.has("plan")).toBe(false);
    expect(NATIVE_PASSTHROUGH_COMMANDS.has("stop")).toBe(false);
    expect(NATIVE_PASSTHROUGH_COMMANDS.has("model")).toBe(false);
  });
});
