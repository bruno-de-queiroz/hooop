// Live file-change notifications for the dashboard's filesystem navigator.
// Structured like skills.ts's per-cwd watcher registry: one fs.watch set per
// active session cwd, reconciled against the live session set, debounced,
// and fanned out over `filesBus` for the /events/stream handler to relay.
//
// Unlike the skills tree (a narrow, known-shape `.claude/skills` dir), a
// session cwd can be an entire project — potentially huge, and not
// necessarily under git (so no `.gitignore` to lean on). Two independent
// guards keep this cheap regardless of repo shape:
//   1. A hardcoded denylist of known-heavy directory names (node_modules,
//      dist, .venv, …) that must NEVER get an OS-level watch, anywhere in
//      the tree, no matter how they're found. Verified empirically (probed
//      /proc/self/fdinfo's inotify watch-descriptor count on the sandbox's
//      own Node 24/Linux): `fs.watch(dir, {recursive:true})` registers one
//      inotify watch per directory AND per file anywhere below `dir`,
//      unconditionally — a single such watch rooted at `cwd` therefore
//      physically watches everything inside node_modules too, regardless of
//      any filtering done in JS. So instead of one big recursive watch at
//      cwd with events filtered afterward (cheap to write, but doesn't
//      actually stop the OS from watching or generating those events),
//      `scanCwd` partitions the pruned tree into the smallest set of watch
//      ANCHORS that never has one rooted inside an excluded name/path —
//      see its doc comment for the algorithm and its one honest caveat.
//   2. A circuit breaker on total directories visited while partitioning:
//      past `MAX_WATCHED_DIRS`, stop descending and treat the remainder as
//      unwatched rather than exhausting inotify or flooding events on an
//      untraversed remainder.
// `.gitignore` pruning (via `git status --ignored`) is layered on top when
// the cwd is a git repo, for extra precision — never relied upon alone.
//
// Watching (this file) and display (git.ts's navigator tree) are
// deliberately independent: DENYLIST'd directories are still fully visible
// and browsable in the navigator (lazily, on demand — see git.ts's
// `buildFileSubtree`), they're just never watched for live changes.

import { existsSync, readdirSync, statSync, type Dirent, type FSWatcher } from "node:fs";
import { watchSafe } from "./watch-safe";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname } from "node:path";
import { EventEmitter } from "node:events";
import { listActiveSessions } from "./active-sessions";

const execFileAsync = promisify(execFile);

// Also reused by git.ts's walkFs (the non-repo tree fallback) so the
// navigator's tree and its live-update watcher agree on what "heavy,
// uninteresting" means — a directory pruned here for watch purposes is
// exactly the one a non-git tree walk shouldn't burn its node budget on.
export const DENYLIST = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "target",
  "vendor", ".venv", "venv", "__pycache__", ".cache", ".turbo",
  ".parcel-cache", "coverage", ".pytest_cache",
]);

// Stop descending once this many directories are retained. Chosen well below
// typical inotify max_user_watches so a handful of concurrent session
// watchers can't collectively exhaust the host's budget.
const MAX_WATCHED_DIRS = 2000;

// Each nested repo `scanCwd` finds gets 2 MORE watches on top of the ones
// counted by MAX_WATCHED_DIRS (see `armGitSignalWatches`) — a session
// working across many mounted/cloned sibling repos (see `/hooop:mount`)
// shouldn't be able to add an unbounded number of these on top of that cap.
// `let`, not `const`, solely so tests can shrink it (via `__testing__`
// below) rather than actually creating 50+ repos to exercise the boundary.
let MAX_NESTED_REPO_WATCHES = 50;

// File-save bursts (formatters, `git checkout`, package installs) are
// heavier than skill edits, so this is higher than skills.ts's 120ms.
const FILES_EMIT_DEBOUNCE_MS = 300;

async function execGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "safe.directory=*", ...args], {
      cwd,
      env: process.env,
      timeout: 5_000,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf-8",
    });
    return { code: 0, stdout };
  } catch (e: any) {
    return { code: typeof e?.code === "number" ? e.code : 1, stdout: typeof e?.stdout === "string" ? e.stdout : "" };
  }
}

/** Top-level ignored paths (cwd-relative, "/"-joined, no trailing slash on
 * directories) — files and directories alike — or an empty set when `cwd`
 * isn't inside a git work tree. Reuses the same "normal" untracked-files
 * status mode as git.ts's buildFileTree, which collapses a whole ignored
 * directory into one `!!`-prefixed entry instead of recursing into it, while
 * still reporting an individually-ignored file (e.g. a gitignored `.env`
 * whose parent dir isn't itself ignored) as its own entry — both are pruned
 * the same way by `isPruned` below. */
async function listGitIgnoredTopLevel(cwd: string): Promise<Set<string>> {
  const rev = await execGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (rev.code !== 0 || rev.stdout.trim() !== "true") return new Set();

  const prefixRes = await execGit(cwd, ["rev-parse", "--show-prefix"]);
  const prefix = prefixRes.code === 0 ? prefixRes.stdout.trim() : "";

  const st = await execGit(cwd, [
    "-c", "core.quotePath=false",
    "-c", "status.relativePaths=false",
    "status", "--porcelain=v1", "-z", "--ignored", "--no-renames",
  ]);

  const ignored = new Set<string>();
  for (const rec of st.stdout.split("\0")) {
    if (rec.length < 4 || !rec.startsWith("!!")) continue;
    let path = rec.slice(3);
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      path = path.slice(prefix.length);
    }
    ignored.add(path.endsWith("/") ? path.slice(0, -1) : path);
  }
  return ignored;
}

/** Is `relPath` (cwd-relative, "/"-joined) inside a pruned directory — either
 * a hardcoded denylist name at any depth, or a git-ignored top-level dir?
 * Applied to every watch callback below (anchors and shallow dirs alike) as
 * defense-in-depth for content CREATED after this scan — see `scanCwd`'s
 * doc comment for why an anchor's watch can't be airtight against that.
 * It is NOT what keeps pre-existing node_modules/etc. off the OS's watch
 * list in the first place; `scanCwd`'s anchor partitioning does that. */
function isPruned(relPath: string, ignoredTop: Set<string>): boolean {
  const parts = relPath.split(/[\\/]+/).filter(Boolean);
  let acc = "";
  for (const part of parts) {
    if (DENYLIST.has(part)) return true;
    acc = acc ? `${acc}/${part}` : part;
    if (ignoredTop.has(acc)) return true;
  }
  return false;
}

/** One live-content watch to arm: `recursive: true` at `abs` when its ENTIRE
 * subtree is watch-clean (see `scanCwd`), or `recursive: false` when `abs`
 * itself sits on the path to some excluded pocket and so needs its own
 * direct children watched without being able to safely cover everything
 * below it in one watch. `rel` is cwd-relative (`""` for cwd itself) —
 * kept alongside `abs` because Linux's recursive fs.watch reports
 * `filename` relative to WHICHEVER directory the watch was opened on, not
 * to cwd, so the callback needs it to reconstruct a full cwd-relative path
 * for `isPruned`. */
interface WatchAnchor { abs: string; rel: string }

/**
 * Walk `cwd`, pruning the denylist + any git-ignored top-level dirs, and
 * partition the result into the SMALLEST set of watch anchors that (a)
 * never has one rooted inside an excluded name/path, at any depth, and (b)
 * still uses a single `recursive: true` watch for every subtree that's
 * entirely free of exclusions, rather than one non-recursive watch per
 * directory everywhere.
 *
 * That (b) choice is about JS-side bookkeeping, NOT about OS cost — and
 * measurement says the OS cost actually runs the other way. On a 4-dir,
 * 20-file tree in the sandbox's own container: one recursive watch at the
 * root registered 24 inotify watch descriptors (one per directory AND one
 * per file), while four non-recursive watches — one per directory, covering
 * the identical tree — registered just 4 (one per directory, none per
 * file). So shallow-everywhere would be roughly `1 + files/dirs` times
 * CHEAPER in descriptors; recursive anchors are preferred here for the
 * other two properties instead: far fewer FSWatcher objects/callbacks to
 * manage, and automatic extension to directories created after arming
 * (verified: a write three levels below a post-arm-created directory still
 * fires), which a non-recursive watch cannot do — see `scheduleRearm` for
 * the re-arm machinery that exists precisely because `shallowDirs` entries
 * lack that property. If inotify's `max_user_watches` ever becomes the
 * binding constraint on a huge clean tree, flipping (b) is the lever.
 *
 * Why this partitioning exists at all rather than one `fs.watch(cwd,
 * {recursive:true})` filtered via `isPruned` at emit time (this file's
 * previous design): verified empirically (see the module doc comment)
 * that recursive fs.watch on Linux registers an inotify watch on every
 * directory AND file below its root, unconditionally — there is no
 * "exclude this subpath" option. A single watch at `cwd` therefore
 * physically watches everything inside node_modules/dist/.venv/etc too,
 * no matter how aggressively the resulting events get filtered afterward.
 * The only way to make an excluded directory genuinely invisible to the OS
 * is to never open a watch (recursive OR not) anywhere inside it — which
 * means every watch's ROOT must itself be clean, recursively.
 *
 * The algorithm: `walk(dir)` returns whether `dir`'s entire subtree is
 * clean, WITHOUT deciding anchoring for `dir` itself — that decision can
 * only be made by whichever caller ends up needing one non-recursive watch
 * of its own (because IT turned out dirty), since a directory nested any
 * number of levels inside an already-clean subtree must never get its own
 * redundant anchor: its nearest clean ancestor's single recursive watch
 * already covers it completely. So each call collects its OWN clean
 * children into a local list (not yet pushed anywhere) and, once its own
 * `clean` verdict is known: if `dir` is dirty, promotes each of ITS
 * directly-clean children to `recursiveRoots` (since `dir` itself can't
 * cover them) and adds `dir` itself to `shallowDirs`; if `dir` is clean,
 * does nothing — leaves the decision to whichever ancestor is dirty (or,
 * for `cwd` itself, to the one-line check after the top-level call below).
 * The net result: `recursiveRoots` holds exactly the SHALLOWEST directory
 * at the top of each exclusion-free subtree — never also one of its own
 * (redundant) clean descendants; `shallowDirs` holds exactly the
 * directories that sit on the path to some exclusion (so their OWN direct
 * files still need a watch) — never a directory that's ITSELF a hardcoded
 * denylist name or a git-ignored path (those are never visited or watched
 * at all, exactly like before).
 *
 * What that rule does and does NOT buy, measured rather than assumed (an
 * earlier revision of this comment asserted the opposite as "verified",
 * on reasoning alone — it was wrong): a naive version of this function
 * anchored every clean directory bottom-up, so a clean
 * `src/components/button/` produced three fully-overlapping anchors
 * instead of one at `src/`. Probing `/proc/self/fdinfo` in the sandbox's
 * own container shows that costs ZERO extra inotify watch descriptors —
 * libuv keeps ONE inotify instance per event loop (not one per
 * `fs.watch` call), and inotify itself deduplicates by path within an
 * instance, so overlapping recursive watches all resolve to the same
 * descriptors (18 wds before adding two nested overlapping watches, 18
 * after; a disjoint subtree added 12, confirming the count reacts when it
 * should). What redundant anchors DO cost is one extra FSWatcher object
 * per level plus one DUPLICATE callback invocation per level per event
 * (measured: one write under `a/b/c` invoked both the `a/b` and `a/b/c`
 * watchers) — i.e. duplicated `isPruned`, `statSync` and debounce-reset
 * work on the hot path, scaling with tree depth. Worth avoiding, but it
 * is bookkeeping, not resource exhaustion. The regression test below
 * pins the shape; don't re-justify it as a descriptor-leak fix.
 *
 * Honest caveat: this is a snapshot at arm time. A denylisted directory (or
 * a freshly gitignored one) CREATED after arming, inside an already-
 * anchored clean subtree, WILL still get physically watched — Linux's
 * recursive fs.watch auto-extends to new content under its root, and there
 * is no way to tell it "except this". `isPruned` stays on every watch
 * (anchors included) as defense-in-depth so we at least never REACT to
 * that narrow window's churn, even though the OS keeps watching it until
 * the next re-arm. In practice this window is rare: the common case is a
 * pre-existing node_modules/.git/build output present before the watcher
 * ever arms, which this fully and permanently excludes. It's also self-
 * healing, not just a permanent gap: `armFileWatcher`'s `onWatchEvent`
 * below schedules a full re-arm (debounced — see `scheduleRearm`) whenever
 * it sees a brand-new directory appear that either newly matches the
 * exclusion rules (so the NEXT re-arm can finally stop watching it) or —
 * the opposite, equally real gap — is a brand-new CLEAN directory born
 * inside a `shallowDirs` entry, which (unlike a recursive anchor) does NOT
 * auto-extend to anything below that new directory's own first level.
 * Without that second half, creating a new top-level package/feature dir
 * mid-session and immediately working several levels deep inside it would
 * go completely untracked for the rest of the session — a real regression
 * from this file's old single-recursive-watch design, which this restores.
 *
 * Also collects `nestedRepoRoots` (capped at `MAX_NESTED_REPO_WATCHES`): any
 * directory below `cwd` (excluding `cwd` itself) that is itself a git work
 * tree root — the common case being a session's private root with the
 * actual clone one level down. `cwd`'s own `.git` is handled separately by
 * the caller regardless of repo-ness, so it's deliberately excluded here to
 * avoid double-watching it.
 */
async function scanCwd(
  cwd: string,
): Promise<{
  recursiveRoots: WatchAnchor[];
  shallowDirs: WatchAnchor[];
  ignoredTop: Set<string>;
  nestedRepoRoots: string[];
}> {
  const ignoredTop = await listGitIgnoredTopLevel(cwd).catch(() => new Set<string>());
  const nestedRepoRoots: string[] = [];
  const recursiveRoots: WatchAnchor[] = [];
  const shallowDirs: WatchAnchor[] = [];
  let visited = 0;
  let overCap = false;

  function walk(dir: string, relPath: string): boolean {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true; // permission error / transient — nothing below to protect, treat as clean
    }
    let clean = true;
    // Buffered, not pushed to the module-level `recursiveRoots` yet — only
    // promoted below if `dir` itself turns out dirty (see this function's
    // doc comment above for why anchoring bottom-up instead would create
    // redundant, fully-overlapping watches at every level of a clean
    // subtree rather than just its topmost directory).
    const cleanChildren: WatchAnchor[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (DENYLIST.has(e.name)) { clean = false; continue; }
      const childRel = relPath ? `${relPath}/${e.name}` : e.name;
      if (ignoredTop.has(childRel)) { clean = false; continue; }
      if (overCap || visited >= MAX_WATCHED_DIRS) {
        // Budget exhausted — stop descending. Treat as dirty (rather than
        // silently clean) so an ancestor doesn't wrongly anchor a recursive
        // watch over content this walk never actually inspected.
        overCap = true;
        clean = false;
        continue;
      }
      visited++;
      const full = join(dir, e.name);
      if (nestedRepoRoots.length < MAX_NESTED_REPO_WATCHES && existsSync(join(full, ".git"))) {
        nestedRepoRoots.push(full);
      }
      if (walk(full, childRel)) {
        cleanChildren.push({ abs: full, rel: childRel });
      } else {
        clean = false;
      }
    }
    if (!clean) {
      // `dir` can't be covered by one recursive watch — so unlike a clean
      // `dir`, its directly-clean children (buffered above) each need
      // their OWN anchor now; nothing higher up will ever anchor them.
      recursiveRoots.push(...cleanChildren);
      shallowDirs.push({ abs: dir, rel: relPath });
    }
    // When clean, `cleanChildren` is deliberately dropped — every one of
    // them is a subset of whatever ancestor eventually anchors `dir`
    // itself (possibly `dir` itself, decided by whichever CALLER finds it
    // clean; see the top-level `cwd` check below for the one case with no
    // caller at all).
    return clean;
  }

  if (walk(cwd, "")) recursiveRoots.push({ abs: cwd, rel: "" });
  return { recursiveRoots, shallowDirs, ignoredTop, nestedRepoRoots };
}

interface FileWatch { watchers: FSWatcher[] }
const _fileWatchers = new Map<string, FileWatch>();
const _pendingArm = new Map<string, Promise<void>>();

// Debounced full re-arm, keyed by cwd — see `scanCwd`'s "honest caveat" doc
// comment for why this exists (a brand-new directory can need either a new
// anchor of its own, or to newly START being excluded, and neither self-
// corrects without a fresh scan). Deliberately its own timer map, not
// reusing `_emitTimers`: a burst of ordinary file edits must keep debouncing
// the cheap `filesBus` emit on its own short cadence without also
// repeatedly delaying (or triggering) this far more expensive full rescan.
const _rearmTimers = new Map<string, ReturnType<typeof setTimeout>>();
// Longer than FILES_EMIT_DEBOUNCE_MS because a full re-arm is far more
// expensive than an emit: it re-walks the tree and re-runs `git status
// --ignored` (measured ~200ms warm against this repo itself, almost all of
// it git's own process spawn + scan). Note this deliberately fires on a
// deadline from the FIRST structural event rather than waiting for churn to
// stop — see `maybeScheduleRearmForNewDir`. Firing partway through a burst
// is the POINT for the case that matters: an `npm install` inside an
// established recursive anchor is registering an inotify watch per new file
// (a real node_modules is ~36k of the container's 124k max_user_watches), so
// re-arming ~2s in is what actually stops that growth. It's also
// self-limiting rather than repeating for the install's whole duration —
// once that re-arm excludes node_modules, its churn generates no further
// events to schedule another (the storm-guard test pins this at exactly ONE
// re-arm across continuous directory creation).
//
// `let`, not `const`, solely so the self-heal tests can shrink it (via
// `__testing__`). They assert on real elapsed time — a fake-timer clock
// can't advance inotify, whose delivery is genuinely asynchronous — so at
// the production value the three of them alone spent ~18s of the suite
// sleeping. No reset counterpart: every test in that file re-imports this
// module fresh (`vi.resetModules`), so the override can't leak.
let REARM_DEBOUNCE_MS = 2_000;

/** Schedule a full re-arm of `cwd` (debounced) — used when a watch
 * callback below spots a newly-created directory that the CURRENT anchor
 * partitioning can no longer correctly cover (see the two cases in
 * `armFileWatcher`'s `onWatchEvent`). `trackArm` re-runs `scanCwd` from
 * scratch, so the fresh partitioning naturally picks up the new directory
 * as its own anchor (if clean) or newly excludes it (if it now matches
 * DENYLIST/gitignore) — whichever this call was for. */
function scheduleRearm(cwd: string): void {
  const existing = _rearmTimers.get(cwd);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    _rearmTimers.delete(cwd);
    // Don't resurrect a watcher for a cwd that stopped being watched between
    // scheduling this and now (a closed session). `closeFileWatch` clears
    // this timer on removal too, so this is the belt to that suspenders.
    if (!_fileWatchers.has(cwd)) return;
    // Never start a second concurrent arm for one cwd: every other
    // `trackArm` call site guards on this, and two places in this file
    // depend on it — `_pendingArm` is only "a complete, accurate record of
    // what's currently mid-arm", and `syncFileWatchers` discarding
    // `_armToken` entries is only safe, while at most ONE arm per cwd is in
    // flight. (Otherwise an older arm's `.finally` deletes the map entry
    // now belonging to the newer one, hiding a live arm from the cancel
    // sweep, which can leave a watcher armed for a torn-down session.)
    //
    // Re-schedule rather than drop, though. Dropping would usually be fine
    // — an arm that STARTED after our triggering event re-scans the new
    // directory anyway — but not always: an arm whose scan outlives
    // REARM_DEBOUNCE_MS (a big repo with a slow `git status --ignored`)
    // began before that directory existed and may have already walked past
    // where it appeared, so dropping would lose it until some unrelated
    // structural change happened to schedule another re-arm. Retrying
    // terminates: an arm always settles, after which this proceeds.
    if (_pendingArm.has(cwd)) {
      scheduleRearm(cwd);
      return;
    }
    trackArm(cwd);
  }, REARM_DEBOUNCE_MS);
  t.unref?.();
  _rearmTimers.set(cwd, t);
}

/** Cheap "did a NEW directory just show up at `absPath`" check — used to
 * decide whether an event is worth the cost of a full re-arm. A delete (the
 * path no longer exists) or a plain file both no-op here; only a directory
 * that exists RIGHT NOW is worth re-partitioning for.
 *
 * Returns immediately when a re-arm is already pending, which is what keeps
 * this off the hot path: `npm install` fires tens of thousands of "rename"
 * events, all of them pruned, and a `statSync` per event would put that
 * many synchronous syscalls on the single-threaded server's event loop —
 * the same failure mode as the permission-gate outage this watcher's
 * denylist exists to prevent. Collapsing to ONE stat per debounce window
 * also stops continuous churn from starving the re-arm by resetting its
 * timer forever: it now fires REARM_DEBOUNCE_MS after the FIRST structural
 * change, and one re-scan covers everything that appeared meanwhile. */
function maybeScheduleRearmForNewDir(cwd: string, absPath: string): void {
  if (_rearmTimers.has(cwd)) return;
  try {
    if (statSync(absPath).isDirectory()) scheduleRearm(cwd);
  } catch { /* gone already (this was a delete, not a create) */ }
}

export const filesBus = new EventEmitter();
filesBus.setMaxListeners(100);

const _emitTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Per-cwd counter guarding the async tail of armFileWatcher (it awaits a
// git-backed scan). armFileWatcher bumps this at entry and compares its own
// captured value against the live one after the await, discarding itself on
// a mismatch instead of resurrecting a watcher for a cwd nothing will
// reconcile again. Only ever holds entries for cwds currently live or
// mid-arm — syncFileWatchers/stopFileWatcher delete a cwd's entry the moment
// it's no longer either (see there), so this doesn't grow with a process's
// full historical cwd list, just its current working set. Deleting (rather
// than only ever incrementing) is safe specifically because `trackArm`
// guarantees at most one arm per cwd is ever in flight at a time — a fresh
// numeric value can never collide with a still-pending older one.
const _armToken = new Map<string, number>();

function invalidateArm(cwd: string): number {
  const next = (_armToken.get(cwd) ?? 0) + 1;
  _armToken.set(cwd, next);
  return next;
}

function currentArmToken(cwd: string): number {
  return _armToken.get(cwd) ?? 0;
}

/** Close and deregister `cwd`'s live FSWatchers, leaving its timers alone.
 * Split out from `closeFileWatch` for `armFileWatcher`'s swap: a re-arm
 * wants the OLD watchers replaced without also cancelling a debounced emit
 * that's mid-flight or a re-arm request that arrived during its scan. */
function closeWatchers(cwd: string): void {
  const e = _fileWatchers.get(cwd);
  if (!e) return;
  for (const w of e.watchers) { try { w.close(); } catch { /* ignore */ } }
  _fileWatchers.delete(cwd);
}

function closeFileWatch(cwd: string): void {
  closeWatchers(cwd);
  const t = _emitTimers.get(cwd);
  if (t) {
    clearTimeout(t);
    _emitTimers.delete(cwd);
  }
  // A rearm scheduled for this cwd (see `scheduleRearm`) is now moot — the
  // watcher it would have refreshed is gone, and `trackArm`'s own token
  // check can't help here since a full-blown NEW arm for the same path
  // (a fresh session reusing it) would legitimately re-populate
  // `_fileWatchers` before this stale timer fires, defeating that guard.
  const rt = _rearmTimers.get(cwd);
  if (rt) {
    clearTimeout(rt);
    _rearmTimers.delete(cwd);
  }
}

function nearestExistingAncestor(p: string): string | null {
  let dir = p;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root without finding one
    dir = parent;
  }
  return dir;
}

/** `cwd` doesn't exist yet (session provisioning race, or a not-yet-cloned
 * repo) — watch the nearest existing ancestor non-recursively and re-arm
 * for real once `cwd` materializes. Mirrors skills.ts's ancestor fallback. */
function armAncestorWatch(cwd: string): void {
  const ancestor = nearestExistingAncestor(cwd);
  if (!ancestor) return;
  try {
    const w = watchSafe(ancestor, { recursive: false }, () => {
      if (existsSync(cwd)) armAncestorFired(cwd);
    });
    _fileWatchers.set(cwd, { watchers: [w] });
  } catch { /* transient */ }
}

/**
 * Watch `repoRoot/.git`'s few status-relevant files/dirs directly, emitting
 * for session `cwd` (which may be `repoRoot` itself, or an ancestor whose
 * live-notification session this repo was found nested under).
 *
 * Git status can change without any tracked file being touched: a commit,
 * merge, rebase, reset, or branch switch only writes inside .git/, which the
 * denylisted walk above deliberately never descends into (the object store
 * alone would be enormous churn to watch, and — for a nested repo — its
 * events are actively filtered out by `isPruned`'s blanket ".git" rule
 * rather than just uncounted). Watch the few files that change on nearly
 * every such operation directly instead, so e.g. committing correctly
 * clears the "files to review" pill rather than leaving it stuck on files
 * that are no longer actually changed:
 *   .git/HEAD        — branch switches / detached-HEAD moves
 *   .git/index       — staging, checkout, reset, stash (empirically does
 *                      NOT fire for `commit --allow-empty`, so this alone
 *                      is not a reliable commit signal — refs/heads below
 *                      is what actually catches every commit)
 *   .git/refs/heads/ — commits, merges, rebases (the branch pointer moves)
 *
 * Watch the `.git` DIRECTORY (non-recursive), not `HEAD`/`index` directly.
 * Both are conventionally rewritten via a lockfile-then-rename (git writes
 * `index.lock`, then renames it over `index`) rather than an in-place write
 * — and `fs.watch` on a single file is bound to that file's inode, not its
 * path. Verified empirically: the FIRST such rename does fire one "rename"
 * event, but the watch is then permanently dead — the inode it was watching
 * no longer lives at that path, so every later swap (the very next commit,
 * checkout, etc.) goes completely unnoticed. A directory watch has no such
 * blind spot (its inotify watch stays bound to the directory itself, which
 * is never replaced), so we watch `.git` and filter to the two filenames we
 * care about instead.
 */
function armGitSignalWatches(repoRoot: string, cwd: string, watchers: FSWatcher[]): void {
  const gitDir = join(repoRoot, ".git");
  if (existsSync(gitDir)) {
    try {
      watchers.push(
        watchSafe(gitDir, { recursive: false }, (_evt, filename) => {
          // filename is null on some platforms — fail open (still emit)
          // rather than going deaf on those, mirroring the recursive watch
          // in armFileWatcher. Otherwise only react to the two signal files
          // themselves, not the rest of .git's churn (objects/, logs/, …).
          if (filename && filename !== "HEAD" && filename !== "index") return;
          emitFilesChangeDebounced(cwd);
        }),
      );
    } catch { /* transient */ }
  }
  // refs/heads MUST be watched recursively: branch names routinely contain
  // "/" (e.g. this repo's own fix/*, feat/* convention), which git stores as
  // a nested ref file (refs/heads/fix/foo) rather than a direct child of
  // refs/heads — a non-recursive watch here silently misses every commit on
  // any such branch (verified empirically; it's the common case, not an
  // edge case).
  const refsHeads = join(repoRoot, ".git", "refs", "heads");
  if (existsSync(refsHeads)) {
    try {
      watchers.push(watchSafe(refsHeads, { recursive: true }, () => emitFilesChangeDebounced(cwd)));
    } catch {
      // Recursive unsupported on this platform — falls back to catching only
      // non-nested branch names rather than missing this signal entirely.
      try {
        watchers.push(watchSafe(refsHeads, () => emitFilesChangeDebounced(cwd)));
      } catch { /* transient */ }
    }
  }
}

async function armFileWatcher(cwd: string): Promise<void> {
  // Every call — whether from syncFileWatchers, the ancestor-watch callback
  // above, or a retry — supersedes any earlier in-flight arm for this cwd.
  const token = invalidateArm(cwd);
  // NOTE: any currently-live watchers are deliberately left running until
  // the new set is built (see the swap at the end of this function). The
  // scan below awaits `git status` and a tree walk — ~200ms warm on a real
  // repo — and tearing the old watchers down first would go blind for that
  // whole window on every arm. That was harmless while arms only happened
  // at session start (nothing to miss yet), but `scheduleRearm` now makes
  // them a routine mid-session event on any directory creation.
  if (!existsSync(cwd)) {
    closeFileWatch(cwd);
    armAncestorWatch(cwd);
    return;
  }

  let scan: Awaited<ReturnType<typeof scanCwd>>;
  try {
    scan = await scanCwd(cwd);
  } catch {
    scan = { recursiveRoots: [{ abs: cwd, rel: "" }], shallowDirs: [], ignoredTop: new Set(), nestedRepoRoots: [] };
  }

  // A newer arm (or an explicit removal/shutdown — see syncFileWatchers and
  // stopFileWatcher) superseded this attempt while we were awaiting the
  // git-backed scan. Discard rather than registering a watcher for a cwd
  // that's since moved on — this is what actually prevents the leak, since
  // the scan above can't be cancelled once started.
  if (currentArmToken(cwd) !== token) return;

  const watchers: FSWatcher[] = [];
  const ignoredTop = scan.ignoredTop;
  // filename is relative to WHICHEVER directory the watch was opened on
  // (`abs`/`rel`), not to cwd — reconstruct a full cwd-relative path before
  // checking isPruned. Platforms that ever report a null filename fail open
  // (still emit) rather than silently going deaf. See scanCwd's doc comment
  // for why anchoring both recursive AND shallow watches this way (instead
  // of one big recursive watch at cwd) is what actually keeps the OS from
  // ever watching inside node_modules/etc., not just this filter.
  //
  // `isShallow` additionally gates the two self-healing re-arm checks (see
  // `scanCwd`'s "honest caveat" doc comment): only a "rename" (create or
  // delete, never a plain content "change") on a directory even bothers —
  // a recursive anchor already auto-extends to any new CLEAN content under
  // it, so only (a) something newly matching the exclusion rules anywhere,
  // or (b) something newly NOT excluded but born inside a non-recursive
  // shallow watch specifically, ever needs a fresh scan to (re)cover.
  const onWatchEvent = (rel: string, isShallow: boolean) => (evt: string, filename: string | Buffer | null) => {
    if (filename) {
      const full = rel ? `${rel}/${filename}` : String(filename);
      const pruned = isPruned(full, ignoredTop);
      if (evt === "rename" && (pruned || isShallow)) maybeScheduleRearmForNewDir(cwd, join(cwd, full));
      if (pruned) return;
    }
    emitFilesChangeDebounced(cwd);
  };
  for (const { abs, rel } of scan.recursiveRoots) {
    try {
      watchers.push(watchSafe(abs, { recursive: true }, onWatchEvent(rel, false)));
    } catch { /* transient, or recursive unsupported on this platform — skip this anchor */ }
  }
  for (const { abs, rel } of scan.shallowDirs) {
    try {
      watchers.push(watchSafe(abs, { recursive: false }, onWatchEvent(rel, true)));
    } catch { /* transient — skip this dir */ }
  }
  // Every anchor/shallow watch failed to bind (e.g. recursive genuinely
  // unsupported on this platform, or cwd itself is somehow unreadable) —
  // fall back to a single shallow watch on cwd rather than nothing at all.
  if (watchers.length === 0) {
    try {
      watchers.push(watchSafe(cwd, { recursive: false }, () => emitFilesChangeDebounced(cwd)));
    } catch { /* give up on the main tree watch — git-signal watches below may still work */ }
  }

  // Git status can change without any tracked file being touched — see
  // `armGitSignalWatches` below for the full rationale. Cover `cwd`'s own
  // repo (the common case when an explicit cwd is itself a git checkout)...
  armGitSignalWatches(cwd, cwd, watchers);
  // ...and any nested repo `scanCwd` found below it (the common case for a
  // session's private root, whose actual clone lives one level down —
  // without this, a commit/checkout/stash inside the clone would never
  // clear or update the "files to review" pill, since `.git`'s churn is
  // otherwise pruned outright by `isPruned` above rather than inspected).
  for (const repoRoot of scan.nestedRepoRoots) armGitSignalWatches(repoRoot, cwd, watchers);

  // Swap: the previous generation stayed live through the scan above (so no
  // blind window) and is only torn down now that its replacement exists.
  // The overlap is a handful of synchronous statements, during which a
  // change can be seen by both generations — harmless, since the emit is
  // debounced per cwd. Timers are intentionally NOT cleared here (that's
  // `closeFileWatch`'s job on real teardown): a re-arm request that arrived
  // while this scan was running refers to a directory this scan may have
  // missed, so it must survive to fire.
  closeWatchers(cwd);
  if (watchers.length > 0) _fileWatchers.set(cwd, { watchers });
}

// Starts a tracked arm attempt for `cwd`. All entry points funnel through
// this so `_pendingArm` is always a complete, accurate record of "what's
// currently mid-arm" — the union of `_fileWatchers` and `_pendingArm` keys
// is therefore a complete "everything live or in-flight right now" view,
// with no need to separately remember every cwd ever seen.
function trackArm(cwd: string): void {
  const p = armFileWatcher(cwd)
    .catch(() => { /* best-effort */ })
    .finally(() => { _pendingArm.delete(cwd); });
  _pendingArm.set(cwd, p);
}

// Regular reconcile path: leave `cwd` alone if it already has ANY
// registration (a real watcher or an ancestor placeholder) or is mid-arm —
// cheap no-op for the common case of an unchanged desired set.
function armIfNew(cwd: string): void {
  if (_fileWatchers.has(cwd) || _pendingArm.has(cwd)) return;
  trackArm(cwd);
}

// The ancestor watch's own callback: `cwd` might exist now, so always
// attempt to upgrade past the ancestor placeholder (whose entry in
// `_fileWatchers` is expected and must NOT block this) — but still dedup
// against an attempt already in flight for the same cwd.
function armAncestorFired(cwd: string): void {
  if (_pendingArm.has(cwd)) return;
  trackArm(cwd);
}

/**
 * Reconcile per-cwd file watchers to the live session cwd set. Cheap to call
 * frequently: a cwd already watched (or mid-arm) is left untouched, so a
 * busy `sessionsBus` doesn't re-walk/re-exec-git on every tick — only newly
 * seen or newly gone cwds do work.
 */
export function syncFileWatchers(cwds: Iterable<string>): void {
  const desired = new Set<string>();
  for (const c of cwds) if (c) desired.add(c);

  // `_fileWatchers` ∪ `_pendingArm` is a complete view of everything live or
  // mid-arm (see trackArm) — including a cwd whose ancestor watcher just
  // fired and is upgrading to a real watch, even though that upgrade wasn't
  // started by this function. Anything no longer desired gets closed AND has
  // its arm token discarded, so an in-flight scan for it self-cancels on
  // resume instead of registering a watcher nothing will ever reconcile
  // again. Discarding (not just bumping) the token also keeps `_armToken`
  // from growing forever across a long-running process's full cwd history —
  // safe because `trackArm`'s dedup guard means at most one arm per cwd is
  // ever in flight at a time, so a freshly-assigned token can never be
  // mistaken for a still-pending older one.
  for (const cwd of new Set([..._fileWatchers.keys(), ..._pendingArm.keys()])) {
    if (desired.has(cwd)) continue;
    closeFileWatch(cwd);
    _armToken.delete(cwd);
  }
  for (const cwd of desired) armIfNew(cwd);
}

function emitFilesChangeDebounced(cwd: string): void {
  const existing = _emitTimers.get(cwd);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    _emitTimers.delete(cwd);
    // One event per live session at this cwd — two sessions sharing a
    // working directory each get their own notification.
    for (const s of listActiveSessions()) {
      if (s.cwd === cwd) filesBus.emit("change", { sessionId: s.sessionId, cwd });
    }
  }, FILES_EMIT_DEBOUNCE_MS);
  t.unref?.();
  _emitTimers.set(cwd, t);
}

let _fileWatchStarted = false;

/** Idempotent lifecycle marker — actual per-cwd arming happens via
 * `syncFileWatchers`, called at boot and on every `sessionsBus` "change"
 * (see server.ts), mirroring `startSkillsWatcher`/`syncProjectSkillWatchers`. */
export function startFileWatcher(): void {
  _fileWatchStarted = true;
}

// Test-only access to internal tuning constants. NOT exported in production
// builds — just reachable from sandbox/lib/file-watch.test.ts, mirroring
// embeddings.ts's `__testing__` pattern.
export const __testing__ = {
  setMaxNestedRepoWatches: (n: number) => { MAX_NESTED_REPO_WATCHES = n; },
  setRearmDebounceMs: (ms: number) => { REARM_DEBOUNCE_MS = ms; },
  scanCwd,
  // Bumps every time `armFileWatcher` actually runs for `cwd` (including via
  // `scheduleRearm`'s debounced self-heal) — the only reliable observable
  // signal from outside that a full re-scan happened, since a self-heal's
  // whole point (an excluded directory's OS watch shrinking) is otherwise
  // invisible to a unit test that can't inspect inotify state directly.
  getArmToken: (cwd: string) => currentArmToken(cwd),
};

export function stopFileWatcher(): void {
  for (const cwd of [..._fileWatchers.keys()]) closeFileWatch(cwd);
  for (const t of _emitTimers.values()) clearTimeout(t);
  _emitTimers.clear();
  // Same belt-and-suspenders as the emit timers above: the loop over
  // `_fileWatchers` only clears re-arm timers for cwds that still HAVE an
  // entry, and an arm that bound zero watchers leaves none behind while its
  // re-arm timer can still be pending. Such a timer is harmless on its own
  // (unref'd, and it re-checks `_fileWatchers` before doing anything), but
  // leaving it armed across a shutdown/restart is the kind of cross-test and
  // cross-lifecycle residue that's cheaper to delete than to reason about.
  for (const t of _rearmTimers.values()) clearTimeout(t);
  _rearmTimers.clear();
  _pendingArm.clear();
  // Clearing (rather than deleting per-cwd) invalidates every arm still
  // mid-flight in one step: currentArmToken() defaults to 0 for anything
  // missing, and a genuinely in-flight arm's captured token is always ≥1
  // (see invalidateArm), so it can never match after this and will discard
  // itself on resume instead of resurrecting a watcher after shutdown.
  _armToken.clear();
  _fileWatchStarted = false;
}
