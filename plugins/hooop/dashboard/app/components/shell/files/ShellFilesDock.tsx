"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, AtSign, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Eye, FileText, Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import { cn } from "../../ui/cn";
import { Markdown } from "../../Markdown";
import { useFilesUI } from "@/app/context/FilesUIProvider";
import { useSelectedCwd } from "@/app/context/useSelectedCwd";
import { useComposerInsert } from "@/app/context/ComposerInsertProvider";
import { useAdjacentFiles, useFilePreview } from "./useSessionFiles";
import { highlightLine, highlightToLines, langFromPath } from "./highlight";
import { useImagePanZoom } from "./useImagePanZoom";
import { useResizableDock } from "../useResizableDock";
import type { DiffHunk } from "./types";

// Docked file-preview column — shares ShellPlanDock's resize/localStorage (via
// useResizableDock) so it sits in the same slot between the chat frame and the
// right rail. Renders a full-file unified diff (with change-block navigation)
// for changed files, a rendered/raw toggle for markdown, and plain numbered
// lines otherwise. Any line click inserts an `@path:line` reference into the
// composer. Syntax highlighting for both diff and plain views lives in
// ./highlight (highlight.js, matching the Markdown code block).

// Must match PREVIEW_MAX_BYTES in the sandbox (lib/files.ts) — used only for
// the truncation banner copy.
const PREVIEW_CAP = 512 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function ShellFilesDock() {
  const { file, closeFile, openFile } = useFilesUI();
  const cwd = useSelectedCwd();
  const { insertReference, canInsert } = useComposerInsert();
  const { data: preview, loading, error } = useFilePreview(file?.path ?? null);
  const { prev, next } = useAdjacentFiles(file?.path ?? null);

  const { width, dragging, asideRef, onPointerDown } = useResizableDock("hooop-file-preview-dock-width");
  const [entered, setEntered] = useState(false);
  const [mdRendered, setMdRendered] = useState(false);
  // Defaults TRUE: an SVG opens as a picture. Named for the Eye's "on" view so
  // `aria-pressed` matches mdRendered's polarity — lit means the visual view is
  // showing, in both cases. Tracking the inverse ("source") lit the button only
  // while looking at markup, which reads as the Eye being off while the image is up.
  const [svgRendered, setSvgRendered] = useState(true);

  useEffect(() => {
    const id = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Reset the markdown toggle whenever the previewed file changes.
  useEffect(() => setMdRendered(false), [file?.path]);
  // SVG is the mirror image of markdown: it renders by default (an image is what
  // you want to see) and the same Eye button flips to the markup — which for a
  // changed SVG is its diff, so the toggle is how you review one.
  useEffect(() => setSvgRendered(true), [file?.path]);

  const insertLine = useCallback((line: number) => insertReference(`@${file?.path}:${line}`), [file?.path, insertReference]);

  const goToAdjacent = useCallback(
    (target: { path: string; name: string } | null) => {
      if (!target || !file) return;
      openFile({ sessionId: file.sessionId, path: target.path, name: target.name });
    },
    [file, openFile],
  );

  // Language for syntax highlighting, keyed off the path's extension.
  const lang = useMemo(() => langFromPath(file?.path ?? ""), [file?.path]);

  if (!file) return null;

  const diff = preview?.diff ?? null;
  // Bytes come from their own cacheable URL rather than the preview payload.
  // `v` is the file's mtime: unchanged image → identical URL → the browser
  // serves it from cache and an unrelated write in the cwd costs no transfer,
  // while a real edit changes the URL and refetches. Encoded per-param since a
  // path can contain anything a filesystem allows.
  const rawUrl = `/api/files/raw?cwd=${encodeURIComponent(cwd ?? "")}&path=${encodeURIComponent(file.path)}&v=${preview?.mtimeMs ?? 0}`;
  // Only an SVG has a source to fall back to; a raster's Eye button would toggle
  // to a "binary file" message, so it isn't offered.
  const canToggleSvgSource = !!preview?.isImage && preview.imageType === "image/svg+xml";

  return (
    <aside
      ref={asideRef}
      style={{ width: entered ? width : 0 }}
      className={cn(
        "relative shrink-0 flex flex-col min-h-0 overflow-hidden bg-window",
        "border-divider lg:border-l",
        // On phones this is a full-screen overlay. It must sit ABOVE the mobile
        // Details/Files overlay (z-70) so opening a file from that list drills
        // down on top of it; closing the preview returns to the list beneath.
        "max-lg:fixed max-lg:inset-0 max-lg:z-[80] max-lg:!w-full",
        !dragging && "motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-smooth",
      )}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize file preview"
        onPointerDown={onPointerDown}
        className="group absolute inset-y-0 left-0 z-30 w-1.5 -translate-x-1/2 cursor-col-resize max-lg:hidden"
      >
        <div
          className={cn(
            "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent transition-colors",
            "group-hover:bg-accent",
            dragging && "bg-accent",
          )}
        />
      </div>

      {/* header: name + path, then icon-only actions */}
      <div className="shrink-0 flex items-center gap-2 px-3 h-14 border-b border-divider">
        <FileText className="w-4 h-4 shrink-0 text-ink-mute" />
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium text-ink truncate leading-tight">{file.name}</div>
          {/* `path` is basename-relative, so a root-level file makes path === name —
            * skip the redundant line instead of rendering the same text twice. */}
          {file.path !== file.name && (
            <div className="font-mono text-[10px] text-ink-faint truncate leading-tight mt-0.5">{file.path}</div>
          )}
        </div>
        {/* Rendered-markdown toggle. Offered whenever there's current source to
          * render — including changed/added files (they carry `content`
          * alongside the diff). Removed files have no on-disk content, so the
          * toggle is hidden there. */}
        {preview?.isMarkdown && preview.content != null && (
          <button
            className={cn("icon-btn w-8 h-8", mdRendered && "text-accent bg-accent/[0.15] hover:bg-accent/[0.15]")}
            title={mdRendered ? "Show source" : "Show rendered markdown"}
            aria-pressed={mdRendered}
            onClick={() => setMdRendered((v) => !v)}
          >
            <Eye className="w-4 h-4" />
          </button>
        )}
        {/* Same Eye affordance as markdown, inverted: an SVG renders by default,
          * so this reveals the markup (and, for a changed SVG, its diff — which
          * is the only way to review one). Raster images have no source to show,
          * hence canToggleSvgSource rather than isImage. */}
        {canToggleSvgSource && (
          <button
            className={cn("icon-btn w-8 h-8", svgRendered && "text-accent bg-accent/[0.15] hover:bg-accent/[0.15]")}
            title={svgRendered ? "Show SVG source" : "Show rendered SVG"}
            aria-pressed={svgRendered}
            onClick={() => setSvgRendered((v) => !v)}
          >
            <Eye className="w-4 h-4" />
          </button>
        )}
        {/* Copies the file's current raw content, not the path (the path is
          * already shown as text right above) — only offered when there's
          * text content to copy, i.e. never for binaries. */}
        {!preview?.binary && preview?.content != null && (
          <button className="icon-btn w-8 h-8" title="Copy file contents" onClick={() => void navigator.clipboard?.writeText(preview.content ?? "")}>
            <Copy className="w-4 h-4" />
          </button>
        )}
        {/* Insert-as-reference is hidden for spectate-only peers (view-only). */}
        {canInsert && (
          <button
            className="icon-btn w-8 h-8 text-sdk hover:bg-sdk/[0.16]"
            title="Insert as @reference"
            onClick={() => insertReference(`@${file.path}`)}
          >
            <AtSign className="w-4 h-4" />
          </button>
        )}
        <button className="icon-btn w-8 h-8" title="Close" onClick={closeFile}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {loading && !preview ? (
        <div className="flex-1 grid place-items-center text-[12px] text-ink-faint">Loading…</div>
      ) : error ? (
        <div className="flex-1 grid place-items-center px-6 text-center text-[12px] text-fail">
          Couldn&apos;t load this file: {error}
        </div>
      ) : preview?.imageTooLarge ? (
        <div className="flex-1 grid place-items-center px-6 text-center text-[12px] text-ink-faint">
          Image is {formatBytes(preview.sizeBytes ?? 0)} — too large to preview.
        </div>
      ) : /* An image beats the binary branch below (which is where every raster
            used to land) and, for SVG, beats the source/diff views — unless the
            Eye toggle asks for the source. */
      preview?.isImage && !(preview.isMarkdown && mdRendered) && svgRendered ? (
        <ImageBody
          src={rawUrl}
          path={file.path}
          mediaType={preview.imageType ?? ""}
          sizeBytes={preview.sizeBytes ?? 0}
        />
      ) : preview?.binary ? (
        <div className="flex-1 grid place-items-center px-6 text-center text-[12px] text-ink-faint">
          Binary file — {formatBytes(preview.sizeBytes ?? 0)}. Preview isn&apos;t available.
        </div>
      ) : (
        <>
          {(preview?.truncated || preview?.diffTooLarge) && (
            <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 text-[11px] text-live bg-live/[0.12] border-b border-live/25">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>
                {preview?.diffTooLarge
                  ? "Diff is too large to render — showing the current file below."
                  : `Large file — showing the first ${formatBytes(PREVIEW_CAP)} of ${formatBytes(preview?.sizeBytes ?? 0)}.`}
              </span>
            </div>
          )}
          {/* Rendered markdown wins over the diff/plain views when toggled, so
            * the eye works on changed/added markdown too (not just unchanged). */}
          {preview?.isMarkdown && mdRendered && preview.content != null ? (
            <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3 text-[13px] leading-relaxed">
              <Markdown source={preview.content} />
            </div>
          ) : diff ? (
            <DiffBody
              key={file.path}
              hunks={diff.hunks}
              adds={diff.adds}
              dels={diff.dels}
              lang={lang}
              onLine={canInsert ? insertLine : undefined}
              onPrevFile={prev ? () => goToAdjacent(prev) : undefined}
              onNextFile={next ? () => goToAdjacent(next) : undefined}
            />
          ) : (
            <PlainBody text={preview?.content ?? ""} lang={lang} onLine={canInsert ? insertLine : undefined} />
          )}
        </>
      )}
    </aside>
  );
}

// ── Image view with zoom + pan ───────────────────────────────────────────────
//
// SVG renders through <img src> exactly like a raster, and that is a security
// decision rather than a convenience: inlining the markup
// (dangerouslySetInnerHTML) would execute <script>, onload= and <foreignObject>
// in the dashboard's origin with the session cookie attached, and preview
// content is attacker-influenced — any cloned repo, anything the agent writes.
// Loaded as an image, browsers refuse to run script inside SVG. This matches
// Markdown.tsx, which escapes raw HTML rather than injecting it.
function ImageBody({
  src,
  path,
  mediaType,
  sizeBytes,
}: {
  src: string;
  /** Resets zoom/pan when another image is opened. */
  path: string;
  mediaType: string;
  sizeBytes: number;
}) {
  const { scale, offset, panning, isFit, zoomIn, zoomOut, reset, onWheel, onPointerDown, viewportRef } =
    useImagePanZoom(path);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);

  // A new file means a new load; without this a previously-failed image would
  // keep its error state after switching to a good one.
  useEffect(() => {
    setNatural(null);
    setFailed(false);
  }, [src]);

  if (failed) {
    return (
      <div className="flex-1 grid place-items-center px-6 text-center text-[12px] text-ink-faint">
        Couldn&apos;t decode this image ({mediaType || "unknown type"}).
      </div>
    );
  }

  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-divider bg-sunken">
        <span className="font-mono text-[11px] text-ink-mute">
          {natural ? `${natural.w}×${natural.h}` : "—"} · {formatBytes(sizeBytes)}
        </span>
        <span className="text-ink-faint text-[11px]">·</span>
        <span className="font-mono text-[11px] text-ink-mute tabular-nums">{Math.round(scale * 100)}%</span>
        <div className="ml-auto flex items-center gap-1">
          <button className="icon-btn w-7 h-7" title="Zoom out" onClick={zoomOut} disabled={scale <= 1}>
            <ZoomOut className="w-4 h-4" />
          </button>
          <button className="icon-btn w-7 h-7" title="Zoom in" onClick={zoomIn} disabled={scale >= 8}>
            <ZoomIn className="w-4 h-4" />
          </button>
          <button className="icon-btn w-7 h-7" title="Fit to pane" onClick={reset} disabled={isFit}>
            <Maximize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
      {/* `overflow-hidden`, not `auto`: panning is the transform below, so a
        * scrollbar would fight it. The checkerboard makes transparency legible
        * instead of guessing against the pane background. */}
      <div
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        className={cn(
          "relative flex-1 min-h-0 overflow-hidden grid place-items-center",
          scale > 1 && (panning ? "cursor-grabbing" : "cursor-grab"),
        )}
        style={{
          backgroundImage:
            "linear-gradient(45deg, rgb(128 128 128 / 0.14) 25%, transparent 25%, transparent 75%, rgb(128 128 128 / 0.14) 75%), " +
            "linear-gradient(45deg, rgb(128 128 128 / 0.14) 25%, transparent 25%, transparent 75%, rgb(128 128 128 / 0.14) 75%)",
          backgroundSize: "16px 16px",
          backgroundPosition: "0 0, 8px 8px",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- a session file
          * served by our own route, not a build-time asset next/image can optimise */}
        <img
          src={src}
          alt={path}
          draggable={false}
          onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
          onError={() => setFailed(true)}
          className="max-w-full max-h-full object-contain select-none"
          style={{
            transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            // Transitioning the transform would lag the pointer during a pan.
            transition: panning ? "none" : "transform 120ms ease-out",
            // Keep hard pixel edges when zoomed well past 1:1 — a magnified
            // screenshot or icon should read as pixels, not as a blur.
            imageRendering: scale >= 3 ? "pixelated" : "auto",
          }}
        />
      </div>
    </>
  );
}

// ── Diff view with hunk navigation ───────────────────────────────────────────
function DiffBody({
  hunks,
  adds,
  dels,
  lang,
  onLine,
  onPrevFile,
  onNextFile,
}: {
  hunks: DiffHunk[];
  adds: number;
  dels: number;
  /** highlight.js language id (from the file extension), or null for plain. */
  lang: string | null;
  /** When omitted (spectate-only peers), lines aren't clickable for referencing. */
  onLine?: (line: number) => void;
  /** Prev/next FILE within the affected-files queue (added, changed, or
   * removed — see useAdjacentFiles/useAffectedFiles). Undefined at either end
   * of the queue, which disables that button; only ever rendered here (not
   * PlainBody) since affected files are exactly the ones that carry a diff,
   * which is exactly the queue this pages through. */
  onPrevFile?: () => void;
  onNextFile?: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef<(HTMLDivElement | null)[]>([]);
  const [current, setCurrent] = useState(0);
  const clickable = !!onLine;

  // The backend sends the whole file as one full-context hunk; flatten to a
  // single contiguous line list so gutter numbers and scrolling line up.
  const lines = useMemo(() => hunks.flatMap((h) => h.lines), [hunks]);

  // Change blocks = maximal runs of +/- lines. Navigation jumps between these
  // (not git hunks — there's now a single hunk spanning the whole file).
  const blocks = useMemo(() => {
    const starts: number[] = [];
    let prevChanged = false;
    lines.forEach((l, i) => {
      const changed = l.sign !== " ";
      if (changed && !prevChanged) starts.push(i);
      prevChanged = changed;
    });
    return starts;
  }, [lines]);

  const goto = useCallback(
    (i: number) => {
      if (!blocks.length) return;
      const clamped = Math.max(0, Math.min(blocks.length - 1, i));
      setCurrent(clamped);
      const el = rowRefs.current[blocks[clamped]];
      const body = bodyRef.current;
      if (el && body) body.scrollTo({ top: el.offsetTop - 8, behavior: "smooth" });
    },
    [blocks],
  );

  // On open, jump to the first change so it's visible even when it sits far
  // down an otherwise-unchanged file (the untouched head is still above it).
  //
  // ONCE per open, which the ref enforces. `blocks` is a fresh array on every
  // live refresh of this file — new identity even for byte-identical content —
  // so keying the effect on it alone re-ran this on each refresh and yanked the
  // reader back to the first change mid-read. The dependency stays because
  // `blocks` is empty on the first render or two (the fetch hasn't landed), and
  // the effect has to get a chance to fire once it isn't; the guard is what
  // makes the FIRST non-empty run the only one. Scoped to the instance, and the
  // parent keys this `key={file.path}`, so opening another file remounts and
  // jumps again as intended.
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (jumpedRef.current || !blocks.length) return;
    jumpedRef.current = true;
    const id = requestAnimationFrame(() => {
      const el = rowRefs.current[blocks[0]];
      const body = bodyRef.current;
      if (el && body) body.scrollTo({ top: el.offsetTop - 8 });
    });
    return () => cancelAnimationFrame(id);
  }, [blocks]);

  return (
    <>
      <div className="shrink-0 flex items-center gap-2 px-3 h-9 border-b border-divider bg-sunken">
        <span className="font-mono text-[11px]">
          <span className="text-wrap">+{adds}</span> <span className="text-fail">−{dels}</span>
        </span>
        <span className="text-ink-faint text-[11px]">·</span>
        <span className="text-[11px] text-ink-mute font-mono">
          change {blocks.length ? current + 1 : 0}/{blocks.length}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {/* File-level nav (horizontal chevrons) is a distinct axis from the
            * change-block nav (vertical chevrons) right next to it — a small
            * divider keeps the two from reading as one control. */}
          <button className="icon-btn w-7 h-7" title="Previous file" onClick={onPrevFile} disabled={!onPrevFile}>
            <ChevronLeft className="w-4 h-4" />
          </button>
          <button className="icon-btn w-7 h-7" title="Next file" onClick={onNextFile} disabled={!onNextFile}>
            <ChevronRight className="w-4 h-4" />
          </button>
          <span className="w-px h-4 bg-divider mx-1" />
          <button className="icon-btn w-7 h-7" title="Previous change" onClick={() => goto(current - 1)} disabled={current <= 0}>
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            className="icon-btn w-7 h-7"
            title="Next change"
            onClick={() => goto(current + 1)}
            disabled={current >= blocks.length - 1}
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>
      </div>
      {/* `relative` makes this the offsetParent for the row divs below — without
        * it, offsetTop resolves against the outer `aside` (the nearest
        * positioned ancestor), which is taller than this scroll container by
        * the header + hunk-nav bar heights, so goto()'s scrollTo() overshoots
        * and can scroll the target line clean out of view. */}
      <div ref={bodyRef} className="relative flex-1 min-h-0 overflow-auto font-mono text-[12px] leading-[1.5]">
        {lines.map((l, i) => {
          const line = l.newNo ?? l.oldNo;
          return (
            <div
              key={i}
              ref={(el) => {
                rowRefs.current[i] = el;
              }}
              onClick={clickable && line != null ? () => onLine!(line) : undefined}
              className={cn(
                "group relative flex items-stretch",
                clickable && "cursor-pointer hover:bg-sdk/[0.12]",
                l.sign === "+" && "bg-wrap/[0.09]",
                l.sign === "-" && "bg-fail/[0.09]",
              )}
              title={clickable && line != null ? `Insert @…:${line}` : undefined}
            >
              {clickable && (
                <span className="pointer-events-none absolute left-0.5 inset-y-0 flex items-center text-sdk font-bold text-[11px] opacity-0 group-hover:opacity-100 select-none">
                  @
                </span>
              )}
              <span className="w-9 shrink-0 px-1 text-right text-ink-hush select-none tabular-nums">{l.oldNo ?? ""}</span>
              <span className="w-9 shrink-0 px-1 text-right text-ink-hush select-none tabular-nums border-r border-divider">{l.newNo ?? ""}</span>
              <span
                className={cn(
                  "w-4 shrink-0 text-center select-none",
                  l.sign === "+" && "text-wrap",
                  l.sign === "-" && "text-fail",
                  l.sign === " " && "text-ink-hush",
                )}
              >
                {l.sign === " " ? "" : l.sign}
              </span>
              <span
                className={cn(
                  "flex-1 whitespace-pre-wrap break-all pr-3",
                  l.sign === "+" ? "text-ink" : l.sign === "-" ? "text-ink-mute" : "text-ink-soft",
                )}
                dangerouslySetInnerHTML={{ __html: highlightLine(l.text, lang) || "\u00A0" }}
              />
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Plain numbered view ──────────────────────────────────────────────────────
function PlainBody({ text, lang, onLine }: { text: string; lang: string | null; onLine?: (line: number) => void }) {
  // Highlight the whole file once, then render one HTML fragment per line so
  // gutter numbers + click-to-reference still work. `hljs` sets the themed base
  // text color; token classes carry the github palette (both themes).
  const lines = useMemo(() => highlightToLines(text, lang), [text, lang]);
  const clickable = !!onLine;
  return (
    <div className="hljs flex-1 min-h-0 overflow-auto font-mono text-[12px] leading-[1.55]">
      {lines.map((html, i) => (
        <div
          key={i}
          onClick={clickable ? () => onLine!(i + 1) : undefined}
          className={cn(
            "group relative flex items-stretch",
            clickable && "cursor-pointer hover:bg-sdk/[0.12]",
          )}
          title={clickable ? `Insert @…:${i + 1}` : undefined}
        >
          {clickable && (
            <span className="pointer-events-none absolute left-0.5 inset-y-0 flex items-center text-sdk font-bold text-[11px] opacity-0 group-hover:opacity-100 select-none">
              @
            </span>
          )}
          <span className="w-10 shrink-0 px-2 text-right text-ink-hush select-none tabular-nums border-r border-divider">{i + 1}</span>
          <span className="flex-1 whitespace-pre-wrap break-all px-3" dangerouslySetInnerHTML={{ __html: html || "\u00A0" }} />
        </div>
      ))}
    </div>
  );
}
