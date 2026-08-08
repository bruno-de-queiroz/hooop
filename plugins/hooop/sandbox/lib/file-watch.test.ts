import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execFileAsync = promisify(execFile);

// Mirrors skills.watcher.test.ts's style: fresh module per test (so
// module-level maps/buses don't leak between cases), a mocked
// `listActiveSessions` to control which sessions "own" the watched cwd, and a
// retriggering awaitChange helper to shield the assertion from fs.watch event
// coalescing/latency under parallel-suite load.

vi.mock("./active-sessions", () => ({ listActiveSessions: vi.fn(() => []) }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until `pred` holds, polling. Preferred over sleeping a fixed
 * "should be enough" interval whenever the thing under test is a debounced
 * timer: it returns the moment the event lands (fast on an idle machine)
 * and still tolerates a loaded one (where a 400ms timer can fire 100ms+
 * late), instead of trading one for the other. */
async function pollUntil(pred: () => boolean, budgetMs = 8000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("pollUntil: condition never became true");
    await sleep(stepMs);
  }
}

// Gaps between retriggers, cycled: two writes 300ms apart, then a 700ms quiet
// window. Arming is async (it awaits a git-backed scan), so the first write
// reliably lands before the watcher exists and is missed — the second catches
// it ~300ms later rather than a full second later, which is worth ~5s across
// this file.
//
// The quiet window is not padding, it's the whole reason this is a cycle
// rather than a short flat interval: the emit is a pure TRAILING debounce
// (FILES_EMIT_DEBOUNCE_MS, 300ms), so every delivered event resets it, and a
// cadence at or under that never lets it fire AT ALL — measured, at a flat
// 250ms interval 13 of this file's 16 tests time out instead of running
// faster. A flat 500ms "works" but leaves only 200ms of margin, and fs event
// delivery is jittery enough (macOS coalesces and delivers in bursts) to eat
// that. 700ms quiet keeps the margin the original 1s interval had.
const RETRIGGER_GAPS_MS = [300, 700];

function awaitChange(bus: EventEmitter, retrigger: (i: number) => void, budgetMs = 15000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let i = 0;
    let step = 0;
    let stopped = false;
    let next: ReturnType<typeof setTimeout> | undefined;
    // `stopped` as well as clearing the timer: `tick` schedules the next one
    // AFTER calling `retrigger`, so a resolve reached from inside that call
    // would otherwise leave one behind — and a retrigger that outlives its
    // test writes into a tmpdir `afterEach` has already deleted, throwing
    // from a timer callback where no test can catch it.
    function stop() {
      stopped = true;
      clearTimeout(deadline);
      if (next) clearTimeout(next);
      bus.off("change", on);
    }
    const deadline = setTimeout(() => {
      stop();
      reject(new Error("timed out waiting for filesBus change"));
    }, budgetMs);
    function on(payload: unknown) {
      stop();
      resolve(payload);
    }
    function tick() {
      retrigger(i++);
      if (stopped) return;
      next = setTimeout(tick, RETRIGGER_GAPS_MS[step++ % RETRIGGER_GAPS_MS.length]);
    }
    bus.on("change", on);
    tick();
  });
}

describe("file-watch — live filesystem change notifications", () => {
  let projectCwd: string;
  let mod: typeof import("./file-watch");
  let activeSessions: typeof import("./active-sessions");

  beforeEach(async () => {
    projectCwd = mkdtempSync(join(tmpdir(), "sandbox-file-watch-"));
    vi.resetModules();
    mod = await import("./file-watch");
    activeSessions = await import("./active-sessions");
  });

  afterEach(() => {
    try { mod.stopFileWatcher(); } catch { /* ignore */ }
    // Retries because several tests below retrigger with a fire-and-forget
    // `git commit`/`git checkout` (see `fireGit`) — so when the awaited event
    // finally arrives, an earlier git process can still be mid-write in here,
    // and a plain recursive delete then fails with ENOTEMPTY: it enumerated
    // the directory, git re-created something in it, and the final rmdir
    // found it non-empty. Node retries exactly this error class (also EBUSY /
    // EPERM) with linear backoff when `recursive` is set, which is ample for
    // a git process that has a millisecond or two left to run. The race is
    // two-sided — `fireGit` covers the half where git loses instead.
    rmSync(projectCwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  function setSessions(sessions: Array<{ sessionId: string; cwd: string }>) {
    (activeSessions.listActiveSessions as unknown as ReturnType<typeof vi.fn>).mockReturnValue(sessions);
  }

  /** Run git in the project, fire-and-forget, tolerating failure.
   *
   * `awaitChange`'s retrigger is synchronous, so these can't be awaited: the
   * last one fired is still running when the awaited event arrives, the test
   * returns and `afterEach` deletes the repo out from under it. It then dies
   * ("fatal: cannot lock ref 'HEAD'"), and a bare `void promise` leaves that
   * an unhandled rejection — which fails the whole vitest run with a nonzero
   * exit even when all 498 tests pass, as it did in CI. Losing a retrigger
   * that only exists to nudge a watcher we've already heard from is not a
   * failure, so swallow it. */
  function fireGit(args: string[]): void {
    execFileAsync("git", args, { cwd: projectCwd }).catch(() => { /* test over, repo gone */ });
  }

  it("fires {sessionId, cwd} when a tracked file changes", async () => {
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    const payload = await awaitChange(mod.filesBus, (i) =>
      writeFileSync(join(projectCwd, "src", `f${i}.txt`), "x"),
    );
    expect(payload).toEqual({ sessionId: "s1", cwd: projectCwd });
  }, 20000);

  it("does not fire for changes inside a denylisted directory (node_modules)", async () => {
    mkdirSync(join(projectCwd, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    // Prove the watcher is actually armed (and filtering, not just silent)
    // before asserting the negative case.
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, "src", `warmup${i}.txt`), "x"));

    let count = 0;
    mod.filesBus.on("change", () => { count += 1; });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(projectCwd, "node_modules", "pkg", `index${i}.js`), "x");
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500)); // past the debounce window
    expect(count).toBe(0);
  }, 20000);

  it("never anchors a watch (recursive OR shallow) rooted inside a denylisted directory — the OS itself must never see it, not just filtered events", async () => {
    // The event-level test above ("does not fire…") only proves we don't
    // REACT to churn inside node_modules — it can't tell whether the OS is
    // still physically watching it (verified empirically that a single
    // recursive fs.watch registers one inotify watch per file/dir below its
    // root regardless of any JS-side filtering — see this module's doc
    // comment). This test inspects `scanCwd`'s actual partitioning instead:
    // no anchor's path may contain a denylisted segment anywhere.
    mkdirSync(join(projectCwd, "node_modules", "pkg", "deep"), { recursive: true });
    writeFileSync(join(projectCwd, "node_modules", "pkg", "deep", "f.js"), "x");
    mkdirSync(join(projectCwd, "packages", "a", "node_modules"), { recursive: true });
    writeFileSync(join(projectCwd, "packages", "a", "node_modules", "f.js"), "x");
    mkdirSync(join(projectCwd, "packages", "b"), { recursive: true });
    writeFileSync(join(projectCwd, "packages", "b", "index.ts"), "x");
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    writeFileSync(join(projectCwd, "src", "index.ts"), "x");

    const scan = await mod.__testing__.scanCwd(projectCwd);
    const allAnchors = [...scan.recursiveRoots, ...scan.shallowDirs];
    expect(allAnchors.length).toBeGreaterThan(0);
    for (const { abs } of allAnchors) {
      const rel = abs.slice(projectCwd.length).replace(/^\/+/, "");
      const segments = rel.split("/").filter(Boolean);
      expect(segments).not.toContain("node_modules");
    }
    // Sanity: ordinary directories DID get anchored (proves this isn't
    // trivially passing because nothing was scanned at all) — "packages"
    // itself is dirty (its child "a/node_modules" is excluded), so it must
    // be a shallow dir, while "packages/b" (fully clean) and "src" (fully
    // clean) should each be recursive anchors. Exact-set (not
    // arrayContaining) so this also catches redundant EXTRA anchors, not
    // just missing ones — see the next test for why that matters.
    const recursiveRel = scan.recursiveRoots.map((a) => a.rel).sort();
    expect(recursiveRel).toEqual(["packages/b", "src"]);
    const shallowRel = scan.shallowDirs.map((a) => a.rel).sort();
    expect(shallowRel).toEqual(["", "packages", "packages/a"]);
  });

  it("anchors a deeply-nested clean subtree ONCE at its shallowest point, never redundantly at every level below it", async () => {
    // Regression test: an earlier version of `scanCwd` decided anchoring
    // bottom-up (anchor every clean directory as soon as `walk` on it
    // returns true), which meant a clean `src/components/button/` got
    // THREE fully-overlapping recursive anchors — one each at
    // "src/components/button", "src/components", AND "src" — instead of
    // just one at "src" (its nearest dirty ancestor's clean child).
    // Measured cost of that (see scanCwd's doc comment): NOT extra inotify
    // descriptors — libuv shares one inotify instance per event loop and
    // inotify dedupes by path — but one extra FSWatcher plus one DUPLICATE
    // callback per level per event, so every hot-path event did its
    // isPruned/statSync/debounce work once per redundant level.
    mkdirSync(join(projectCwd, "src", "components", "button"), { recursive: true });
    writeFileSync(join(projectCwd, "src", "components", "button", "Button.tsx"), "x");
    mkdirSync(join(projectCwd, "node_modules"), { recursive: true });
    writeFileSync(join(projectCwd, "node_modules", "f.js"), "x");

    const scan = await mod.__testing__.scanCwd(projectCwd);
    const recursiveRel = scan.recursiveRoots.map((a) => a.rel).sort();
    expect(recursiveRel).toEqual(["src"]); // NOT ["src", "src/components", "src/components/button"]
    const shallowRel = scan.shallowDirs.map((a) => a.rel).sort();
    expect(shallowRel).toEqual([""]);
  });

  // The re-arm is debounced on a real (not fake) timer, because the events
  // that drive it come from inotify — genuinely asynchronous delivery that
  // no fake clock can advance. So these three tests wait on wall-clock
  // time, and at the production 2s debounce they alone accounted for ~18s
  // of this suite's runtime. Shrinking the constant keeps exactly what they
  // test (ordering and coalescing of debounced re-arms, which are
  // scale-free) and buys back ~15s. Two rules keep them honest at the
  // smaller value: assert a re-arm HAPPENED by polling for it (never by
  // sleeping "long enough"), and assert one DIDN'T by sleeping a multiple
  // of the debounce.
  describe("self-healing re-arm", () => {
    const REARM_MS = 400;
    beforeEach(() => mod.__testing__.setRearmDebounceMs(REARM_MS));

    it("a brand-new CLEAN directory born inside a shallow (dirty) dir gets its own live coverage after a debounced re-arm", async () => {
      // cwd is dirty (node_modules sits directly inside it), so it becomes a
      // `shallowDirs` entry — a non-recursive watch that only ever sees a new
      // top-level entry APPEAR, never anything born more than one level below
      // it. Without the self-heal, a whole new feature directory created
      // mid-session and immediately worked in several levels deep would go
      // completely untracked for the rest of the session — a real regression
      // from this file's old single-recursive-watch design.
      mkdirSync(join(projectCwd, "node_modules"), { recursive: true });
      setSessions([{ sessionId: "s1", cwd: projectCwd }]);
      mod.syncFileWatchers([projectCwd]);
      await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, `warmup${i}.txt`), "x"));
      const tokenBefore = mod.__testing__.getArmToken(projectCwd);

      // Born all at once, 2 levels deep — the shallow watch fires once for
      // "feature" appearing, but that alone proves nothing about coverage
      // below it (this file's `armGitSignalWatches`-adjacent tests already
      // cover the "does a shallow watch see its OWN direct children" case).
      mkdirSync(join(projectCwd, "feature", "nested"), { recursive: true });
      writeFileSync(join(projectCwd, "feature", "nested", "a.txt"), "x");

      await pollUntil(() => mod.__testing__.getArmToken(projectCwd) > tokenBefore);

      // The functional proof: an edit 2 levels below "feature" — impossible
      // for the ORIGINAL shallow watch to ever see — now fires, because the
      // re-arm gave "feature" its own recursive anchor.
      const payload = await awaitChange(mod.filesBus, (i) =>
        writeFileSync(join(projectCwd, "feature", "nested", `b${i}.txt`), "x"),
      );
      expect(payload).toEqual({ sessionId: "s1", cwd: projectCwd });
    }, 25000);

    it("a newly-created EXCLUDED directory inside an established recursive anchor triggers a re-arm, but an ordinary file edit never does", async () => {
      // cwd starts fully clean, so scanCwd gives it ONE recursive anchor
      // covering everything — including, per Linux's auto-extending
      // recursive fs.watch, anything created under it later.
      setSessions([{ sessionId: "s1", cwd: projectCwd }]);
      mod.syncFileWatchers([projectCwd]);
      await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, `warmup${i}.txt`), "x"));
      const tokenAfterWarmup = mod.__testing__.getArmToken(projectCwd);

      // An ORDINARY file edit — the overwhelmingly common event — must never
      // by itself trigger the (comparatively expensive, ~200ms warm on a
      // real repo — see this file's module doc comment) full re-arm. The one
      // assertion here that has to sleep rather than poll: proving absence
      // means giving the timer that would have fired every chance to.
      for (let i = 0; i < 5; i++) writeFileSync(join(projectCwd, `plain${i}.txt`), "x");
      await sleep(REARM_MS * 3);
      expect(mod.__testing__.getArmToken(projectCwd)).toBe(tokenAfterWarmup);

      // Simulate `npm install` happening mid-session: node_modules didn't
      // exist at arm time, so scanCwd never got a chance to exclude it —
      // Linux's recursive fs.watch auto-extends to it anyway, physically
      // watching it until something re-partitions.
      mkdirSync(join(projectCwd, "node_modules", "pkg"), { recursive: true });
      await pollUntil(() => mod.__testing__.getArmToken(projectCwd) > tokenAfterWarmup);

      // The re-arm's own fresh scan agrees node_modules is now excluded —
      // confirming this is scanCwd's real partitioning kicking in again
      // (already covered directly by the "never anchors a watch…" test
      // above), not just a token bump with no actual effect.
      const rescan = await mod.__testing__.scanCwd(projectCwd);
      for (const { abs } of [...rescan.recursiveRoots, ...rescan.shallowDirs]) {
        expect(abs.split("/")).not.toContain("node_modules");
      }
    }, 25000);

    it("coalesces a whole burst of directory churn into ONE re-arm (npm-install storm guard)", async () => {
      // The scenario this protects: `npm install` creates tens of thousands of
      // directories, every one of them a pruned "rename" event delivered to an
      // already-established recursive anchor. `maybeScheduleRearmForNewDir`
      // must short-circuit on an already-pending re-arm BEFORE its statSync,
      // or that syscall (plus a clearTimeout/setTimeout pair) runs per event on
      // the server's single-threaded event loop — the same class of stall the
      // permission gate went offline from. The observable proof is the arm
      // count: a burst must cost exactly ONE re-arm, and the re-arm must fire
      // on a fixed deadline from the FIRST event rather than being pushed back
      // indefinitely by continuous churn (which is what resetting the timer on
      // every event would do).
      setSessions([{ sessionId: "s1", cwd: projectCwd }]);
      mod.syncFileWatchers([projectCwd]);
      await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, `warmup${i}.txt`), "x"));
      const before = mod.__testing__.getArmToken(projectCwd);

      // Churn that does NOT stop until we've observed the re-arm, so a
      // timer-resetting implementation could never satisfy the wait below.
      // Batched per tick to make it a genuine storm (hundreds of pruned
      // events) rather than a trickle paced by the interval.
      let created = 0;
      const churn = setInterval(() => {
        for (let i = 0; i < 20; i++) {
          mkdirSync(join(projectCwd, "node_modules", `pkg-${created++}`), { recursive: true });
        }
      }, 40);
      try {
        // Fires on a deadline from the FIRST event: reached while the churn
        // is still running, not after it stops.
        await pollUntil(() => mod.__testing__.getArmToken(projectCwd) > before);
      } finally {
        clearInterval(churn);
      }
      const during = mod.__testing__.getArmToken(projectCwd);
      expect(created).toBeGreaterThan(100);
      // Exactly one re-arm for the whole burst, not one per directory. The
      // poll above returns within ~10ms of the first re-arm, i.e. a full
      // debounce interval before a second one could possibly fire, so this
      // needs no wall-clock margin to be meaningful.
      expect(during - before).toBe(1);

      // Let everything settle: at most one further re-arm, for whatever
      // churn landed between that first one firing and the interval being
      // cleared — never one per directory.
      await sleep(REARM_MS * 3);
      expect(mod.__testing__.getArmToken(projectCwd) - during).toBeLessThanOrEqual(1);
    }, 25000);
  });

  it("layers .gitignore pruning on top of the denylist when cwd is a git repo", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd: projectCwd });
    mkdirSync(join(projectCwd, "build-output"), { recursive: true });
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    writeFileSync(join(projectCwd, ".gitignore"), "build-output/\n");
    // git only reports a directory as "!!" ignored once it's non-empty — an
    // empty dir is invisible to `git status` regardless of .gitignore, so
    // seed it before arming or the scan won't see it as ignored yet.
    writeFileSync(join(projectCwd, "build-output", "seed.txt"), "x");
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, "src", `warmup${i}.txt`), "x"));

    let count = 0;
    mod.filesBus.on("change", () => { count += 1; });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(projectCwd, "build-output", `out${i}.txt`), "x");
      await new Promise((r) => setTimeout(r, 100));
    }
    await new Promise((r) => setTimeout(r, 500));
    expect(count).toBe(0);
  }, 20000);

  it("fires on a commit even though no working-tree file is touched", async () => {
    // A commit only writes inside .git/ (the index + the branch ref) — the
    // main tree watch never enters .git (denylisted), so without the
    // dedicated .git/HEAD + .git/index + .git/refs/heads watches, the
    // "files to review" pill would stay stuck showing already-committed
    // files forever after a commit.
    await execFileAsync("git", ["init", "-q"], { cwd: projectCwd });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "warmup"],
      { cwd: projectCwd },
    );
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    writeFileSync(join(projectCwd, "src", "a.txt"), "hello");
    await execFileAsync("git", ["add", "-A"], { cwd: projectCwd });
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    // Confirm the watcher is actually armed before testing the git-only path.
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, "src", `warmup${i}.txt`), "x"));

    const payload = await awaitChange(mod.filesBus, (i) => {
      fireGit(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", `commit-${i}`]);
    });
    expect(payload).toEqual({ sessionId: "s1", cwd: projectCwd });
  }, 20000);

  it("keeps firing across repeated branch switches (survives the .git/HEAD lockfile-rename swap)", async () => {
    // git conventionally rewrites .git/HEAD (and .git/index) via a
    // lockfile-then-rename (e.g. `HEAD.lock` -> `HEAD`), not an in-place
    // write. Watching that file directly is bound to the ORIGINAL inode: the
    // first such swap fires once and then goes permanently deaf, so only
    // the FIRST branch switch of a session would ever register — every
    // switch after that would silently do nothing. Two pre-existing
    // branches with identical trees isolate this precisely: switching
    // between them touches only HEAD (no working-tree diff, no new/changed
    // ref file under refs/heads, whose own directory watch would otherwise
    // mask the bug).
    await execFileAsync("git", ["init", "-q"], { cwd: projectCwd });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "warmup"],
      { cwd: projectCwd },
    );
    await execFileAsync("git", ["branch", "other"], { cwd: projectCwd });
    const defaultBranch = (await execFileAsync("git", ["branch", "--show-current"], { cwd: projectCwd })).stdout.trim();

    mkdirSync(join(projectCwd, "src"), { recursive: true });
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, "src", `warmup${i}.txt`), "x"));

    const checkout = (branch: string) => fireGit(["checkout", "-q", branch]);

    // First switch after arming — this alone passed even with the bug.
    await awaitChange(mod.filesBus, () => checkout("other"));
    // Second switch — this is exactly what died under the single-file-watch
    // bug (the first rename already consumed the only event the watch would
    // ever deliver).
    const payload = await awaitChange(mod.filesBus, () => checkout(defaultBranch));
    expect(payload).toEqual({ sessionId: "s1", cwd: projectCwd });
  }, 20000);

  it("fires on a commit to a nested (slash-containing) branch name", async () => {
    // git stores branch "fix/foo" as the nested ref file
    // .git/refs/heads/fix/foo, not a direct child of refs/heads — a
    // non-recursive watch on refs/heads silently misses every commit on any
    // such branch (verified empirically before fixing). This repo's own
    // convention (fix/*, feat/*) is exactly this case, not an edge case.
    await execFileAsync("git", ["init", "-q"], { cwd: projectCwd });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "warmup"],
      { cwd: projectCwd },
    );
    await execFileAsync("git", ["checkout", "-q", "-b", "fix/nested-branch"], { cwd: projectCwd });
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, "src", `warmup${i}.txt`), "x"));

    const payload = await awaitChange(mod.filesBus, (i) => {
      fireGit(["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", `nested-commit-${i}`]);
    });
    expect(payload).toEqual({ sessionId: "s1", cwd: projectCwd });
  }, 20000);

  it("emits one event per live session sharing the same cwd", async () => {
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    setSessions([
      { sessionId: "s1", cwd: projectCwd },
      { sessionId: "s2", cwd: projectCwd },
    ]);
    mod.syncFileWatchers([projectCwd]);

    const seen: unknown[] = [];
    const done = new Promise<void>((resolve) => {
      mod.filesBus.on("change", (p) => {
        seen.push(p);
        if (seen.length >= 2) resolve();
      });
    });
    const iv = setInterval(() => writeFileSync(join(projectCwd, "src", `f${Date.now()}.txt`), "x"), 1000);
    writeFileSync(join(projectCwd, "src", "first.txt"), "x");
    await Promise.race([
      done,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), 15000)),
    ]);
    clearInterval(iv);
    expect(seen).toEqual(
      expect.arrayContaining([
        { sessionId: "s1", cwd: projectCwd },
        { sessionId: "s2", cwd: projectCwd },
      ]),
    );
  }, 20000);

  it("stops emitting once a cwd drops out of the reconciled set", async () => {
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, "src", `warmup${i}.txt`), "x"));

    mod.syncFileWatchers([]); // cwd removed
    let count = 0;
    mod.filesBus.on("change", () => { count += 1; });
    writeFileSync(join(projectCwd, "src", "after-removal.txt"), "x");
    await new Promise((r) => setTimeout(r, 500));
    expect(count).toBe(0);
  }, 20000);

  it("watches a not-yet-existing cwd via ancestor fallback and re-arms once it appears", async () => {
    const missingCwd = join(projectCwd, "not-yet-cloned");
    setSessions([{ sessionId: "s1", cwd: missingCwd }]);
    expect(existsSync(missingCwd)).toBe(false);
    mod.syncFileWatchers([missingCwd]);

    await expect(
      awaitChange(mod.filesBus, (i) => {
        mkdirSync(missingCwd, { recursive: true });
        writeFileSync(join(missingCwd, `late${i}.txt`), "x");
        mod.syncFileWatchers([missingCwd]); // mirrors production reconcile-on-tick
      }),
    ).resolves.toEqual({ sessionId: "s1", cwd: missingCwd });
  }, 20000);

  it("caps how many nested repos get dedicated git-status watches (MAX_NESTED_REPO_WATCHES)", async () => {
    // Shrink the cap (instead of actually creating 50+ repos) so the
    // boundary is exercised at a fast, deterministic scale. `commit
    // --allow-empty` touches ONLY .git internals (no working-tree file), so
    // it only produces an observable "change" event via a repo's DEDICATED
    // HEAD/index watch — the outer recursive content watch can't cover for
    // a capped-out repo the way it does for ordinary file edits.
    mod.__testing__.setMaxNestedRepoWatches(3);
    const N = 6;
    for (let i = 0; i < N; i++) {
      const repoDir = join(projectCwd, `repo${i}`);
      mkdirSync(repoDir, { recursive: true });
      await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
      await execFileAsync(
        "git",
        ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"],
        { cwd: repoDir },
      );
    }
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, `repo0`, `warmup${i}.txt`), "x"));

    let fired = 0;
    mod.filesBus.on("change", () => { fired += 1; });
    for (let i = 0; i < N; i++) {
      await execFileAsync(
        "git",
        ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", `c-${i}`],
        { cwd: join(projectCwd, `repo${i}`) },
      );
      await new Promise((r) => setTimeout(r, 500)); // clear the debounce window before the next commit
    }
    // Exactly the cap, regardless of WHICH 3 of the 6 sibling repos
    // happened to be scanned first (readdir order isn't guaranteed) — a
    // regression back to "uncapped" would fire 6 times here, not 3.
    expect(fired).toBe(3);
  }, 30000);

  it("syncFileWatchers is a no-op for an already-armed cwd (no rescan)", async () => {
    mkdirSync(join(projectCwd, "src"), { recursive: true });
    setSessions([{ sessionId: "s1", cwd: projectCwd }]);
    mod.syncFileWatchers([projectCwd]);
    await awaitChange(mod.filesBus, (i) => writeFileSync(join(projectCwd, "src", `f${i}.txt`), "x"));
    // Calling again with the same desired set must not throw or duplicate
    // watchers (which would double-emit for a single change).
    mod.syncFileWatchers([projectCwd]);
    let count = 0;
    mod.filesBus.on("change", () => { count += 1; });
    writeFileSync(join(projectCwd, "src", "once.txt"), "x");
    await new Promise((r) => setTimeout(r, 600));
    expect(count).toBeLessThanOrEqual(1);
  }, 20000);
});
