import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import type { DiffLine, FileDiff, FilePreviewData } from "./types";

// The diff view auto-scrolls to the first change when a file is opened, so a
// change buried below an unchanged head is visible immediately. That jump must
// fire ONCE per open: the navigator refetches this file on every write anywhere
// under the session cwd, and re-running it there yanked the reader back up
// mid-read. This is a scroll reset independent of the preview flicker (see
// useFilePreview.test.tsx) — it survives even when the pane never unmounts.

const preview: { current: FilePreviewData | null } = { current: null };
const openPath = { current: "a.ts" };

vi.mock("./useSessionFiles", () => ({
  useFilePreview: () => ({ data: preview.current, loading: false, error: null }),
  useAdjacentFiles: () => ({ prev: null, next: null }),
}));
vi.mock("@/app/context/FilesUIProvider", () => ({
  useFilesUI: () => ({
    file: { sessionId: "s1", path: openPath.current, name: openPath.current },
    closeFile: vi.fn(),
    openFile: vi.fn(),
  }),
}));
vi.mock("@/app/context/ComposerInsertProvider", () => ({
  useComposerInsert: () => ({ insertReference: vi.fn(), canInsert: true }),
}));
vi.mock("../useResizableDock", () => ({
  useResizableDock: () => ({ width: 480, dragging: false, asideRef: { current: null }, onPointerDown: vi.fn() }),
}));
vi.mock("@/app/context/useSelectedCwd", () => ({ useSelectedCwd: () => "/workspace" }));

import { ShellFilesDock } from "./ShellFilesDock";

/** A diff whose only change sits well below the top, so the auto-jump is
 * observable. `context` unchanged lines precede one added line. */
function diffWithChangeAt(context: number, addedText: string): FileDiff {
  const lines: DiffLine[] = Array.from({ length: context }, (_, i) => ({
    sign: " ",
    oldNo: i + 1,
    newNo: i + 1,
    text: `unchanged ${i + 1}`,
  }));
  lines.push({ sign: "+", oldNo: null, newNo: context + 1, text: addedText });
  return { kind: "modified", adds: 1, dels: 0, hunks: [{ header: "@@", lines }] };
}

const withDiff = (diff: FileDiff): FilePreviewData => ({
  status: "changed",
  isMarkdown: false,
  diff,
  content: null,
  truncated: false,
  sizeBytes: 100,
  binary: false,
  diffTooLarge: false,
});

let scrollCalls: number;

beforeEach(() => {
  scrollCalls = 0;
  preview.current = null;
  openPath.current = "a.ts";
  // jsdom implements neither scrollTo nor layout, so count calls rather than
  // asserting an offset — the bug is the jump happening again at all.
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    writable: true,
    value: () => {
      scrollCalls += 1;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ShellFilesDock diff view — auto-jump to the first change", () => {
  it("jumps once when the file opens", async () => {
    preview.current = withDiff(diffWithChangeAt(40, "added line"));
    await act(async () => {
      render(<ShellFilesDock />);
    });
    expect(scrollCalls).toBe(1);
  });

  it("does NOT jump again when the same file is refetched with identical content", async () => {
    const diff = diffWithChangeAt(40, "added line");
    preview.current = withDiff(diff);
    const { rerender } = render(<ShellFilesDock />);
    await act(async () => {});
    expect(scrollCalls).toBe(1);

    // A live refresh hands down a structurally-equal but NEWLY-PARSED diff, so
    // `blocks` has a fresh identity even though nothing moved. That identity
    // change alone used to re-run the jump.
    preview.current = withDiff(diffWithChangeAt(40, "added line"));
    await act(async () => {
      rerender(<ShellFilesDock />);
    });
    expect(scrollCalls).toBe(1);
  });

  it("does NOT jump again when the file's content actually changes", async () => {
    // Still no jump: the reader is mid-file and the agent just wrote to it.
    // Reading position is theirs to keep; only opening a file re-aims it.
    preview.current = withDiff(diffWithChangeAt(40, "added line"));
    const { rerender } = render(<ShellFilesDock />);
    await act(async () => {});
    expect(scrollCalls).toBe(1);

    preview.current = withDiff(diffWithChangeAt(60, "a different added line"));
    await act(async () => {
      rerender(<ShellFilesDock />);
    });
    expect(scrollCalls).toBe(1);
  });

  it("DOES jump again when a different file is opened", async () => {
    // The guard is per-instance and the parent keys DiffBody by path, so the
    // fix must not turn "jump on open" into "jump once per session".
    preview.current = withDiff(diffWithChangeAt(40, "added line"));
    const { rerender } = render(<ShellFilesDock />);
    await act(async () => {});
    expect(scrollCalls).toBe(1);

    openPath.current = "b.ts";
    preview.current = withDiff(diffWithChangeAt(30, "b's change"));
    await act(async () => {
      rerender(<ShellFilesDock />);
    });
    expect(scrollCalls).toBe(2);
  });

  it("still jumps when the diff arrives on a later render than the first", async () => {
    // The real sequence on open: the pane mounts with no data, the fetch lands a
    // frame or two later. The guard must not burn the one jump on an empty diff.
    preview.current = withDiff({ kind: "modified", adds: 0, dels: 0, hunks: [] });
    const { rerender } = render(<ShellFilesDock />);
    await act(async () => {});
    expect(scrollCalls).toBe(0);

    preview.current = withDiff(diffWithChangeAt(40, "added line"));
    await act(async () => {
      rerender(<ShellFilesDock />);
    });
    expect(scrollCalls).toBe(1);
  });
});

// ── Image view ───────────────────────────────────────────────────────────────

const asImage = (over: Partial<FilePreviewData> = {}): FilePreviewData => ({
  status: null,
  isMarkdown: false,
  diff: null,
  content: null,
  truncated: false,
  sizeBytes: 2048,
  binary: true, // a raster IS binary; isImage must win over that branch
  diffTooLarge: false,
  isImage: true,
  imageType: "image/png",
  imageTooLarge: false,
  mtimeMs: 1234,
  ...over,
});

function imgEl(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector("img");
}

describe("ShellFilesDock image view", () => {
  it("renders the image instead of the 'Binary file' dead end", async () => {
    preview.current = asImage();
    openPath.current = "assets/shot.png";
    const { container } = render(<ShellFilesDock />);
    await act(async () => {});

    expect(container.textContent).not.toMatch(/Binary file/);
    const img = imgEl(container);
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(
      "/api/files/raw?cwd=%2Fworkspace&path=assets%2Fshot.png&v=1234",
    );
  });

  // The src doubles as the cache key: an unrelated write in the cwd refetches the
  // preview payload, and if mtime is unchanged the URL must be byte-identical so
  // the browser serves the image from cache and nothing re-transfers.
  it("keeps the src stable when a refetch reports the same mtime", async () => {
    preview.current = asImage();
    openPath.current = "a.png";
    const { container, rerender } = render(<ShellFilesDock />);
    await act(async () => {});
    const first = imgEl(container)!.getAttribute("src");

    preview.current = asImage(); // fresh object, same mtime — the common case
    await act(async () => {
      rerender(<ShellFilesDock />);
    });
    expect(imgEl(container)!.getAttribute("src")).toBe(first);
  });

  it("changes the src when the image itself changed", async () => {
    preview.current = asImage();
    openPath.current = "a.png";
    const { container, rerender } = render(<ShellFilesDock />);
    await act(async () => {});
    const first = imgEl(container)!.getAttribute("src");

    preview.current = asImage({ mtimeMs: 9999 });
    await act(async () => {
      rerender(<ShellFilesDock />);
    });
    expect(imgEl(container)!.getAttribute("src")).not.toBe(first);
    expect(imgEl(container)!.getAttribute("src")).toMatch(/v=9999$/);
  });

  it("shows a size message for an over-cap image rather than a broken tile", async () => {
    preview.current = asImage({ imageTooLarge: true, sizeBytes: 5 * 1024 * 1024 });
    openPath.current = "huge.png";
    const { container } = render(<ShellFilesDock />);
    await act(async () => {});

    expect(container.textContent).toMatch(/too large to preview/i);
    expect(container.textContent).toMatch(/5\.0 MB/);
    expect(imgEl(container)).toBeNull();
  });

  // The security property of the whole feature: an SVG is rendered through
  // <img src>, where browsers refuse to execute script, and NEVER inlined into
  // the DOM where <script>/onload= would run in the dashboard's origin.
  it("renders SVG via <img>, never as inlined markup", async () => {
    const hostile = '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__pwned=1"><script>window.__pwned=1</script></svg>';
    preview.current = asImage({ imageType: "image/svg+xml", binary: false, content: hostile });
    openPath.current = "logo.svg";
    const { container } = render(<ShellFilesDock />);
    await act(async () => {});

    const img = imgEl(container);
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toMatch(/\/api\/files\/raw\?/);
    // The file's markup must never be parsed into the document. Scoped to the
    // hostile bits, since the header's lucide icons are legitimately <svg>.
    expect(container.querySelector("svg[onload]")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.innerHTML).not.toContain("onload=");
    expect(container.innerHTML).not.toContain("__pwned");
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  // The Eye's lit state must mean "the visual view is showing", the same as it
  // does for markdown. An SVG opens rendered, so the button starts PRESSED and
  // un-presses on the way to the source. Tracking the inverse looked like the Eye
  // was off while the image was plainly up.
  it("shows the Eye pressed while the SVG is rendered, and released on the source", async () => {
    preview.current = asImage({
      imageType: "image/svg+xml",
      binary: false,
      content: '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>',
    });
    openPath.current = "logo.svg";
    const { container } = render(<ShellFilesDock />);
    await act(async () => {});

    const eye = () =>
      [...container.querySelectorAll("button")].find((b) =>
        ["Show SVG source", "Show rendered SVG"].includes(b.getAttribute("title") ?? ""),
      ) as HTMLButtonElement;

    // Rendered: pressed, and the title offers the other view.
    expect(eye().getAttribute("aria-pressed")).toBe("true");
    expect(eye().getAttribute("title")).toBe("Show SVG source");
    expect(imgEl(container)).not.toBeNull();

    await act(async () => eye().click());
    expect(eye().getAttribute("aria-pressed")).toBe("false");
    expect(eye().getAttribute("title")).toBe("Show rendered SVG");

    // …and back again, so the toggle is not one-way.
    await act(async () => eye().click());
    expect(eye().getAttribute("aria-pressed")).toBe("true");
    expect(imgEl(container)).not.toBeNull();
  });

  it("flips an SVG to its source and back", async () => {
    const src = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    preview.current = asImage({ imageType: "image/svg+xml", binary: false, content: src });
    openPath.current = "logo.svg";
    const { container } = render(<ShellFilesDock />);
    await act(async () => {});

    const toggle = [...container.querySelectorAll("button")].find(
      (b) => b.getAttribute("title") === "Show SVG source",
    );
    expect(toggle).toBeTruthy();

    await act(async () => {
      toggle!.click();
    });
    // Source view: the image is gone and the markup is visible as characters,
    // which is what the source view is for. That it is never PARSED is pinned by
    // the hostile-payload test above; re-asserting DOM shape here would only trip
    // over the header's lucide icons, which carry <rect>/<path> of their own.
    expect(imgEl(container)).toBeNull();
    expect(container.textContent).toContain("<rect/>");
  });

  it("does NOT offer a source toggle for a raster (there is no source)", async () => {
    preview.current = asImage();
    openPath.current = "a.png";
    const { container } = render(<ShellFilesDock />);
    await act(async () => {});

    const titles = [...container.querySelectorAll("button")].map((b) => b.getAttribute("title"));
    expect(titles).not.toContain("Show SVG source");
    expect(titles).not.toContain("Show rendered SVG");
    expect(titles).toContain("Zoom in");
  });

  it("exposes zoom controls, with zoom-out and fit disabled at rest", async () => {
    preview.current = asImage();
    openPath.current = "a.png";
    const { container } = render(<ShellFilesDock />);
    await act(async () => {});

    const byTitle = (t: string) =>
      [...container.querySelectorAll("button")].find((b) => b.getAttribute("title") === t) as HTMLButtonElement;
    expect(byTitle("Zoom out").disabled).toBe(true); // already at 100%
    expect(byTitle("Fit to pane").disabled).toBe(true);
    expect(byTitle("Zoom in").disabled).toBe(false);
    expect(container.textContent).toMatch(/100%/);

    await act(async () => {
      byTitle("Zoom in").click();
    });
    expect(container.textContent).toMatch(/140%/);
    expect(byTitle("Zoom out").disabled).toBe(false);
    expect(byTitle("Fit to pane").disabled).toBe(false);
  });

  it("resets zoom when a different image is opened", async () => {
    preview.current = asImage();
    openPath.current = "a.png";
    const { container, rerender } = render(<ShellFilesDock />);
    await act(async () => {});
    const byTitle = (t: string) =>
      [...container.querySelectorAll("button")].find((b) => b.getAttribute("title") === t) as HTMLButtonElement;

    await act(async () => {
      byTitle("Zoom in").click();
    });
    expect(container.textContent).toMatch(/140%/);

    openPath.current = "b.png";
    await act(async () => {
      rerender(<ShellFilesDock />);
    });
    expect(container.textContent).toMatch(/100%/);
  });
});
