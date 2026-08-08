import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Exercises the skills fs.watch → skillsBus pipeline. These run on macOS in
 * dev/CI where recursive fs.watch is native; the production container is Linux
 * node:24, where recursive fs.watch (landed in 20.13) is available. The key assertion is the
 * NESTED case: a SKILL.md written inside a freshly-created `<name>/` dir must
 * still fire — that's the gotcha a non-recursive watch would miss.
 *
 * fs.watch (FSEvents on macOS / inotify on Linux) can coalesce or briefly drop
 * events under heavy parallel-suite CPU load, which made a write-once-and-wait
 * assertion flaky. `awaitChange` re-triggers the write on an interval until the
 * bus fires, so the assertion proves "a SKILL.md change emits a change" without
 * being hostage to single-event delivery latency.
 */
function awaitChange(
  bus: EventEmitter,
  retrigger: (i: number) => void,
  budgetMs = 15000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    const deadline = setTimeout(() => {
      bus.off("change", on);
      clearInterval(iv);
      reject(new Error("timed out waiting for skillsBus change"));
    }, budgetMs);
    function on() {
      clearTimeout(deadline);
      clearInterval(iv);
      bus.off("change", on);
      resolve();
    }
    bus.on("change", on);
    retrigger(i++);
    const iv = setInterval(() => retrigger(i++), 1000);
  });
}

describe("startSkillsWatcher — push notifications", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  // Re-imported per test so paths.ts recomputes HOME-derived constants and we
  // get a fresh module-level skillsBus.
  let mod: typeof import("./skills");

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-skills-watch-"));
    process.env.HOME = fakeHome;
    vi.resetModules();
    mod = await import("./skills");
  });

  afterEach(() => {
    try { mod.stopSkillsWatcher(); } catch { /* ignore */ }
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
  });

  function writeUserSkill(name: string) {
    const dir = join(fakeHome, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
  }

  it("creates ~/.claude/skills so the global watch is always armed", () => {
    expect(existsSync(join(fakeHome, ".claude", "skills"))).toBe(false);
    mod.startSkillsWatcher();
    expect(existsSync(join(fakeHome, ".claude", "skills"))).toBe(true);
  });

  it("fires on a NEW skill (nested SKILL.md inside a new dir)", async () => {
    mod.startSkillsWatcher();
    await expect(
      awaitChange(mod.skillsBus, (i) => writeUserSkill(`brand-new-${i}`)),
    ).resolves.toBeUndefined();
  }, 20000);

  it("coalesces a burst of writes into a single change emit", async () => {
    mod.startSkillsWatcher();
    let count = 0;
    mod.skillsBus.on("change", () => { count += 1; });
    // Scaffold several skills back-to-back, like an agent authoring a few.
    writeUserSkill("one");
    writeUserSkill("two");
    writeUserSkill("three");
    // Wait past the debounce window plus fs latency.
    await new Promise((r) => setTimeout(r, 500));
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(2); // debounced — not one-per-file
  });

  it("startSkillsWatcher is idempotent", () => {
    mod.startSkillsWatcher();
    expect(() => mod.startSkillsWatcher()).not.toThrow();
  });

  it("stopSkillsWatcher halts further emits", async () => {
    mod.startSkillsWatcher();
    mod.stopSkillsWatcher();
    let count = 0;
    mod.skillsBus.on("change", () => { count += 1; });
    writeUserSkill("after-stop");
    await new Promise((r) => setTimeout(r, 500));
    expect(count).toBe(0);
  });
});

function writeSkillUnder(root: string, name: string) {
  const dir = join(root, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`);
}

describe("syncProjectSkillWatchers — per-cwd project skills (Phase 2)", () => {
  let prevHome: string | undefined;
  let fakeHome: string;
  let projectCwd: string;
  let mod: typeof import("./skills");

  beforeEach(async () => {
    prevHome = process.env.HOME;
    fakeHome = mkdtempSync(join(tmpdir(), "sandbox-skills-home-"));
    projectCwd = mkdtempSync(join(tmpdir(), "sandbox-skills-proj-"));
    process.env.HOME = fakeHome;
    vi.resetModules();
    mod = await import("./skills");
  });

  afterEach(() => {
    try { mod.stopSkillsWatcher(); } catch { /* ignore */ }
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectCwd, { recursive: true, force: true });
  });

  it("fires when a skill is written under a watched project cwd", async () => {
    // Steady state: the skills dir already exists, so it's watched recursively.
    mkdirSync(join(projectCwd, ".claude", "skills"), { recursive: true });
    mod.syncProjectSkillWatchers([projectCwd]);
    await expect(
      awaitChange(mod.skillsBus, (i) => writeSkillUnder(projectCwd, `proj-skill-${i}`)),
    ).resolves.toBeUndefined();
  }, 20000);

  it("re-arms from an ancestor when .claude/skills appears later", async () => {
    // `.claude` exists but `.claude/skills` doesn't yet — the watcher arms on
    // the nearest existing ancestor (`.claude`) and must re-arm + fire once the
    // skills dir is created under it. (Arming on `.claude` rather than the cwd
    // keeps the watch adjacent to the target so the test isn't at the mercy of
    // FSEvents coalescing a deep recursive mkdir under heavy parallel load.)
    mkdirSync(join(projectCwd, ".claude"), { recursive: true });
    expect(existsSync(join(projectCwd, ".claude", "skills"))).toBe(false);
    mod.syncProjectSkillWatchers([projectCwd]);
    await expect(
      awaitChange(mod.skillsBus, (i) => {
        // Mirror production: the watcher set is reconciled on every sessionsBus
        // change. Re-syncing each retry re-arms onto the now-existing skills/
        // dir even if FSEvents missed its creation event, then the write fires.
        writeSkillUnder(projectCwd, `late-skill-${i}`);
        mod.syncProjectSkillWatchers([projectCwd]);
      }),
    ).resolves.toBeUndefined();
  }, 20000);

  it("closes a watcher when its cwd drops out of the reconciled set", async () => {
    mkdirSync(join(projectCwd, ".claude", "skills"), { recursive: true });
    mod.syncProjectSkillWatchers([projectCwd]);
    mod.syncProjectSkillWatchers([]); // projectCwd removed (workspace stays)
    let count = 0;
    mod.skillsBus.on("change", () => { count += 1; });
    writeSkillUnder(projectCwd, "after-removal");
    await new Promise((r) => setTimeout(r, 500));
    expect(count).toBe(0);
  });
});
