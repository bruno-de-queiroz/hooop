import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CwdPolicyError } from "./files";
import { buildFilePreview, buildFileSubtree, buildFileTree, walkFs, __testing__ } from "./git";

const execFileAsync = promisify(execFile);

function findByPath(nodes: import("./git").FileNode[], path: string): import("./git").FileNode | null {
  for (const n of nodes) {
    if (n.path === path) return n;
    if (n.children) {
      const r = findByPath(n.children, path);
      if (r) return r;
    }
  }
  return null;
}

function countNodes(nodes: import("./git").FileNode[]): number {
  return nodes.reduce((n, node) => n + 1 + (node.children ? countNodes(node.children) : 0), 0);
}

async function makeRepo(dir: string, fileCount: number): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await execFileAsync("git", ["init", "-q"], { cwd: dir });
  for (let i = 0; i < fileCount; i++) writeFileSync(join(dir, `f${i}.txt`), "x".repeat(200));
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync(
    "git",
    ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"],
    { cwd: dir },
  );
}

describe("git.ts — buildFileTree / walkFs (non-repo fallback)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "sandbox-git-tree-"));
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("shows denylisted directories (node_modules, dist, …) as lazy-loadable, not walked eagerly — but still drops .git outright", async () => {
    // Visibility (this file) and watching (file-watch.ts) are deliberately
    // independent: node_modules/dist/etc. must show up in the navigator —
    // and be FULLY browsable via buildFileSubtree (see the dedicated test
    // below) — even with no git repo around to mark them "ignored". Their
    // contents just must never be enumerated by the EAGER top-level walk
    // (that's what actually protects the node budget from a huge
    // node_modules), so they land in the initial tree flagged `lazy: true`
    // with empty `children` rather than hidden outright or fully expanded.
    // `.git` alone stays fully hidden, matching the git-aware path
    // (ls-files/status never report it either).
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "x");
    mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
    writeFileSync(join(cwd, ".git", "objects", "abc123"), "x");
    mkdirSync(join(cwd, "dist"), { recursive: true });
    writeFileSync(join(cwd, "dist", "bundle.js"), "x");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "index.ts"), "x");
    writeFileSync(join(cwd, "README.md"), "x");

    const { tree } = await walkFs(cwd);
    const names = tree.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(["src", "README.md", "node_modules", "dist"]));
    expect(names).not.toContain(".git");

    const nodeModules = findByPath(tree, "node_modules");
    expect(nodeModules?.status).toBe("ignored");
    expect(nodeModules?.lazy).toBe(true);
    expect(nodeModules?.children).toEqual([]); // shown, but never walked into eagerly

    const dist = findByPath(tree, "dist");
    expect(dist?.status).toBe("ignored");
    expect(dist?.lazy).toBe(true);
    expect(dist?.children).toEqual([]);

    // A regular, non-denylisted directory must NOT be marked lazy — it was
    // actually walked, its `children` is the real (complete) answer.
    const src = findByPath(tree, "src");
    expect(src?.lazy).toBeUndefined();
  });

  it("buildFileSubtree loads a denylisted directory's REAL (nested) contents on demand — the lazy placeholder's full tree is completely reachable, just not eager", async () => {
    mkdirSync(join(cwd, "node_modules", "pkg-a", "lib"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "pkg-a", "index.js"), "x");
    writeFileSync(join(cwd, "node_modules", "pkg-a", "lib", "deep.js"), "x");
    mkdirSync(join(cwd, "node_modules", "pkg-b"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "pkg-b", "index.js"), "x");

    const { tree: top } = await walkFs(cwd);
    const placeholder = findByPath(top, "node_modules");
    expect(placeholder?.lazy).toBe(true);
    expect(placeholder?.children).toEqual([]); // confirms this is actually exercising the lazy path

    const { tree: sub, repo } = await buildFileSubtree(cwd, "node_modules");
    expect(repo).toBe(false); // node_modules here isn't itself a git work tree
    // Every path comes back cwd-relative (prefixed with "node_modules/"),
    // matching the contract the rest of the tree already honors — a client
    // splices this straight into the placeholder node found above.
    const deep = findByPath(sub, "node_modules/pkg-a/lib/deep.js");
    expect(deep).not.toBeNull();
    const pkgBIndex = findByPath(sub, "node_modules/pkg-b/index.js");
    expect(pkgBIndex).not.toBeNull();
  });

  it("buildFileSubtree loads a git-collapsed ignored directory's real contents on demand", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd });
    writeFileSync(join(cwd, ".gitignore"), "build-output/\n");
    mkdirSync(join(cwd, "build-output", "nested"), { recursive: true });
    writeFileSync(join(cwd, "build-output", "bundle.js"), "x");
    writeFileSync(join(cwd, "build-output", "nested", "chunk.js"), "x");

    const top = await buildFileTree(cwd);
    expect(top.repo).toBe(true);
    const placeholder = findByPath(top.tree, "build-output");
    expect(placeholder?.status).toBe("ignored");
    expect(placeholder?.lazy).toBe(true);
    expect(placeholder?.children).toEqual([]);

    const { tree: sub } = await buildFileSubtree(cwd, "build-output");
    expect(findByPath(sub, "build-output/bundle.js")).not.toBeNull();
    expect(findByPath(sub, "build-output/nested/chunk.js")).not.toBeNull();
  });

  it("buildFileSubtree rejects a path that escapes cwd", async () => {
    await expect(buildFileSubtree(cwd, "../../etc")).rejects.toBeInstanceOf(CwdPolicyError);
  });

  it("buildFileSubtree honors a caller-supplied node budget, clamped to the per-response cap", async () => {
    // The cap is per RESPONSE, so a navigator expanding one lazy directory
    // after another accumulates one full budget per expansion in its own
    // state — nothing here bounds their SUM. `max` is how the client spends
    // down a budget of its own across several of these calls.
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(cwd, "node_modules", "pkg", `f${i}.js`), "x");

    const { tree, truncated } = await buildFileSubtree(cwd, "node_modules", 5);
    expect(countNodes(tree)).toBeLessThanOrEqual(5);
    expect(truncated).toBe(true);

    // Omitted, or larger than the cap, both mean "as much as you'd normally
    // give me". (That the oversized value is CLAMPED rather than honored
    // isn't observable here without generating 20k+ files; the HTTP layer
    // clamps the query param too, so this is the inner of two guards.)
    const full = await buildFileSubtree(cwd, "node_modules");
    expect(countNodes(full.tree)).toBe(31); // "pkg" plus its 30 files
    expect(full.truncated).toBe(false);
    const oversized = await buildFileSubtree(cwd, "node_modules", Number.MAX_SAFE_INTEGER);
    expect(countNodes(oversized.tree)).toBe(countNodes(full.tree));
    expect(oversized.truncated).toBe(false);
  });

  it("still shows a directory's OWN files even when one of its subdirectories is huge (breadth-first, not depth-first)", async () => {
    // Reproduces the exact reported bug: a session root whose cloned repo
    // has a big subdirectory (e.g. a real .git object store, or
    // node_modules) — walking that subtree first, depth-first, and only
    // getting back to the parent's own files afterward silently drops
    // those files once the (here, deliberately tiny) node budget is spent.
    mkdirSync(join(cwd, "big"), { recursive: true });
    for (let i = 0; i < 20; i++) writeFileSync(join(cwd, "big", `f${i}.txt`), "x");
    mkdirSync(join(cwd, "docs"), { recursive: true });
    writeFileSync(join(cwd, "docs", "readme.md"), "x");
    writeFileSync(join(cwd, "top.txt"), "x");

    // Budget only large enough for "big" (a dir) + a handful of its files —
    // nowhere near enough to also cover "docs", "top.txt" AND all of "big"'s
    // files, so the fix is meaningfully exercised (this must still count as
    // truncated), while the assertion is: root's own file/dir survive.
    const { tree, truncated } = await walkFs(cwd, 5);

    const names = tree.map((n) => n.name);
    expect(names).toContain("top.txt");
    expect(names).toContain("docs");
    expect(truncated).toBe(true);
  });

  it("full end-to-end: a git-repo child of a non-repo cwd still shows ALL of its own top-level files", async () => {
    // The precise shape of the reported bug: cwd itself (a session's
    // private root) is NOT a git repo, but its one child ("hooop") is a
    // real clone with its own heavy .git/ and a node_modules subdir.
    const repoDir = join(cwd, "hooop");
    mkdirSync(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
    writeFileSync(join(repoDir, ".gitignore"), "node_modules\n");
    mkdirSync(join(repoDir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repoDir, "node_modules", "pkg", "index.js"), "x");
    mkdirSync(join(repoDir, "docs"), { recursive: true });
    writeFileSync(join(repoDir, "docs", "readme.md"), "x");
    writeFileSync(join(repoDir, "README.md"), "x");
    writeFileSync(join(repoDir, "LICENSE"), "x");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: repoDir },
    );

    const result = await buildFileTree(cwd);
    // cwd (the session root) is not itself a repo — confirms this test is
    // actually exercising the walkFs fallback, not the git-aware path.
    expect(result.repo).toBe(false);

    const hooop = findByPath(result.tree, "hooop");
    expect(hooop).not.toBeNull();
    const childNames = (hooop?.children ?? []).map((c) => c.name);
    expect(childNames).toEqual(expect.arrayContaining(["docs", "README.md", "LICENSE"]));
    expect(childNames).not.toContain(".git"); // git itself never lists its own dir
    // node_modules is git-ignored, so — same as a top-level repo cwd — it's
    // shown but dimmed (status "ignored"), not hidden outright. walkFs's
    // blanket denylist no longer applies once a subtree is git-aware; the
    // repo's own .gitignore is the (more precise) signal now.
    const nodeModules = findByPath(result.tree, "hooop/node_modules");
    expect(nodeModules?.status).toBe("ignored");
    expect(nodeModules?.lazy).toBe(true);
    // Every path returned for content inside the nested repo must stay
    // cwd-relative (prefixed with "hooop/"), matching the rest of the tree.
    const readme = findByPath(result.tree, "hooop/README.md");
    expect(readme).not.toBeNull();
  });

  it("decorates a nested repo's own git status — not just its file list — so the 'files changed' pill isn't permanently empty for a cloned session", async () => {
    // Before this fix, `walkFs` never ran git at all below the point where
    // `cwd` itself failed the `insideWorkTree` check, so every file inside a
    // cloned repo (the common session shape: private root + one child clone)
    // always reported `status: null` — the affected-files indicator could
    // never show anything no matter what changed inside the clone.
    const repoDir = join(cwd, "hooop");
    mkdirSync(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
    writeFileSync(join(repoDir, "committed.txt"), "x");
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: repoDir },
    );
    // Simulate an in-session edit: modify a tracked file, add an untracked one.
    writeFileSync(join(repoDir, "committed.txt"), "changed");
    writeFileSync(join(repoDir, "new-file.txt"), "x");

    const result = await buildFileTree(cwd);
    // Paths must be cwd-relative ("hooop/…"), not repo-relative ("…") — this
    // is what a client-side lookup by path actually keys on.
    const changed = findByPath(result.tree, "hooop/committed.txt");
    const added = findByPath(result.tree, "hooop/new-file.txt");
    expect(changed?.status).toBe("changed");
    expect(added?.status).toBe("added");
  });

  it("processes sibling nested repos CONCURRENTLY, and never more than the cap at once", async () => {
    // Realistic shape per /hooop:mount: several projects cloned/mounted as
    // direct siblings under one shared workspace cwd.
    //
    // This counts the overlap instead of timing it — see the note on
    // `peakNestedRepoBuilds` in git.ts for why the stopwatch version of this
    // test was unfixable rather than merely mistuned.
    const limit = __testing__.NESTED_REPO_CONCURRENCY;
    for (let i = 0; i < limit + 2; i++) await makeRepo(join(cwd, `repo${i}`), 4);

    __testing__.resetPeakNestedRepoBuilds();
    await walkFs(cwd);

    // Exactly the cap, which pins BOTH halves of what the limiter is for in a
    // single number: serializing scores 1, dropping the bound scores all
    // `limit + 2`. The value is deterministic rather than racy — the limiter
    // opens its lanes in a synchronous loop, so every lane is occupied before
    // the first `await` in any of them can yield.
    expect(__testing__.peakNestedRepoBuilds()).toBe(limit);
  }, 60000);

  it("caps a nested repo's total node count too, not just its per-directory file count (shared global budget)", async () => {
    // Many small directories, one file each — defeats capTreeFiles (which
    // only caps FILES per directory, and 1 is nowhere near that limit) but
    // must still be caught by a total-node budget, the same way walkFs's
    // own plain-FS traversal already is.
    const repoDir = join(cwd, "hooop");
    mkdirSync(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "-q"], { cwd: repoDir });
    for (let i = 0; i < 50; i++) {
      mkdirSync(join(repoDir, `d${i}`), { recursive: true });
      writeFileSync(join(repoDir, `d${i}`, "f.txt"), "x");
    }
    await execFileAsync("git", ["add", "."], { cwd: repoDir });
    await execFileAsync(
      "git",
      ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      { cwd: repoDir },
    );

    // Tiny total budget — nowhere near enough for 50 dirs × 2 nodes each
    // plus the outer "hooop" entry itself.
    const { truncated } = await walkFs(cwd, 10);
    expect(truncated).toBe(true);
  });
});

describe("git.ts — buildFilePreview image classification", () => {
  let dir: string;

  // Header + filler; buildFilePreview never decodes, so a valid header is enough.
  const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const png = (pad = 300) => Buffer.concat([PNG_HEADER, Buffer.alloc(pad, 0x42)]);
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "preview-image-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks a PNG as a renderable image instead of an unpreviewable binary", async () => {
    writeFileSync(join(dir, "shot.png"), png());
    const p = await buildFilePreview(dir, "shot.png");
    expect(p.isImage).toBe(true);
    expect(p.imageType).toBe("image/png");
    expect(p.imageTooLarge).toBe(false);
    expect(p.sizeBytes).toBe(308);
    expect(p.mtimeMs).toBeGreaterThan(0);
    // No text read for a raster: content stays null and `binary` is asserted
    // without pulling half a megabyte of PNG through readCapped.
    expect(p.content).toBeNull();
    expect(p.binary).toBe(true);
    expect(p.truncated).toBe(false);
  });

  it("keeps an SVG's source alongside isImage, so the Eye toggle has something to show", async () => {
    writeFileSync(join(dir, "logo.svg"), SVG);
    const p = await buildFilePreview(dir, "logo.svg");
    expect(p.isImage).toBe(true);
    expect(p.imageType).toBe("image/svg+xml");
    expect(p.content).toBe(SVG);
    expect(p.binary).toBe(false);
  });

  it("reports an over-cap image by size rather than trying to render it", async () => {
    // 2 MB + 1: recognised, deliberately not read.
    writeFileSync(join(dir, "huge.png"), Buffer.concat([PNG_HEADER, Buffer.alloc(2 * 1024 * 1024 + 1, 0x42)]));
    const p = await buildFilePreview(dir, "huge.png");
    expect(p.isImage).toBe(true);
    expect(p.imageTooLarge).toBe(true);
    expect(p.sizeBytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(p.content).toBeNull();
    expect(p.diff).toBeNull();
  });

  it("leaves a mislabelled file to the ordinary text/binary path", async () => {
    // Extension says PNG, bytes say text — classification declines, so this must
    // preview as the text file it is rather than as an image.
    writeFileSync(join(dir, "fake.png"), "console.log('not a png');\n");
    const p = await buildFilePreview(dir, "fake.png");
    expect(p.isImage).toBe(false);
    expect(p.imageType).toBeNull();
    expect(p.content).toBe("console.log('not a png');\n");
  });

  it("does not treat an ordinary source file as an image", async () => {
    writeFileSync(join(dir, "a.ts"), "export const x = 1;\n");
    const p = await buildFilePreview(dir, "a.ts");
    expect(p.isImage).toBe(false);
    expect(p.imageTooLarge).toBe(false);
    expect(p.content).toBe("export const x = 1;\n");
  });

  it("reports a removed image as not-an-image (nothing on disk to render)", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "gone.png"), png());
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-qm", "add"], { cwd: dir });
    rmSync(join(dir, "gone.png"));

    const p = await buildFilePreview(dir, "gone.png");
    expect(p.status).toBe("removed");
    expect(p.isImage).toBe(false);
    expect(p.imageType).toBeNull();
    expect(p.mtimeMs).toBe(0);
  });

  it("flags a path that is not on disk as missing, not as an empty file", async () => {
    // The click-to-open path in the transcript can name anything the user typed
    // in a `#mention`, so "no such file" has to be distinguishable from "this
    // file is empty" — both otherwise arrive as content: null.
    const p = await buildFilePreview(dir, "nope/missing.ts");
    expect(p.missing).toBe(true);
    expect(p.content).toBeNull();
  });

  it("does not flag a genuinely empty file as missing", async () => {
    writeFileSync(join(dir, "empty.txt"), "");
    const p = await buildFilePreview(dir, "empty.txt");
    expect(p.missing).toBe(false);
    expect(p.content).toBe("");
  });

  it("does not flag a git-removed file as missing (its content is in the diff)", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "tracked.txt"), "hello\n");
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-qm", "add"], { cwd: dir });
    rmSync(join(dir, "tracked.txt"));

    const p = await buildFilePreview(dir, "tracked.txt");
    expect(p.status).toBe("removed");
    expect(p.missing).toBe(false);
  });

  it("still classifies a CHANGED image (the tree carries the badge, not the preview)", async () => {
    await execFileAsync("git", ["init", "-q"], { cwd: dir });
    await execFileAsync("git", ["config", "user.email", "t@t"], { cwd: dir });
    await execFileAsync("git", ["config", "user.name", "t"], { cwd: dir });
    writeFileSync(join(dir, "shot.png"), png());
    await execFileAsync("git", ["add", "-A"], { cwd: dir });
    await execFileAsync("git", ["commit", "-qm", "add"], { cwd: dir });
    writeFileSync(join(dir, "shot.png"), png(400)); // edit it

    const p = await buildFilePreview(dir, "shot.png");
    expect(p.status).toBe("changed");
    expect(p.isImage).toBe(true);
    // A binary diff would be noise, and the raster path never reads text, so
    // there is nothing to diff — the image itself is the preview.
    expect(p.diff).toBeNull();
  });
});
