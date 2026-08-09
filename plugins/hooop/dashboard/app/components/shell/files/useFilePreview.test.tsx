import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import { useEffect, useRef } from "react";
import type { FilePreviewData } from "./types";

// The Files navigator refreshes on EVERY write under the session cwd — the
// sandbox's fs-change event carries no path list — so an open preview refetches
// constantly, almost always because some other file changed. These tests pin
// what the reader sees across those refetches: the preview must hold still, and
// only a genuinely different file may blank the pane.

let cwd: string | null = "/workspace";
let filesNonce = 0;

vi.mock("@/app/context/useSelectedCwd", () => ({ useSelectedCwd: () => cwd }));
vi.mock("@/app/context/FilesUIProvider", () => ({ useFilesUI: () => ({ filesNonce }) }));

import { useFilePreview, type FilePreviewState } from "./useSessionFiles";

const preview = (over: Partial<FilePreviewData> = {}): FilePreviewData => ({
  status: null,
  isMarkdown: false,
  diff: null,
  content: "line one\nline two\n",
  truncated: false,
  sizeBytes: 18,
  binary: false,
  diffTooLarge: false,
  ...over,
});

/** Queue of responses, one per fetch, in call order. `"fail"` answers 500. */
const FAIL = "fail" as const;
let responses: Array<FilePreviewData | typeof FAIL> = [];
let fetchCalls: string[] = [];

/** Every state object the hook has returned, in render order — so a test can
 * assert not just the final value but that no `null` was ever rendered in
 * between (the flicker), and that an unchanged payload re-rendered nothing. */
let seen: FilePreviewState[] = [];

function Probe({ path }: { path: string | null }) {
  const state = useFilePreview(path);
  const last = useRef<FilePreviewState | null>(null);
  useEffect(() => {
    if (last.current !== state) {
      last.current = state;
      seen.push(state);
    }
  });
  return null;
}

beforeEach(() => {
  cwd = "/workspace";
  filesNonce = 0;
  responses = [];
  fetchCalls = [];
  seen = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      fetchCalls.push(url);
      const next = responses.shift();
      if (next === FAIL) return Promise.resolve({ ok: false, status: 500 });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(next) });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Flush the fetch promise chain. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Bump the fs-change nonce the way FilesUIProvider's SSE handler does. */
async function fsChange(rerender: () => void) {
  filesNonce += 1;
  await act(async () => {
    rerender();
  });
  await settle();
}

/** Every state committed since `mark`. Assertions go against this slice rather
 * than `seen.at(-1)`: an async `act` flushes the fetch too, so the tip is the
 * settled state and an intermediate blank would go unnoticed there — which is
 * precisely the flicker under test. */
function since(mark: number): FilePreviewState[] {
  return seen.slice(mark);
}

const isBlank = (s: FilePreviewState) => s.data === null;

describe("useFilePreview — live refresh must not disturb the reader", () => {
  it("keeps the rendered preview across a refetch that returns identical bytes", async () => {
    const same = preview();
    responses = [same, preview()]; // equal by value, distinct objects (a real fetch)
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();
    const afterLoad = seen.at(-1);
    expect(afterLoad?.data?.content).toBe("line one\nline two\n");
    const mark = seen.length;

    await fsChange(() => rerender(<Probe path="a.ts" />));

    expect(fetchCalls).toHaveLength(2); // it did revalidate…
    // …and committed no new state at all: same object, so React bails out and
    // not one line row re-renders.
    expect(since(mark)).toEqual([]);
    expect(seen.at(-1)).toBe(afterLoad);
  });

  it("never renders a null/loading gap when the file's content DID change", async () => {
    responses = [preview(), preview({ content: "line one\nline two\nline three\n" })];
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();
    const loadedAt = seen.length;

    await fsChange(() => rerender(<Probe path="a.ts" />));

    expect(seen.at(-1)?.data?.content).toBe("line one\nline two\nline three\n");
    // The flicker: every state emitted after the first load must carry data.
    // A `data: null` here is the body unmounting, taking its scroll with it.
    expect(seen.slice(loadedAt).every((s) => s.data !== null)).toBe(true);
    expect(seen.slice(loadedAt).some((s) => s.loading)).toBe(false);
  });

  it("notices an index-only change (same bytes, different diff)", async () => {
    // `git add` with no edit: content is byte-identical but the working-tree
    // diff moved, which is a real change the pane has to show.
    const withDiff = preview({
      status: "changed",
      diff: { kind: "modified", adds: 1, dels: 0, hunks: [{ header: "@@", lines: [{ sign: "+", oldNo: null, newNo: 1, text: "x" }] }] },
    });
    responses = [withDiff, preview({ status: null, diff: null })];
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();
    const afterLoad = seen.at(-1);

    await fsChange(() => rerender(<Probe path="a.ts" />));

    expect(seen.at(-1)).not.toBe(afterLoad);
    expect(seen.at(-1)?.data?.diff).toBeNull();
  });

  it("keeps the stale preview when a revalidation FAILS", async () => {
    // Mid-write reads can fail transiently; the next fs event retries. Swapping
    // a readable preview for an error banner would be strictly worse.
    responses = [preview(), FAIL];
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();

    await fsChange(() => rerender(<Probe path="a.ts" />));

    expect(seen.at(-1)?.data?.content).toBe("line one\nline two\n");
    expect(seen.at(-1)?.error).toBeNull();
  });

  it("surfaces the error when the FIRST load fails (nothing to fall back on)", async () => {
    responses = [FAIL];
    render(<Probe path="a.ts" />);
    await settle();
    expect(seen.at(-1)?.data).toBeNull();
    expect(seen.at(-1)?.error).toBe("preview 500");
  });

  it("reports a path that isn't on disk as notFound, not an empty file", async () => {
    // The transcript's clickable `#mention` chips can name any path somebody
    // typed, so a bad one has to say so — a blank pane under the right filename
    // reads as "this file exists and is empty".
    responses = [preview({ missing: true, content: null })];
    render(<Probe path="nope/missing.ts" />);
    await settle();
    expect(seen.at(-1)?.data).toBeNull();
    expect(seen.at(-1)?.notFound).toBe(true);
    // Its own state, NOT a generic load failure — the dock renders a different
    // empty state for each, so conflating them would lose that distinction.
    expect(seen.at(-1)?.error).toBeNull();
  });

  it("keeps a real load failure distinct from notFound", async () => {
    responses = [FAIL];
    render(<Probe path="a.ts" />);
    await settle();
    expect(seen.at(-1)?.error).toBe("preview 500");
    expect(seen.at(-1)?.notFound).toBe(false);
  });

  it("does NOT treat a genuinely empty file as missing", async () => {
    responses = [preview({ content: "", sizeBytes: 0 })];
    render(<Probe path="empty.txt" />);
    await settle();
    expect(seen.at(-1)?.error).toBeNull();
    expect(seen.at(-1)?.notFound).toBe(false);
    expect(seen.at(-1)?.data?.content).toBe("");
  });

  it("keeps the stale preview when a revalidation reports missing", async () => {
    // An atomic save (write-temp-then-rename) briefly unlinks the target. A
    // refetch landing in that window must not replace a good preview with
    // "doesn't exist" and flip back on the next fs event — same rule as a
    // failed revalidation above.
    responses = [preview(), preview({ missing: true, content: null })];
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();

    await fsChange(() => rerender(<Probe path="a.ts" />));

    expect(seen.at(-1)?.data?.content).toBe("line one\nline two\n");
    expect(seen.at(-1)?.error).toBeNull();
  });

  it("DOES blank the pane when a different file is opened", async () => {
    responses = [preview(), preview({ content: "other file\n" })];
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();
    const mark = seen.length;

    await act(async () => {
      rerender(<Probe path="b.ts" />);
    });
    await settle();
    // Blanks on the way, before b.ts lands — holding a.ts's content under
    // b.ts's header would be a lie, unlike holding it across a revalidation.
    expect(since(mark).some((s) => isBlank(s) && s.loading)).toBe(true);
    expect(seen.at(-1)?.data?.content).toBe("other file\n");
  });

  it("blanks the pane when the cwd changes under the same path", async () => {
    // Session switch: same relative path, different file entirely.
    responses = [preview(), preview({ content: "same path, other session\n" })];
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();
    const mark = seen.length;

    cwd = "/workspace/other";
    await act(async () => {
      rerender(<Probe path="a.ts" />);
    });
    await settle();
    expect(since(mark).some(isBlank)).toBe(true);
    expect(seen.at(-1)?.data?.content).toBe("same path, other session\n");
  });

  it("clears when the preview is closed, so reopening the same path is a fresh load", async () => {
    responses = [preview(), preview()];
    const { rerender } = render(<Probe path="a.ts" />);
    await settle();

    await act(async () => {
      rerender(<Probe path={null} />);
    });
    expect(seen.at(-1)?.data).toBeNull();
    const mark = seen.length;

    await act(async () => {
      rerender(<Probe path="a.ts" />);
    });
    await settle();
    // Not treated as a revalidation of what's on screen — there is nothing on
    // screen — so it loads from scratch rather than silently holding stale data.
    expect(since(mark).some((s) => isBlank(s) && s.loading)).toBe(true);
    expect(seen.at(-1)?.data?.content).toBe("line one\nline two\n");
  });
});
