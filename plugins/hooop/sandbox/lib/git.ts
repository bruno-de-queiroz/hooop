// Git-aware file tree + per-file preview for the dashboard's filesystem
// navigator. All git invocations are `execFile("git", …)` (no shell) with a
// timeout + bounded maxBuffer, and every entry point re-validates `cwd` against
// the same policy as session creation. Paths returned to the client are always
// relative to the request `cwd`.
//
// The shapes here mirror the dashboard's app/components/shell/files/types.ts so
// the client response drops straight into the UI.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import {
  classifyImage,
  CwdPolicyError,
  PREVIEW_MAX_BYTES,
  readCapped,
  resolveUnderCwd,
} from "./files";
import { isAllowedCwd } from "./cwd-policy";
import { DENYLIST } from "./file-watch";

const execFileAsync = promisify(execFile);

export type GitStatus = "added" | "changed" | "removed" | "ignored" | null;

export interface FileNode {
  name: string;
  path: string;
  isDir: boolean;
  status: GitStatus;
  children?: FileNode[];
  /** True when this directory's `children` is an intentionally-unwalked
   * placeholder (a DENYLIST name in `walkFs`, or a directory git collapsed
   * into one porcelain line — ignored OR untracked), NOT a genuinely empty
   * directory. The navigator fetches `buildFileSubtree` for it on demand
   * (`GET /files/tree?cwd=&path=`) the first time it's expanded, rather than
   * this walk ever recursing into it eagerly. Never set on files or on
   * directories whose children were actually enumerated. */
  lazy?: boolean;
}

export type DiffSign = " " | "+" | "-";
export interface DiffLine {
  sign: DiffSign;
  oldNo: number | null;
  newNo: number | null;
  text: string;
}
export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}
export interface FileDiff {
  kind: "modified" | "added" | "removed";
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

export interface FileTree {
  repo: boolean;
  tree: FileNode[];
  /** True when the tree hit the node cap and was truncated. */
  truncated: boolean;
}

export interface FilePreview {
  status: GitStatus;
  isMarkdown: boolean;
  diff: FileDiff | null;
  content: string | null;
  /** File content was clipped at the read cap. */
  truncated: boolean;
  /** True on-disk size in bytes. */
  sizeBytes: number;
  binary: boolean;
  /** The diff exceeded the render cap and was dropped (content still shown). */
  diffTooLarge: boolean;
  /** Renderable image (extension AND leading bytes agree) — the dock shows it
   * instead of content/diff. Deliberately just a flag: the BYTES come from
   * `GET /files/raw`, never from this payload, because the navigator refetches
   * this preview on every write under the cwd and a 2 MB image would ride along
   * every time. */
  isImage: boolean;
  /** Agreed media type, or null when not an image. */
  imageType: string | null;
  /** An image, but over IMAGE_MAX_BYTES — shown as a size message rather than a
   * broken tile, since a partly-read image is corrupt. */
  imageTooLarge: boolean;
  /** Last-modified ms, used by the dock as the raw URL's cache key so an
   * unchanged image is not refetched on an unrelated write. 0 when unknown. */
  mtimeMs: number;
}

// A slow/huge git call must never wedge the single-threaded server event loop.
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAXBUFFER = 32 * 1024 * 1024;
// Patch text above this is not worth rendering line-by-line in the browser.
const DIFF_MAX_BYTES = 1_500_000;
// Bound the tree so a monorepo can't produce a multi-megabyte JSON / DOM.
// Capped PER DIRECTORY (not as a single global slice): a global cutoff over
// the flat, alphabetically-sorted file list would silently drop every file
// under later-sorted top-level dirs once the cap is hit — on a huge repo that
// can hide entire subsystems from the navigator, not just trim a long list.
// Capping each directory's own file count instead means every directory that
// exists is still visible; only a single directory with a pathological
// number of files gets its file list clipped.
const TREE_MAX_FILES_PER_DIR = 2000;
// Global backstop, applied everywhere a tree gets built: walkFs's own FS
// walk (which — unlike git — has no ignore rules to stop it descending into
// a huge `node_modules`) AND every git-decorated tree (`buildRepoTree`),
// whether that's the whole response (cwd itself is a repo) or a subtree
// spliced in for a nested repo `walkFs` found partway through a walk. A
// single repo's own git output is loosely bounded by GIT_MAXBUFFER, but
// that alone permits tens of thousands of short paths — nowhere near tight
// enough to protect the DOM on its own, hence this explicit node cap too.
// Exported so the HTTP layer can clamp a client-supplied `max` to it: this
// is a PER-RESPONSE cap, so a navigator that expands several lazy
// directories accumulates one budget per expansion in its own state. The
// client tracks its running total and asks for only what it has room for
// (see the dashboard's FilesUIProvider) — but that request is a hint from
// an untrusted caller, and this stays the hard ceiling either way.
export const TREE_MAX_TOTAL_NODES = 20000;
// Caps how many `git` process pairs a single directory's worth of sibling
// nested repos (e.g. several projects mounted/cloned side by side under one
// shared workspace cwd — see `/hooop:mount`) can have in flight at once.
// Without this, N sibling repos would either serialize (N × one repo's full
// git latency — measured ~44ms/repo, so 20 sibling repos would add ~900ms to
// every tree fetch) or, if simply Promise.all'd with no cap, fork every
// sibling's git pair simultaneously — a workspace with dozens of mounts
// could momentarily spawn 100+ git processes from one request.
const NESTED_REPO_CONCURRENCY = 4;
// Most sibling nested repos whose git work was in flight simultaneously since
// the last reset. Bookkeeping for the guard test only — free at runtime, and
// the only way to assert this property that survives CI. Timing it does not:
// that test used to race a concurrent walk against a serial baseline and
// require the concurrent one to come in under 0.7×, which held locally but
// scored 0.78 on a two-vCPU runner, because git here is CPU-bound and two
// shared cores cannot overlap six of it. Nor could the bar simply be loosened
// — a genuine regression to sequential scores ~1.0, so there is no threshold
// between the two that noise doesn't cross. Counting is exact and doesn't
// care how fast the machine is.
let inFlightNestedRepoBuilds = 0;
let peakNestedRepoBuilds = 0;

export const __testing__ = {
  NESTED_REPO_CONCURRENCY,
  peakNestedRepoBuilds: () => peakNestedRepoBuilds,
  // Deliberately leaves `inFlight` alone: it's a live count, and zeroing it
  // mid-walk would make the peak meaningless for anything still running.
  resetPeakNestedRepoBuilds: () => { peakNestedRepoBuilds = 0; },
};

interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Run git in `dir`. git legitimately exits non-zero for many normal cases
 * (not a repo, empty diff, `diff --no-index`), so we never throw on a non-zero
 * exit — callers inspect `code`/`stdout`. Only a spawn failure (git missing)
 * surfaces as code 1 with empty output.
 */
async function git(dir: string, args: string[]): Promise<GitResult> {
  try {
    // `safe.directory=*` disables git's owner-vs-caller "dubious ownership"
    // check. The sandbox is single-tenant and the `agent` user legitimately
    // operates every repo here; without this, repos on an ownership-virtualized
    // bind mount (e.g. macOS Docker Desktop's /home/agent) are refused and the
    // navigator silently loses all git decoration.
    const full = ["-c", "safe.directory=*", ...args];
    const { stdout, stderr } = await execFileAsync("git", full, {
      cwd: dir,
      env: process.env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAXBUFFER,
      encoding: "utf-8",
    });
    return { stdout, stderr, code: 0 };
  } catch (e: any) {
    return {
      stdout: typeof e?.stdout === "string" ? e.stdout : "",
      stderr: typeof e?.stderr === "string" ? e.stderr : "",
      code: typeof e?.code === "number" ? e.code : 1,
    };
  }
}

async function insideWorkTree(cwd: string): Promise<boolean> {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

async function topLevel(cwd: string): Promise<string | null> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  const t = r.stdout.trim();
  return r.code === 0 && t ? t : null;
}

/** cwd's path within the repo, with a trailing slash (e.g. "pkg/app/"), or ""
 * when cwd is the repo root. */
async function showPrefix(cwd: string): Promise<string> {
  const r = await git(cwd, ["rev-parse", "--show-prefix"]);
  return r.code === 0 ? r.stdout.trim() : "";
}

function mapStatus(xy: string): GitStatus {
  if (xy === "!!") return "ignored";
  if (xy === "??") return "added";
  const x = xy[0];
  const y = xy[1];
  if (x === "D" || y === "D") return "removed";
  if (x === "A" || y === "A") return "added";
  return "changed";
}

/** Parse `git status --porcelain=v1 -z … --no-renames` output. Each record is
 * "XY<space>path"; with --no-renames there is never a second (origin) token. */
function parseStatusZ(out: string): Array<{ path: string; status: GitStatus }> {
  const res: Array<{ path: string; status: GitStatus }> = [];
  for (const rec of out.split("\0")) {
    if (rec.length < 4) continue; // "XY p" is the shortest meaningful record
    const xy = rec.slice(0, 2);
    const path = rec.slice(3);
    if (!path) continue;
    res.push({ path, status: mapStatus(xy) });
  }
  return res;
}

// ── Tree ─────────────────────────────────────────────────────────────────────

export async function buildFileTree(cwd: string): Promise<FileTree> {
  const policy = isAllowedCwd(cwd);
  if (!policy.ok) throw new CwdPolicyError(policy.reason ?? "cwd not allowed");

  if (!(await insideWorkTree(cwd))) {
    const { tree, truncated } = await walkFs(cwd);
    return { repo: false, tree, truncated };
  }

  const { tree, truncated } = await buildRepoTree(cwd);
  return { repo: true, tree, truncated };
}

/**
 * On-demand children for a directory the top-level tree deliberately left
 * unwalked — a `lazy: true` node from either path above: a DENYLIST name in
 * `walkFs`, or a directory git collapsed into one porcelain line (ignored or
 * untracked) in `buildRepoTree`. Both intentionally never enumerate what's
 * inside so a huge directory can't blow the node budget on a request nobody
 * made; this is the "click to load" counterpart that makes their contents
 * fully — just not eagerly — reachable.
 *
 * Deliberately does NOT reuse `buildFileTree`'s `insideWorkTree` check here:
 * that's true for ANY path inside an enclosing repo, including one that's
 * entirely ignored/untracked from that repo's own perspective — which is
 * exactly the common case (this is almost always a directory inside cwd's
 * OWN repo). Running `git ls-files`/`status` rooted exactly AT an ignored
 * directory returns nothing useful: git's ignore machinery makes a
 * directory invisible to itself, not just to its parent, so `buildRepoTree`
 * would come back empty even though the directory plainly has files on
 * disk (verified empirically — this was the first, broken version of this
 * function). Only take the git-aware path when `relPath` is a work tree
 * ROOT in its own right (e.g. a vendored git submodule under `vendor/`);
 * otherwise fall back to `walkFs`, which already knows how to detect and
 * delegate to any FURTHER nested repo within it, the same as it would for
 * any other plain directory.
 *
 * `maxTotalNodes` lets the caller ask for LESS than the per-response cap —
 * the navigator passes the room left in its own accumulated tree, so
 * expanding directory after directory can't grow client state without
 * bound (each response is individually capped, but nothing else would cap
 * their sum). Clamped to `TREE_MAX_TOTAL_NODES` because it originates from
 * a query param.
 */
export async function buildFileSubtree(
  cwd: string,
  relPath: string,
  maxTotalNodes = TREE_MAX_TOTAL_NODES,
): Promise<FileTree> {
  const policy = isAllowedCwd(cwd);
  if (!policy.ok) throw new CwdPolicyError(policy.reason ?? "cwd not allowed");
  const abs = resolveUnderCwd(cwd, relPath); // throws on escape

  const budget = Math.max(0, Math.min(maxTotalNodes, TREE_MAX_TOTAL_NODES));
  const repo = existsSync(join(abs, ".git"));
  const { tree, truncated } = repo ? await buildRepoTree(abs, budget) : await walkFs(abs, budget);
  // Both builders return paths relative to `abs` — reprefix with `relPath`
  // so the response stays cwd-relative, the contract every other node in
  // the navigator's tree already honors (and what the client keys its
  // splice-into-existing-tree merge on).
  reprefixPaths(tree, relPath);
  return { repo, tree, truncated };
}

/**
 * git-decorated tree for a `cwd` already confirmed (by the caller) to be
 * inside a work tree. Factored out of `buildFileTree` so `walkFs` (the
 * non-repo fallback) can also call it for a nested repo it discovers partway
 * through a walk — see the "sessionRoot/<cloneDir>" case in `walkFs`'s docs.
 *
 * `maxTotalNodes` bounds this call's OWN tree only — when `walkFs` delegates
 * for a nested repo, it passes its remaining global budget (`overall cap −
 * nodes already spent elsewhere in the walk`) so one huge nested repo can't
 * return an unbounded response, but each of several CONCURRENT sibling
 * repos (see `NESTED_REPO_CONCURRENCY`) gets that same remaining-budget
 * snapshot independently rather than a precisely shared counter — simpler,
 * and the worst case (several siblings each landing right at the cap) is
 * bounded by how many run concurrently, not unbounded like before this cap
 * existed at all.
 */
async function buildRepoTree(
  cwd: string,
  maxTotalNodes = TREE_MAX_TOTAL_NODES,
): Promise<{ tree: FileNode[]; truncated: boolean }> {
  const root = (await topLevel(cwd)) ?? cwd;
  const prefix = await showPrefix(cwd); // "" or "sub/dir/"

  const [lsRes, stRes] = await Promise.all([
    git(root, ["-c", "core.quotePath=false", "ls-files", "-z"]),
    git(root, [
      "-c",
      "core.quotePath=false",
      "-c",
      "status.relativePaths=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--ignored",
      "--no-renames",
    ]),
  ]);

  // Everything is repo-root-relative; strip the cwd prefix (dropping anything
  // outside the cwd subtree) so the client sees cwd-relative paths.
  const strip = (rootRel: string): string | null => {
    if (prefix) {
      if (!rootRel.startsWith(prefix)) return null;
      return rootRel.slice(prefix.length);
    }
    return rootRel;
  };

  const files = new Map<string, GitStatus>(); // cwd-relative file path -> status
  const collapsedDirs = new Map<string, GitStatus>(); // cwd-relative dir (no trailing /) -> status

  for (const p of lsRes.stdout.split("\0")) {
    if (!p) continue;
    const rel = strip(p);
    if (!rel) continue;
    if (!files.has(rel)) files.set(rel, null);
  }
  for (const { path, status } of parseStatusZ(stRes.stdout)) {
    const rel = strip(path);
    if (!rel) continue;
    if (rel.endsWith("/")) collapsedDirs.set(rel.replace(/\/+$/, ""), status);
    else files.set(rel, status);
  }

  const tree = assembleTree(files, collapsedDirs);
  let truncated = capTreeFiles(tree, TREE_MAX_FILES_PER_DIR);
  if (capTotalNodes(tree, maxTotalNodes)) truncated = true;
  return { tree, truncated };
}

/**
 * Enforce a GLOBAL node budget across an already-assembled tree,
 * breadth-first — a directory's own files count against the budget before
 * its subdirectories are explored, mirroring the ordering guarantee
 * `walkFs` makes during its own (live, directory-by-directory) traversal.
 * This has to be a post-hoc prune rather than a stop-early walk like
 * `walkFs`'s: `assembleTree` already builds the full tree in one shot from
 * `git ls-files`/`status` output, so there's no natural place to stop
 * partway through gathering it.
 *
 * A directory is never deleted outright once it's over budget — only its
 * children get truncated (or dropped without being explored) — so the
 * "directory itself still shows up" property `capTreeFiles` already gives
 * per-directory file counts also holds for the total-node cap.
 */
function capTotalNodes(rootChildren: FileNode[], maxTotalNodes: number): boolean {
  let total = 0;
  let truncated = false;
  const queue: FileNode[][] = [rootChildren];

  while (queue.length > 0) {
    const children = queue.shift()!;
    const files = children.filter((n) => !n.isDir);
    const dirs = children.filter((n) => n.isDir);

    const keep = Math.max(0, Math.min(files.length, maxTotalNodes - total));
    total += keep;
    const overflow = keep < files.length ? new Set(files.slice(keep)) : null;
    if (overflow) truncated = true;

    for (const dir of dirs) {
      if (total >= maxTotalNodes) {
        if (dir.children && dir.children.length > 0) {
          dir.children = [];
          truncated = true;
        }
        continue;
      }
      total++; // the directory's own entry
      if (dir.children && dir.children.length > 0) queue.push(dir.children);
    }

    if (overflow) {
      const filtered = children.filter((n) => !overflow.has(n));
      children.length = 0;
      children.push(...filtered);
    }
  }
  return truncated;
}

/** Runs `items` through `worker`, at most `limit` concurrently in flight —
 * see `NESTED_REPO_CONCURRENCY`'s doc for why this exists. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function lane(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      await worker(item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * Cap the number of FILE children under each directory (leaving all
 * subdirectories intact, however deep) so a directory with an enormous flat
 * file count can't blow up the DOM while every real directory in the repo
 * stays visible. Files are already alphabetically sorted by `sortNodes`
 * (called from `assembleTree`) before this runs, so a clipped directory still
 * shows its alphabetical head. Returns true if anything was clipped anywhere
 * in the tree.
 */
function capTreeFiles(nodes: FileNode[], maxFilesPerDir: number): boolean {
  let truncated = false;
  for (const n of nodes) {
    if (!n.isDir || !n.children) continue;
    if (capTreeFiles(n.children, maxFilesPerDir)) truncated = true;
    const dirs = n.children.filter((c) => c.isDir);
    const leaves = n.children.filter((c) => !c.isDir);
    if (leaves.length > maxFilesPerDir) {
      n.children = [...dirs, ...leaves.slice(0, maxFilesPerDir)];
      truncated = true;
    }
  }
  return truncated;
}

function assembleTree(
  files: Map<string, GitStatus>,
  collapsed: Map<string, GitStatus>,
): FileNode[] {
  const rootChildren: FileNode[] = [];
  const dirNodes = new Map<string, FileNode>();
  const explicitDir = new Set<string>(); // collapsed dirs whose status is authoritative

  function getDir(path: string): FileNode {
    const existing = dirNodes.get(path);
    if (existing) return existing;
    const slash = path.lastIndexOf("/");
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const node: FileNode = { name, path, isDir: true, status: null, children: [] };
    dirNodes.set(path, node);
    const parentPath = slash >= 0 ? path.slice(0, slash) : "";
    (parentPath ? getDir(parentPath).children! : rootChildren).push(node);
    return node;
  }

  for (const [path, status] of collapsed) {
    const node = getDir(path);
    node.status = status;
    // git collapsed this WHOLE directory into one porcelain line (ignored,
    // or untracked-and-not-yet-gitignored) instead of listing what's
    // inside — `node.children` is deliberately empty, not actually empty.
    // See buildFileSubtree for the on-demand fetch this enables.
    node.lazy = true;
    explicitDir.add(path);
  }

  for (const [rel, status] of files) {
    const slash = rel.lastIndexOf("/");
    const parentPath = slash >= 0 ? rel.slice(0, slash) : "";
    const name = slash >= 0 ? rel.slice(slash + 1) : rel;
    const leaf: FileNode = { name, path: rel, isDir: false, status };
    (parentPath ? getDir(parentPath).children! : rootChildren).push(leaf);
  }

  // Bottom-up rollup: a directory's status is the highest-priority status among
  // its descendants (changed > added > removed). Explicitly-set collapsed dirs
  // (ignored/untracked) keep their own status.
  function rollup(node: FileNode): GitStatus {
    if (!node.isDir) return node.status;
    if (explicitDir.has(node.path)) return node.status;
    let changed = false;
    let added = false;
    let removed = false;
    for (const c of node.children ?? []) {
      const s = rollup(c);
      if (s === "changed") changed = true;
      else if (s === "added") added = true;
      else if (s === "removed") removed = true;
    }
    node.status = changed ? "changed" : added ? "added" : removed ? "removed" : null;
    return node.status;
  }
  for (const n of rootChildren) rollup(n);

  sortNodes(rootChildren);
  return rootChildren;
}

function sortNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name)));
  for (const n of nodes) if (n.children) sortNodes(n.children);
}

/**
 * Non-repo fallback: a plain recursive listing with no git decoration and
 * therefore no `.gitignore` to prune with — used when `cwd` (typically a
 * session's private root, one level above wherever the actual repo it
 * cloned landed) isn't itself inside a git work tree. Symlinks are skipped
 * (never followed).
 *
 * Three independent safeguards, mirroring how the git-aware path above (and
 * file-watch.ts's live watcher) already stay cheap on a huge tree:
 *
 *  1. `DENYLIST` (shared with file-watch.ts) is never walked INTO EAGERLY —
 *     a directory whose name matches it (node_modules, dist, .venv, …) is
 *     still shown, dimmed the same way a git-ignored directory is on the
 *     git-aware path (`status: "ignored"`), so the navigator doesn't hide a
 *     perfectly real directory just because there's no repo here to mark it
 *     "ignored" itself — but it's returned with `lazy: true` and empty
 *     `children` instead of being recursed into, so a huge `node_modules`
 *     can't burn the node budget on a request nobody asked for. Its full,
 *     real (however deep) tree is still completely reachable: the FIRST
 *     time the navigator expands it, `buildFileSubtree` below walks it for
 *     real, on demand. `.git` is the one exception: dropped outright, not
 *     even shown collapsed — matching the git-aware path, where
 *     `git ls-files`/`status` never report their own `.git` either. This is
 *     a DISPLAY-only decision: file-watch.ts applies the exact same name
 *     list completely separately, to decide what never gets an OS-level
 *     watch at all — the two are intentionally independent (see
 *     file-watch.ts's module doc comment for why watching one of these is a
 *     much bigger cost than merely listing or lazily browsing it).
 *  2. Any subdirectory that turns out to itself be a git work tree root
 *     (the common case: `cwd` is a session's private root and the actual
 *     clone lives one level down, e.g. `cwd/<repo>/.git`) is handed off to
 *     the git-aware `buildRepoTree` instead of being walked plainly. Without
 *     this, every file below a cloned repo would permanently report
 *     `status: null`, and the "files changed" indicator could never show
 *     anything for a git-cloned session no matter what changed inside it.
 *     Sibling nested repos under the same directory are delegated
 *     CONCURRENTLY (bounded by `NESTED_REPO_CONCURRENCY`) rather than one
 *     at a time, and all share the same `maxTotalNodes` budget as the rest
 *     of this walk (via `buildRepoTree`'s own `capTotalNodes` pass) — a
 *     nested repo is exactly as capable of blowing up the DOM as a huge
 *     plain directory, so it gets the same backstop.
 *  3. The walk is BREADTH-first, not depth-first: every directory's own
 *     immediate files are queued and counted against `TREE_MAX_TOTAL_NODES`
 *     before any of its subdirectories are expanded. A depth-first walk
 *     that fully recurses subdirectory-by-subdirectory before ever getting
 *     to a directory's own files can have the global budget exhausted
 *     entirely inside one early, deep subtree — silently hiding that
 *     directory's own files (and every later sibling) even though they're
 *     shallow and would easily have fit. Breadth-first spends the budget
 *     level-by-level instead, so a single heavy subtree can only ever
 *     crowd out OTHER deep content, never its own siblings' shallow files.
 *
 * `maxTotalNodes` defaults to the production cap and is only ever
 * overridden by tests, which need a much smaller budget to exercise the
 * exhaustion path without actually generating tens of thousands of files.
 */
/** Mutates `nodes` (and all descendants) in place, prepending `prefix/` to
 * every `path`. Used when splicing a nested repo's own git-relative tree
 * (paths relative to that repo's root) into an outer walkFs tree (paths
 * relative to the outer cwd). */
function reprefixPaths(nodes: FileNode[], prefix: string): void {
  for (const n of nodes) {
    n.path = `${prefix}/${n.path}`;
    if (n.children) reprefixPaths(n.children, prefix);
  }
}

export async function walkFs(
  cwd: string,
  maxTotalNodes = TREE_MAX_TOTAL_NODES,
): Promise<{ tree: FileNode[]; truncated: boolean }> {
  let truncated = false;
  let total = 0;

  interface QueueItem {
    absDir: string;
    relDir: string;
    /** The array this directory's own entries get pushed into — either the
     * root list or the `children` of the FileNode created for it when it
     * was itself dequeued. */
    children: FileNode[];
  }

  const rootChildren: FileNode[] = [];
  const queue: QueueItem[] = [{ absDir: cwd, relDir: "", children: rootChildren }];

  while (queue.length > 0) {
    const { absDir, relDir, children } = queue.shift()!;
    let ents;
    try {
      ents = await readdir(absDir, { withFileTypes: true });
    } catch {
      continue; // permission error / transient — skip this subtree
    }

    let files = ents.filter((e) => e.isFile() && !e.isSymbolicLink());
    if (files.length > TREE_MAX_FILES_PER_DIR) {
      files = files.sort((a, b) => a.name.localeCompare(b.name)).slice(0, TREE_MAX_FILES_PER_DIR);
      truncated = true;
    }
    const dirs = ents.filter((e) => e.isDirectory() && !e.isSymbolicLink());

    // This directory's own files first — see the breadth-first rationale
    // above for why files must never be ordered after subdirectory expansion.
    for (const e of files) {
      if (total >= maxTotalNodes) { truncated = true; break; }
      total++;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      children.push({ name: e.name, path: rel, isDir: false, status: null });
    }
    const pendingRepos: { node: FileNode; childAbs: string; rel: string }[] = [];
    for (const e of dirs) {
      if (total >= maxTotalNodes) { truncated = true; break; }

      // Git's own dir — never listed, matching the git-aware path (ls-files
      // / status never report it either). Doesn't consume budget.
      if (e.name === ".git") continue;

      total++;
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      const childAbs = join(absDir, e.name);

      if (DENYLIST.has(e.name)) {
        // Visible, and fully browsable via `buildFileSubtree` on demand —
        // just never walked EAGERLY. See the safeguard-1 doc comment above
        // this function for the full rationale.
        children.push({ name: e.name, path: rel, isDir: true, status: "ignored", children: [], lazy: true });
        continue;
      }

      if (existsSync(join(childAbs, ".git"))) {
        // Nested repo root — delegate the whole subtree to the git-aware
        // path so it gets real added/changed/removed status, instead of
        // walking it plainly. Dispatched below, after this loop, bounded by
        // NESTED_REPO_CONCURRENCY — several sibling repos under the same
        // directory (e.g. multiple `/hooop:mount`ed projects) would otherwise
        // either serialize (N × a full git round trip each) or, unbounded,
        // spawn every sibling's git pair at once.
        const node: FileNode = { name: e.name, path: rel, isDir: true, status: null, children: [] };
        children.push(node);
        pendingRepos.push({ node, childAbs, rel });
        continue;
      }

      const nodeChildren: FileNode[] = [];
      children.push({ name: e.name, path: rel, isDir: true, status: null, children: nodeChildren });
      // Enqueued, not recursed into immediately — expansion happens once
      // every shallower directory (including this one's own siblings) has
      // already had its turn, which is what makes this breadth-first.
      queue.push({ absDir: childAbs, relDir: rel, children: nodeChildren });
    }

    if (pendingRepos.length > 0) {
      // Remaining slice of the GLOBAL node budget, snapshotted once before
      // dispatch — see buildRepoTree's `maxTotalNodes` doc for why each
      // concurrent sibling gets this same snapshot rather than a precisely
      // shared counter.
      const remainingBudget = Math.max(0, maxTotalNodes - total);
      await mapWithConcurrency(pendingRepos, NESTED_REPO_CONCURRENCY, async ({ node, childAbs, rel }) => {
        inFlightNestedRepoBuilds++;
        peakNestedRepoBuilds = Math.max(peakNestedRepoBuilds, inFlightNestedRepoBuilds);
        try {
          const { tree: repoChildren, truncated: repoTruncated } = await buildRepoTree(childAbs, remainingBudget);
          if (repoTruncated) truncated = true;
          // buildRepoTree's paths are relative to childAbs (the nested repo
          // root), not to the outer walkFs cwd — reprefix with `rel` so the
          // whole response stays consistently cwd-relative throughout, the
          // same contract every other node in this tree already honors.
          reprefixPaths(repoChildren, rel);
          node.children = repoChildren;
        } catch {
          // Corrupt/partial repo — fall back to a plain walk of this dir
          // rather than leaving it permanently empty.
          queue.push({ absDir: childAbs, relDir: rel, children: node.children! });
        } finally {
          inFlightNestedRepoBuilds--;
        }
      });
    }
  }

  sortNodes(rootChildren);
  return { tree: rootChildren, truncated };
}

// ── Preview ────────────────────────────────────────────────────────────────

export async function buildFilePreview(cwd: string, relPath: string): Promise<FilePreview> {
  const policy = isAllowedCwd(cwd);
  if (!policy.ok) throw new CwdPolicyError(policy.reason ?? "cwd not allowed");

  const isMarkdown = /\.md$/i.test(relPath);
  const abs = resolveUnderCwd(cwd, relPath); // throws on escape
  const repo = await insideWorkTree(cwd);
  const status: GitStatus = repo ? await fileStatus(cwd, relPath) : null;

  // Removed file: nothing to read on disk; the diff carries the old content.
  if (status === "removed") {
    const d = await computeDiff(cwd, relPath, "removed");
    return {
      status,
      isMarkdown,
      diff: d === "toolarge" ? null : d,
      content: null,
      truncated: false,
      sizeBytes: 0,
      binary: false,
      diffTooLarge: d === "toolarge",
      // A removed image has nothing on disk to render; the diff path handles it.
      isImage: false,
      imageType: null,
      imageTooLarge: false,
      mtimeMs: 0,
    };
  }

  // Classify BEFORE reading as text: an image otherwise reaches readCapped, trips
  // the NUL sniffer and comes back as an unpreviewable binary, which is exactly
  // the dead end this replaces. Cheap — stats the file and reads 64 bytes.
  // A null (not an image, or extension/bytes disagree) falls through untouched.
  let image: Awaited<ReturnType<typeof classifyImage>> = null;
  try {
    image = await classifyImage(abs);
  } catch { /* unreadable/vanished — fall through to the text path */ }

  let mtimeMs = 0;
  try { mtimeMs = (await stat(abs)).mtimeMs; } catch { /* leave 0 */ }

  // An over-cap image is reported, not read: there is no useful prefix of a PNG.
  if (image?.tooLarge) {
    return {
      status, isMarkdown, diff: null, content: null, truncated: false,
      sizeBytes: image.size, binary: true, diffTooLarge: false,
      isImage: true, imageType: image.mediaType, imageTooLarge: true, mtimeMs,
    };
  }

  // A raster's text read is pure waste — up to 512 KB of PNG pulled in, sniffed
  // as binary and thrown away, on a payload the navigator refetches after every
  // write under the cwd. SVG is the exception: it IS text, and its source and
  // diff are what the Eye toggle shows.
  const isSvg = image?.mediaType === "image/svg+xml";
  const readAsText = !image || isSvg;

  let content: string | null = null;
  let sizeBytes = image?.size ?? 0;
  let truncated = false;
  let binary = !!image && !isSvg; // a raster is binary; nothing read it to find out
  if (readAsText) {
    try {
      const r = await readCapped(abs, PREVIEW_MAX_BYTES);
      content = r.content;
      sizeBytes = r.size;
      truncated = r.truncated;
      binary = r.binary;
    } catch {
      content = null;
    }
  }

  let diff: FileDiff | null = null;
  let diffTooLarge = false;
  if (repo && !binary && (status === "added" || status === "changed")) {
    if (status === "added") {
      diff = buildAddedDiff(content ?? "", truncated);
    } else {
      const d = await computeDiff(cwd, relPath, "modified");
      if (d === "toolarge") diffTooLarge = true;
      else diff = d;
    }
  }

  // SVG keeps `content` and `diff` alongside isImage — it IS text, so the dock
  // can offer the source and a changed SVG's diff behind the same Eye toggle
  // markdown already uses. Raster images have neither.
  return {
    status, isMarkdown, diff, content, truncated, sizeBytes,
    binary, diffTooLarge,
    isImage: !!image,
    imageType: image?.mediaType ?? null,
    imageTooLarge: false,
    mtimeMs,
  };
}

async function fileStatus(cwd: string, rel: string): Promise<GitStatus> {
  const r = await git(cwd, [
    "-c",
    "core.quotePath=false",
    "status",
    "--porcelain=v1",
    "-z",
    "--ignored",
    "--no-renames",
    "--",
    rel,
  ]);
  if (r.code !== 0) return null;
  const entries = parseStatusZ(r.stdout);
  if (!entries.length) return null;
  const exact = entries.find((e) => e.path === rel || e.path === `${rel}/`);
  return (exact ?? entries[0]).status;
}

async function computeDiff(
  cwd: string,
  rel: string,
  kind: "modified" | "removed",
): Promise<FileDiff | null | "toolarge"> {
  // Full context (`-U<huge>`) so the patch carries EVERY line — the preview
  // renders the whole file with changes marked inline, not just hunks with a
  // few lines of surrounding context. The client's navigator then jumps
  // between change blocks. Files are read-capped well under this, so the value
  // just has to exceed any real line count.
  const r = await git(cwd, ["-c", "core.quotePath=false", "diff", "--unified=1000000", "HEAD", "--", rel]);
  if (!r.stdout) return null;
  if (r.stdout.length > DIFF_MAX_BYTES) return "toolarge";
  // A binary change shows "Binary files … differ" with no hunks.
  const parsed = parseUnifiedDiff(r.stdout);
  if (!parsed.hunks.length) return null;
  return { kind: kind === "removed" ? "removed" : "modified", adds: parsed.adds, dels: parsed.dels, hunks: parsed.hunks };
}

/** Synthesize an all-additions diff for a new (untracked/staged-add) file from
 * its content, so the preview shows it in the same diff view as other changes. */
function buildAddedDiff(content: string, truncated: boolean): FileDiff {
  const body = content.replace(/\n$/, "");
  const lines = body.length ? body.split("\n") : [];
  const hunkLines: DiffLine[] = lines.map((t, i) => ({ sign: "+", oldNo: null, newNo: i + 1, text: t }));
  return {
    kind: "added",
    adds: lines.length,
    dels: 0,
    hunks: lines.length
      ? [{ header: `@@ -0,0 +1,${lines.length} @@${truncated ? " (truncated)" : ""}`, lines: hunkLines }]
      : [],
  };
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function parseUnifiedDiff(patch: string): { hunks: DiffHunk[]; adds: number; dels: number } {
  const hunks: DiffHunk[] = [];
  let adds = 0;
  let dels = 0;
  let cur: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const m = HUNK_RE.exec(line);
      if (!m) {
        cur = null;
        continue;
      }
      oldNo = parseInt(m[1], 10);
      newNo = parseInt(m[2], 10);
      cur = { header: line, lines: [] };
      hunks.push(cur);
      continue;
    }
    // Anything before the first hunk (diff --git / index / --- / +++) is
    // preamble; skip it. "\ No newline at end of file" markers too.
    if (!cur || line.startsWith("\\")) continue;
    const sign = line[0];
    const text = line.slice(1);
    if (sign === "+") {
      cur.lines.push({ sign: "+", oldNo: null, newNo, text });
      newNo++;
      adds++;
    } else if (sign === "-") {
      cur.lines.push({ sign: "-", oldNo, newNo: null, text });
      oldNo++;
      dels++;
    } else if (sign === " ") {
      cur.lines.push({ sign: " ", oldNo, newNo, text });
      oldNo++;
      newNo++;
    }
  }
  return { hunks, adds, dels };
}
