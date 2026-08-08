"use client";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Check, ChevronDown, ChevronUp, ClipboardList, MessageSquare, MessageSquarePlus, Pencil, TriangleAlert, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { Avatar } from "./ui";
import { cn } from "./ui/cn";
import { usePlanComments } from "../context/hooks/usePlanComments";

export interface PlanPanelProps {
  sessionId: string;
  requestId: string;
  plan: string;
  sessionLabel: string;
  /** May this viewer approve/reject? Host + full-capability peers: true. A
   * drive/spectate peer reads the plan and comments but can't decide (the
   * sandbox also enforces this). Defaults to true so the host UI is unchanged. */
  canDecide?: boolean;
  /** May this viewer add comments/replies? Host + full/drive peers: true. A
   * spectate peer is view-only (the sandbox rejects their writes). Defaults to
   * true so the host UI is unchanged. */
  canComment?: boolean;
  error?: string | null;
  onApprove: () => Promise<void> | void;
  onReject: (feedback: string) => Promise<void> | void;
  onClose: () => void;
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// Initials for a comment/reply author avatar. Empty/unknown → "?".
function initialsOf(s: string | null | undefined): string {
  const parts = (s ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Clock time for a comment/reply ("10:24 AM"). Non-finite/zero → "" (hidden).
function fmtTime(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return "";
  try {
    return new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Stable per-author avatar tint from the shared cue palette, so each author
// keeps one color across their comments (mirrors the mockup's colored author
// avatars). Null author → neutral (Avatar's default elevated disc).
const AUTHOR_TONES = ["accent", "wrap", "sdk", "direct", "live"] as const;
function avatarTint(name: string | null | undefined): CSSProperties | undefined {
  if (!name) return undefined;
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const tone = AUTHOR_TONES[h % AUTHOR_TONES.length];
  return {
    background: `color-mix(in oklab, rgb(var(--${tone})) 22%, rgb(var(--elevated)))`,
    color: `rgb(var(--${tone}))`,
  };
}

// Text-index of a DOM position within `root` (concatenated text-node lengths).
function offsetOf(root: Node, node: Node, nodeOffset: number): number {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  while (w.nextNode()) {
    if (w.currentNode === node) return acc + nodeOffset;
    acc += (w.currentNode.textContent ?? "").length;
  }
  return acc;
}
// Inverse: a Range covering [offset, offset+length] of `root`'s text.
function rangeFromOffset(root: Node, offset: number, length: number): Range | null {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0, startNode: Node | null = null, startLocal = 0, endNode: Node | null = null, endLocal = 0;
  const end = offset + Math.max(1, length);
  while (w.nextNode()) {
    const n = w.currentNode;
    const len = (n.textContent ?? "").length;
    if (startNode === null && offset < acc + len) { startNode = n; startLocal = offset - acc; }
    if (startNode !== null && end <= acc + len) { endNode = n; endLocal = end - acc; break; }
    acc += len;
  }
  if (!startNode) return null;
  if (!endNode) { endNode = startNode; endLocal = (startNode.textContent ?? "").length; }
  try {
    const r = document.createRange();
    r.setStart(startNode, Math.max(0, startLocal));
    r.setEnd(endNode, Math.max(0, endLocal));
    return r;
  } catch { return null; }
}

/**
 * Plan-review slide-over. Comments are SHARED across the session (usePlanComments
 * polls the sandbox store), so every peer sees them live before anyone submits.
 * Select text → an "Add comment" button appears at the bottom → the comment
 * collapses to a chat bubble pinned where it was made (anchored by text offset,
 * so it lands correctly on each peer's layout). Bubbles/threads render above the
 * plan and stay clipped inside the scroll area. Only a comment's author can edit
 * or delete it. Request changes serializes the comments + note as feedback.
 */
export default function PlanPanel({ sessionId, requestId, plan, canDecide = true, canComment = true, error, onApprove, onReject, onClose }: PlanPanelProps) {
  const { comments, you, add, reply, edit, remove, error: commentsError } = usePlanComments(sessionId, requestId);
  const [note, setNote] = useState("");
  const [sel, setSel] = useState<{ quote: string; offset: number; length: number } | null>(null);
  const [composing, setComposing] = useState("");
  const [composerOpen, setComposerOpen] = useState(false); // require an explicit "Add comment" click
  const [openId, setOpenId] = useState<string | null>(null);
  const [replyDrafts, setReplyDrafts] = useState<Record<string, string>>({});
  // Bumped whenever the panel's width changes (it's now a user-resizable docked
  // column, not a fixed-width overlay) so pinned bubbles/highlights re-anchor to
  // the reflowed text instead of drifting.
  const [resizeTick, setResizeTick] = useState(0);
  const [submitting, setSubmitting] = useState<"approve" | "reject" | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null); // positioning context for bubbles
  const textRef = useRef<HTMLDivElement>(null); // plan text only (offset base)
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Persist the in-progress note draft in the browser, per plan (requestId), so
  // closing/reopening the panel doesn't lose it. Comments themselves are shared
  // server-side; this is just the local reviewer's own draft.
  const noteKey = `hooop-plan-note:${requestId}`;
  useEffect(() => {
    try { setNote(localStorage.getItem(noteKey) ?? ""); } catch { /* no storage */ }
  }, [noteKey]);
  useEffect(() => {
    try { if (note) localStorage.setItem(noteKey, note); else localStorage.removeItem(noteKey); } catch { /* no storage */ }
  }, [note, noteKey]);

  // Re-anchor pinned comments when the panel is resized (docked column) or the
  // viewport changes. anchorPos/anchorRects read `resizeTick`, so bumping it
  // recomputes their positions against the current layout.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setResizeTick((t) => t + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Capture a word selection so the bottom "Add comment" button can act on it,
  // even after the selection is cleared by clicking the button.
  function onTextMouseUp() {
    if (!canComment) return; // spectate peers read only — no selection-to-comment
    const s = window.getSelection();
    if (!s || s.isCollapsed || s.rangeCount === 0) return setSel(null);
    const text = s.toString().trim();
    const range = s.getRangeAt(0);
    if (!text || !textRef.current?.contains(range.commonAncestorContainer)) return setSel(null);
    if (!/[\p{L}\p{N}]{2,}/u.test(text)) return setSel(null); // need a real word
    const offset = offsetOf(textRef.current, range.startContainer, range.startOffset);
    setSel({ quote: text, offset, length: text.length });
    setComposerOpen(false); // require an explicit "Add comment" click first
  }

  function openComposer() {
    if (!sel) return;
    setComposing("");
    setComposerOpen(true);
    // Scroll the selection into view so the in-place composer is visible.
    const pos = anchorPos(sel.offset, sel.length);
    if (pos && scrollerRef.current) scrollerRef.current.scrollTop = Math.max(0, pos.top - 100);
  }
  function cancelComposer() {
    setComposerOpen(false);
    setComposing("");
    setSel(null);
  }

  // Content-relative position for a pinned bubble. Recomputed each render (and
  // on resize via resizeTick) so it tracks the current layout.
  function anchorPos(offset: number, length: number): { top: number; left: number } | null {
    void resizeTick;
    const wrap = wrapRef.current, txt = textRef.current;
    if (!wrap || !txt) return null;
    const r = rangeFromOffset(txt, offset, length);
    if (!r) return null;
    const rect = r.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    const wr = wrap.getBoundingClientRect();
    return { top: rect.top - wr.top, left: rect.right - wr.left };
  }

  // Per-line rects for a commented span, so we can paint a highlight marker over
  // the exact passage (a range can wrap across several lines → several rects).
  function anchorRects(offset: number, length: number): Array<{ top: number; left: number; width: number; height: number }> {
    void resizeTick;
    const wrap = wrapRef.current, txt = textRef.current;
    if (!wrap || !txt) return [];
    const r = rangeFromOffset(txt, offset, length);
    if (!r) return [];
    const wr = wrap.getBoundingClientRect();
    return Array.from(r.getClientRects())
      .map((rect) => ({ top: rect.top - wr.top, left: rect.left - wr.left, width: rect.width, height: rect.height }))
      .filter((x) => x.width > 0 && x.height > 0);
  }

  async function submitComment() {
    const body = composing.trim();
    if (!sel || !body) return;
    await add({ quote: sel.quote, offset: sel.offset, length: sel.length, body });
    setComposing("");
    setSel(null);
    setComposerOpen(false);
    window.getSelection()?.removeAllRanges();
  }

  const hasFeedback = comments.length > 0 || note.trim().length > 0;
  // A plan carrying unsent feedback can't be approved as-written — approve
  // means "proceed with exactly this plan", so any open comment OR an unsent
  // overall note (both of which Request changes serializes to the model, and
  // both of which approve silently drops) has to go back or be cleared first.
  // blockedByFeedback is the exact inverse of the Request-changes gate.
  const openComments = comments.length;
  const hasNote = note.trim().length > 0;
  const blockedByFeedback = hasFeedback;
  const blockedSubject = [
    openComments > 0 ? `${openComments} open comment${openComments === 1 ? "" : "s"}` : null,
    hasNote ? "an unsent note" : null,
  ]
    .filter(Boolean)
    .join(" and ");
  const blockedPronoun = openComments + (hasNote ? 1 : 0) === 1 ? "it" : "them";

  // A locating snippet for a comment: the commented span (wrapped in »«) with
  // ~70 chars of surrounding plan text on each side, so the model can pin the
  // comment to an exact passage instead of a bare word like "wants". Offsets
  // index the rendered plan text (textRef); fall back to searching for the
  // quote if they don't line up (e.g. a peer's offset on a different layout).
  function contextFor(c: { quote: string; offset: number; length: number }): string {
    const full = textRef.current?.textContent ?? "";
    if (!full) return "";
    let off = c.offset;
    let len = c.length;
    if (full.slice(off, off + len) !== c.quote) {
      const found = c.quote ? full.indexOf(c.quote) : -1;
      if (found >= 0) { off = found; len = c.quote.length; }
    }
    const WINDOW = 70;
    const start = Math.max(0, off - WINDOW);
    const end = Math.min(full.length, off + len + WINDOW);
    const norm = (s: string) => s.replace(/\s+/g, " ");
    const before = (start > 0 ? "…" : "") + norm(full.slice(start, off));
    const span = norm(full.slice(off, off + len));
    const after = norm(full.slice(off + len, end)) + (end < full.length ? "…" : "");
    return `${before}»${span}«${after}`.trim();
  }

  function serialize(): string {
    const parts: string[] = [];
    if (comments.length) {
      parts.push(
        "Please revise the plan based on these review comments. Each quotes the " +
          "plan passage it refers to, with the commented span marked »like this«:",
      );
      comments.forEach((c, i) => {
        const ctx = contextFor(c);
        const lines = [
          `${i + 1}. Passage: ${ctx || `"${truncate(c.quote, 160)}"`}`,
          `   Comment: ${c.body.trim()}`,
        ];
        c.replies.forEach((r) => lines.push(`   ↳ reply: ${r.body.trim()}`));
        parts.push(lines.join("\n"));
      });
    }
    if (note.trim()) parts.push((comments.length ? "Additional notes:\n" : "") + note.trim());
    return parts.join("\n\n");
  }

  async function approve() {
    // Open annotations block approval: "Approve" means "proceed with exactly
    // this plan", so an unresolved comment or unsent note must first be sent
    // back (Request changes) or cleared — never silently dropped on the way
    // through.
    if (submitting || hasFeedback) return;
    setSubmitting("approve");
    try { await onApprove(); } finally { setSubmitting(null); }
  }
  async function requestChanges() {
    if (submitting || !hasFeedback) return;
    setSubmitting("reject");
    try { await onReject(serialize()); } finally { setSubmitting(null); }
  }

  // Jump between comments (document order) — scroll the target into view and
  // open its thread.
  function navigate(dir: 1 | -1) {
    if (comments.length === 0) return;
    const ordered = [...comments].sort((a, b) => a.offset - b.offset);
    const curIdx = ordered.findIndex((c) => c.id === openId);
    const nextIdx = curIdx < 0 ? (dir > 0 ? 0 : ordered.length - 1) : (curIdx + dir + ordered.length) % ordered.length;
    const c = ordered[nextIdx];
    setOpenId(c.id);
    const pos = anchorPos(c.offset, c.length);
    if (pos && scrollerRef.current) scrollerRef.current.scrollTop = Math.max(0, pos.top - 80);
  }

  const cwWidth = wrapRef.current?.clientWidth ?? 600;
  const openComment = openId ? comments.find((c) => c.id === openId) : undefined;

  return (
    <div className="flex h-full w-full min-w-0 flex-col bg-window">
        {/* Header height matches the chat frame's session header (h-14) so the
            two column tops line up. */}
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-divider px-4">
          <h3 className="flex items-center gap-2 font-display text-[15px] font-semibold text-ink">
            <ClipboardList size={16} className="text-live" />
            Plan review
          </h3>
          <div className="ml-auto flex items-center gap-1.5">
            {comments.length > 0 && (
              <span className="flex shrink-0 items-center gap-0.5 text-xs text-ink-faint">
                <span>{comments.length} comment{comments.length === 1 ? "" : "s"}</span>
                <button
                  type="button"
                  onClick={() => navigate(-1)}
                  title="Previous comment"
                  className="rounded-control p-0.5 text-ink-mute hover:bg-elevated hover:text-ink"
                >
                  <ChevronUp size={13} />
                </button>
                <button
                  type="button"
                  onClick={() => navigate(1)}
                  title="Next comment"
                  className="rounded-control p-0.5 text-ink-mute hover:bg-elevated hover:text-ink"
                >
                  <ChevronDown size={13} />
                </button>
              </span>
            )}
            <button onClick={onClose} className="shrink-0 rounded-control p-0.5 text-ink-mute hover:bg-elevated hover:text-ink" aria-label="Close">
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Plan body + pinned comment bubbles (clipped to this scroll area) */}
        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
          <div ref={wrapRef} className="relative">
            <div
              ref={textRef}
              onMouseUp={onTextMouseUp}
              className="p-4 text-[13px] leading-relaxed text-ink-soft"
            >
              {plan.trim() ? <Markdown source={plan} /> : <p className="text-ink-faint">No plan content.</p>}
            </div>

            {/* Highlight the commented passage(s) under the text — subtle for
               every comment, stronger for the open one. Pointer-transparent so
               text selection still works. */}
            {comments.flatMap((c) =>
              anchorRects(c.offset, c.length).map((rc, i) => (
                <div
                  key={`${c.id}-hl-${i}`}
                  aria-hidden
                  style={{ position: "absolute", top: rc.top, left: rc.left, width: rc.width, height: rc.height }}
                  className={cn(
                    "pointer-events-none rounded-[3px] z-0",
                    openId === c.id ? "bg-live/30 ring-1 ring-live/40" : "bg-live/15",
                  )}
                />
              )),
            )}

            {comments.map((c) => {
              const pos = anchorPos(c.offset, c.length);
              if (!pos) return null;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setOpenId(openId === c.id ? null : c.id); }}
                  style={{ position: "absolute", top: pos.top, left: Math.min(pos.left, cwWidth - 24) }}
                  title={`${c.author ?? "someone"}: ${c.body}`}
                  className={`z-20 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-full border shadow-card ${
                    openId === c.id ? "border-live bg-live text-window" : "border-live/50 bg-live/15 text-live hover:bg-live/25"
                  }`}
                >
                  <MessageSquare size={11} />
                </button>
              );
            })}

            {/* "Add comment" trigger, pinned right below the highlighted selection. */}
            {sel && !composerOpen && (() => {
              const pos = anchorPos(sel.offset, sel.length);
              return (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={openComposer}
                  style={{ position: "absolute", top: (pos?.top ?? 8) + 14, left: Math.max(4, Math.min(pos?.left ?? 8, cwWidth - 140)) }}
                  className="z-30 flex items-center gap-1 rounded-control bg-live px-2.5 py-1 font-sans text-[11px] font-semibold text-window shadow-card hover:brightness-110"
                >
                  <MessageSquarePlus size={12} />
                  Add comment
                </button>
              );
            })()}

            {/* In-place comment composer, pinned on the selection like a bubble. */}
            {composerOpen && sel && (() => {
              const pos = anchorPos(sel.offset, sel.length);
              return (
                <div
                  style={{ position: "absolute", top: (pos?.top ?? 8) + 14, left: Math.max(4, Math.min(pos?.left ?? 8, cwWidth - 292)) }}
                  className="z-30 w-72 rounded-card border border-divider bg-elevated px-3 py-2.5 shadow-overlay"
                >
                  <div className="mb-1.5 flex items-center gap-1 truncate text-[10px] uppercase tracking-wide text-ink-faint">
                    <MessageSquarePlus size={11} className="text-live" />
                    comment on “{truncate(sel.quote, 60)}”
                  </div>
                  <textarea
                    autoFocus
                    rows={3}
                    value={composing}
                    onChange={(e) => setComposing(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void submitComment(); }
                      else if (e.key === "Escape") { e.preventDefault(); cancelComposer(); }
                    }}
                    placeholder="Comment…"
                    className="w-full resize-none rounded-control border border-divider bg-sunken px-2 py-1.5 font-sans text-[12px] leading-[1.5] text-ink placeholder:text-ink-hush focus:border-accent/60 focus:outline-none focus:ring-[3px] focus:ring-accent/20"
                  />
                  <div className="mt-1.5 flex items-center justify-end gap-2">
                    <button onClick={cancelComposer} className="px-2 py-1 font-sans text-[11px] font-semibold text-ink-faint hover:text-ink">Cancel</button>
                    <button onClick={() => void submitComment()} disabled={composing.trim().length === 0} className="rounded-control bg-accent px-2.5 py-1 font-sans text-[11px] font-semibold text-white hover:brightness-110 active:bg-accent-press disabled:opacity-40">Add comment</button>
                  </div>
                </div>
              );
            })()}

            {openComment && (() => {
              const pos = anchorPos(openComment.offset, openComment.length);
              const mine = openComment.author != null && openComment.author === you;
              return (
                <div
                  style={{ position: "absolute", top: (pos?.top ?? 8) + 14, left: Math.max(4, Math.min(pos?.left ?? 8, cwWidth - 292)) }}
                  className="z-30 w-72 rounded-card border border-divider bg-elevated px-3 py-2.5 shadow-overlay"
                >
                  {/* Header: author avatar + name + time, with a plain-text green
                      Resolve (author only) and a collapse ✕. */}
                  <div className="flex items-center gap-2">
                    <Avatar size="sm" initials={initialsOf(openComment.author)} style={avatarTint(openComment.author)} />
                    <div className="flex min-w-0 items-baseline gap-1.5">
                      <span className="truncate text-[12px] font-semibold text-ink">{openComment.author ?? "someone"}</span>
                      {fmtTime(openComment.at) && (
                        <span className="shrink-0 text-[11px] text-ink-mute">{fmtTime(openComment.at)}</span>
                      )}
                    </div>
                    <div className="ml-auto flex shrink-0 items-center gap-2">
                      {mine && (
                        <button onClick={() => { void remove(openComment.id); setOpenId(null); }} className="flex items-center gap-1 font-sans text-[11px] font-semibold text-wrap transition-[filter] hover:brightness-110" title="Resolve — clears this comment (only its author can)">
                          <Check size={12} />
                          Resolve
                        </button>
                      )}
                      <button onClick={() => setOpenId(null)} className="rounded-control p-0.5 text-ink-faint hover:bg-elevated-2 hover:text-ink" aria-label="Collapse">
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                  {mine ? (
                    <textarea
                      rows={2}
                      defaultValue={openComment.body}
                      onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== openComment.body) void edit(openComment.id, v); }}
                      className="mt-2 w-full resize-none rounded-control border border-divider bg-sunken px-2 py-1.5 font-sans text-[12px] leading-[1.5] text-ink focus:border-accent/60 focus:outline-none focus:ring-[3px] focus:ring-accent/20"
                    />
                  ) : (
                    <p className="mt-2 whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.5] text-ink-soft">{openComment.body}</p>
                  )}
                  {openComment.replies.length > 0 && (
                    <div className="mt-2.5 flex flex-col gap-2.5">
                      {openComment.replies.map((r) => (
                        <div key={r.id} className="flex items-start gap-2">
                          <Avatar initials={initialsOf(r.author)} style={avatarTint(r.author)} className="w-5 h-5 text-[9px]" />
                          <div className="min-w-0">
                            <div className="flex items-baseline gap-1.5">
                              <span className="truncate text-[11px] font-semibold text-ink">{r.author ?? "someone"}</span>
                              {fmtTime(r.at) && <span className="shrink-0 text-[10px] text-ink-mute">{fmtTime(r.at)}</span>}
                            </div>
                            <p className="whitespace-pre-wrap break-words font-sans text-[12px] leading-[1.5] text-ink-soft">{r.body}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  {canComment && (
                    <div className="mt-2.5 flex items-center gap-2">
                      <Avatar initials={initialsOf(you)} style={avatarTint(you)} className="w-5 h-5 text-[9px]" />
                      <input
                        value={replyDrafts[openComment.id] ?? ""}
                        onChange={(e) => setReplyDrafts((d) => ({ ...d, [openComment.id]: e.target.value }))}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            const v = e.currentTarget.value.trim();
                            if (v) { void reply(openComment.id, v); setReplyDrafts((d) => ({ ...d, [openComment.id]: "" })); }
                          }
                        }}
                        placeholder="Reply…"
                        className="min-w-0 flex-1 rounded-control border border-divider bg-sunken px-2.5 py-1.5 font-sans text-[12px] text-ink-soft placeholder:text-ink-hush focus:border-accent/60 focus:outline-none focus:ring-[3px] focus:ring-accent/20"
                      />
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Footer: overall note + decision (host / full peer), or a
            comment-only hint (drive peer — the host makes the call). */}
        <div className="border-t border-divider p-4">
          {(error || commentsError) && <p className="mb-2 font-mono text-[11px] text-fail">{error || commentsError}</p>}
          {canDecide ? (
            <>
              <textarea
                rows={2}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={comments.length ? "Overall note (optional)…" : "Select text in the plan to comment, or add an overall note…"}
                className="mb-2 w-full resize-none rounded-control border border-divider bg-sunken px-2 py-1.5 font-mono text-[12px] text-ink placeholder:text-ink-hush focus:border-accent/60 focus:outline-none focus:ring-[3px] focus:ring-accent/20"
              />
              {blockedByFeedback && (
                <div className="mb-2 flex items-start justify-center gap-2 rounded-control border border-live/30 bg-live/15 px-3 py-2 text-center text-[11px] text-live">
                  <TriangleAlert className="mt-px w-3.5 h-3.5 shrink-0" />
                  <span>
                    {blockedSubject} — approving sends the plan as-written, so send {blockedPronoun} back with <span className="font-semibold">Request changes</span> or clear {blockedPronoun} before you can approve.
                  </span>
                </div>
              )}
              {/* Footer actions mirror the mockup: a full-width split with a
                  green Approve (check) on the left and a ghost Request changes
                  (pencil) on the right. */}
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={approve}
                  disabled={submitting != null || blockedByFeedback}
                  title={blockedByFeedback ? `Clear or send ${blockedSubject} first — a plan can't be approved with unsent feedback.` : undefined}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-control bg-wrap px-3.5 py-[9px] text-[13px] font-semibold text-[#06130d] transition-[filter] hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Check size={15} />
                  {submitting === "approve" ? "approving…" : "Approve"}
                </button>
                <button
                  type="button"
                  onClick={requestChanges}
                  disabled={submitting != null || !hasFeedback}
                  title={hasFeedback ? undefined : "Add a comment or note to request changes"}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-control bg-elevated px-3.5 py-[9px] text-[13px] font-semibold text-ink-soft transition-colors hover:bg-elevated-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Pencil size={15} />
                  {submitting === "reject" ? "sending…" : "Request changes"}
                </button>
              </div>
            </>
          ) : canComment ? (
            <p className="font-sans text-[11px] text-ink-faint">
              Select text in the plan to leave a comment. The host approves or rejects this plan.
            </p>
          ) : (
            <p className="font-sans text-[11px] text-ink-faint">
              You’re viewing this plan read-only. The host approves or rejects it.
            </p>
          )}
        </div>
    </div>
  );
}
