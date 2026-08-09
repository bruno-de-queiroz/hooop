// Shared types for the filesystem navigator + file preview.

// Git state of a path, derived from the session's working tree.
export type GitStatus = "added" | "changed" | "removed" | "ignored" | null;

export interface FileNode {
  name: string; // basename
  path: string; // path relative to the session cwd, e.g. "src/hello.py"
  isDir: boolean;
  status: GitStatus; // for dirs: rolled-up status of descendants (null if none)
  children?: FileNode[]; // present for dirs
  /** This dir's `children` is a deliberately-unwalked placeholder (a huge
   * dependency/build dir the server never recurses into eagerly, or a
   * git-collapsed ignored/untracked dir) — NOT a genuinely empty directory.
   * The navigator fetches it on first expand via `useFilesUI().loadSubtree`
   * rather than trusting `children` as the final answer. */
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
  header: string; // "@@ -1,3 +1,5 @@ …"
  lines: DiffLine[];
}
export interface FileDiff {
  kind: "modified" | "added" | "removed";
  adds: number;
  dels: number;
  hunks: DiffHunk[];
}

// Everything the preview dock needs for one file. Mirrors the sandbox's
// FilePreview (lib/git.ts) — the fetched response is used as-is.
export interface FilePreviewData {
  status: GitStatus;
  isMarkdown: boolean;
  diff: FileDiff | null; // present when the file has changes
  content: string | null; // raw text for unchanged files / markdown source
  truncated?: boolean; // content clipped at the read cap
  sizeBytes?: number; // true on-disk size
  binary?: boolean; // binary file — no text content
  diffTooLarge?: boolean; // diff exceeded the render cap and was dropped
  /** Renderable image (extension AND magic bytes agreed, sandbox-side). The dock
   * shows it instead of content/diff. Bytes come from `/api/files/raw` keyed by
   * `mtimeMs` — never from this payload, which is refetched on every write under
   * the cwd (see useFilePreview). */
  isImage?: boolean;
  imageType?: string | null;
  /** An image over the preview cap: show its size rather than a broken tile. */
  imageTooLarge?: boolean;
  /** Cache key for the raw URL, so an unrelated write doesn't refetch the image. */
  mtimeMs?: number;
  /** The path is not on disk. Distinct from an empty file (`content: ""`), which
   * this payload would otherwise be indistinguishable from — see useFilePreview,
   * which turns this into an error rather than rendering a blank pane. */
  missing?: boolean;
}
