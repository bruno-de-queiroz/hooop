import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("listSkills — cwd-scoped project skills", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  let projectCwd: string;

  beforeEach(() => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-skills-home-"));
    projectCwd = mkdtempSync(join(tmpdir(), "sandbox-skills-project-"));
    process.env.HOME = fakeHome;
    vi.resetModules();
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  function writeProjectSkill(cwd: string, name: string) {
    mkdirSync(join(cwd, ".claude", "skills", name), { recursive: true });
    writeFileSync(
      join(cwd, ".claude", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: project skill ${name}\n---\n# ${name}\n`
    );
  }

  function writeUserSkill(name: string) {
    mkdirSync(join(fakeHome, ".claude", "skills", name), { recursive: true });
    writeFileSync(
      join(fakeHome, ".claude", "skills", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: user skill ${name}\n---\n`
    );
  }

  it("includes skills from <cwd>/.claude/skills/ when cwd is provided", async () => {
    writeProjectSkill(projectCwd, "project-skill");
    const { listSkills } = await import("./skills");
    const names = listSkills(projectCwd).map((s) => s.name);
    expect(names).toContain("project-skill");
  });

  it("excludes project skills when no cwd is passed", async () => {
    writeProjectSkill(projectCwd, "project-skill");
    const { listSkills } = await import("./skills");
    const names = listSkills().map((s) => s.name);
    expect(names).not.toContain("project-skill");
  });

  it("project-scoped skill shadows a same-named user-global skill", async () => {
    // Claude TUI behavior: the closer scope wins. Without dedupe the
    // same name would appear twice and the dashboard count would diverge
    // from what Claude actually invokes.
    writeUserSkill("repeated");
    writeProjectSkill(projectCwd, "repeated");
    const { listSkills } = await import("./skills");
    const matches = listSkills(projectCwd).filter((s) => s.name === "repeated");
    expect(matches).toHaveLength(1);
    expect(matches[0].description).toBe("project skill repeated");
  });

  it("returns empty list when cwd has no .claude/skills dir", async () => {
    const { listSkills } = await import("./skills");
    expect(listSkills(projectCwd)).toEqual([]);
  });
});
