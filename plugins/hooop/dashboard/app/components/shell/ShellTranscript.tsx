"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, Terminal, ArrowUp, ArrowDown, MessageCircle, CheckCircle2, PencilLine, AlertTriangle, Copy, Check, ChevronLeft, ChevronRight, X, HelpCircle, FoldVertical, Moon, MousePointerClick } from "lucide-react";
import type { EventRow } from "@/lib/sandbox-client";
import {
  userPromptText,
  assistantText,
  toolArgsText,
  toolResultText,
  bashShortcutData,
  systemText,
} from "../active-session/eventText";
import { Markdown } from "../Markdown";
import { cn } from "../ui/cn";
import { prettyToolName } from "../lib/format";
import { isHiddenTurnKind } from "@shared/turn-kinds";

// Center-pane transcript (Phase 3) — the signature surface. Mirrors the legacy
// Transcript's event classification (PreToolUse/PostToolUse pairing, dedup of
// resume-boundary Session events) but renders each item as the mockup's chat
// thread: host/peer bubbles right, assistant bubbles + sparkles avatar left,
// tool-call cards, bash-shortcut cards, and centered system notices. Reads the
// same event stream as the legacy panel via the provider — no data changes.

function clockTime(ts: string): string {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Sits beside the timestamp on assistant bubbles — icon-only and faint by
// default so it doesn't compete with the response, brightening only on hover.
function CopyResponseButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* Clipboard API unavailable (older browser / insecure context) — no fallback. */
    }
  };
  return (
    <button
      onClick={copy}
      title={copied ? "Copied!" : "Copy response"}
      aria-label="Copy response"
      className="rounded p-0.5 text-ink-faint hover:text-ink-soft hover:bg-elevated transition-colors"
    >
      {copied ? <Check className="w-2.5 h-2.5" /> : <Copy className="w-2.5 h-2.5" />}
    </button>
  );
}

// Who this viewer is, so bubble color can be *relative* to them (see isMine).
interface Viewer {
  kind: "host" | "peer";
  name: string;
}

// An event's attribution is the literal "host", a named guest, or null/absent —
// anything that isn't a named guest is the host.
function authorIsHost(row: EventRow): boolean {
  return !row.author || row.author === "host";
}

// Identity label for a turn's author — independent of who's viewing. The color
// (green/blue) encodes me-vs-them; this label always says WHO ("host" or the
// guest's name), so a multi-party session stays legible.
function authorLabel(row: EventRow): string {
  return authorIsHost(row) ? "host" : `${row.author} · peer`;
}

// Viewer-relative ownership: MY own turns render green (host bubble); everyone
// else — including the host when I'm a peer — renders blue (peer bubble). A
// host viewer's own turns are the host-authored ones; a peer viewer's own turns
// are those authored under their display name.
function isMine(row: EventRow, viewer: Viewer): boolean {
  return viewer.kind === "host" ? authorIsHost(row) : row.author === viewer.name;
}

function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="flex-1 h-px bg-divider" />
      <span className="font-mono text-[10px] uppercase tracking-widest text-ink-faint">{label}</span>
      <span className="flex-1 h-px bg-divider" />
    </div>
  );
}

// accent → the model (Sparkles); fail → a `!bash` command (Terminal `>_`);
// error → a failed turn / API error (AlertTriangle). `fail` is specifically the
// terminal glyph, so it must NOT be reused for non-bash failures.
function AssistantAvatar({ tone = "accent" }: { tone?: "accent" | "fail" | "error" }) {
  const Icon = tone === "error" ? AlertTriangle : tone === "fail" ? Terminal : Sparkles;
  return (
    <span
      className={cn(
        "avatar w-7 h-7 shrink-0 mt-0.5",
        tone === "accent" ? "avatar-accent" : "avatar-fail",
      )}
    >
      <Icon className="w-3.5 h-3.5" />
    </span>
  );
}

// Attached images in a message bubble. 1–3 render as free-flowing thumbnails.
// 4+ collapse into a 2×2 square grid: the first THREE corners show images and
// the bottom-right corner is a "+N" overflow badge (N = total − 3, the images
// not shown), laid over the next image as a dimmed backdrop. Any tile opens the
// session-wide lightbox at that image (the lightbox still carries every image,
// so the overflow ones are reachable by paging). `onOpenImage` omitted →
// non-interactive (standalone renders / tests).
type MessageImage = { media_type: string; data: string };
function MessageImages({
  images,
  rowId,
  onOpenImage,
}: {
  images: MessageImage[];
  rowId: number | string;
  onOpenImage?: (key: string) => void;
}) {
  const srcOf = (img: MessageImage) => `data:${img.media_type};base64,${img.data}`;

  // One clickable tile. `imgClass` shapes the thumbnail; `overlay` is the
  // bottom-right count badge in grid mode.
  const tile = (i: number, wrapClass: string, imgClass: string, overlay?: React.ReactNode) => {
    const el = (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={srcOf(images[i])} alt="attached image" className={imgClass} />
    );
    const common = "relative block overflow-hidden";
    return onOpenImage ? (
      <button
        key={i}
        type="button"
        onClick={() => onOpenImage(`${rowId}:${i}`)}
        aria-label="Open image"
        className={cn(
          common,
          wrapClass,
          "cursor-pointer transition hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        {el}
        {overlay}
      </button>
    ) : (
      <span key={i} className={cn(common, wrapClass)}>
        {el}
        {overlay}
      </span>
    );
  };

  if (images.length >= 4) {
    // Three image corners + a "+N" overflow badge in the fourth. N counts every
    // image past the three shown (the badge sits over image index 3 as a
    // backdrop, so opening it lands on the first hidden image).
    const overflow = images.length - 3;
    return (
      <div className="grid grid-cols-2 gap-1 w-full max-w-[16rem]">
        {[0, 1, 2, 3].map((i) =>
          tile(
            i,
            "rounded-md aspect-square",
            "h-full w-full object-cover",
            i === 3 ? (
              <span className="absolute inset-0 flex items-center justify-center bg-black/70 text-white font-semibold text-lg">
                +{overflow}
              </span>
            ) : undefined,
          ),
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-wrap gap-1.5">
      {images.map((_, i) =>
        tile(i, "rounded-lg", "max-h-48 max-w-[14rem] object-contain border border-bubble-ink/20"),
      )}
    </div>
  );
}

// Every row renderer is memoized on its (stable) EventRow. When a new event
// arrives the parent rebuilds the item list, but React reuses each prior item's
// element by key — memo keeps those from re-rendering, so old bubbles never
// re-parse Markdown just because a newer message came in.
const HostBubble = memo(function HostBubble({
  row,
  mine,
  chat = false,
  onOpenImage,
}: {
  row: EventRow;
  // `mine` drives color only: my own turns are green (host bubble), everyone
  // else is blue (peer bubble) — relative to the current viewer.
  mine: boolean;
  // A `chat` message (`>`) is broadcast to participants but never sent to the
  // model — a side conversation. Marked with a subtle chat glyph + a softer
  // bubble so it reads as aside chatter, not a turn the agent acts on.
  chat?: boolean;
  // Open the session-wide image lightbox at this image (keyed `${row.id}:${i}`).
  // Stable identity from the parent so memo isn't defeated. Omitted → thumbnails
  // are non-interactive (standalone renders / tests).
  onOpenImage?: (key: string) => void;
}) {
  const text = userPromptText(row);
  const images = Array.isArray(row.images) ? row.images : [];
  // Label + glyph tint track the AUTHOR identity (peer-authored → sdk), not the
  // viewer-relative color, so the "who" reading stays stable for everyone.
  const peerAuthored = !authorIsHost(row);
  const author = authorLabel(row);
  return (
    <div className="flex flex-col items-end gap-1" data-testid={chat ? undefined : "user-prompt"}>
      <div className="flex items-center gap-1.5 pr-1">
        {chat && (
          <MessageCircle
            className={cn("w-3 h-3 shrink-0", peerAuthored ? "text-sdk" : "text-ink-faint")}
            aria-label="chat"
          />
        )}
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide",
            peerAuthored ? "text-sdk" : "text-ink-faint",
          )}
        >
          {author}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
      </div>
      <div
        className={cn(
          "bubble px-3.5 py-2.5 text-[13px] leading-relaxed",
          mine ? "bubble-host" : "bubble-peer",
          // Subtle aside treatment for chat: a hairline inset ring + a touch of
          // transparency, distinct from a solid prompt bubble without shouting.
          chat && "ring-1 ring-inset ring-bubble-ink/15 opacity-95",
        )}
      >
        {text && (
          <div className="break-words">
            <Markdown source={text} fileChips />
          </div>
        )}
        {images.length > 0 && (
          <div className={cn(text && "mt-2")}>
            <MessageImages images={images} rowId={row.id} onOpenImage={onOpenImage} />
          </div>
        )}
      </div>
    </div>
  );
});

// The host's plan-review decision (approve / request-changes) is injected into
// the conversation as a user turn so the model acts on it — but in the
// transcript it isn't ordinary chat, it's a lifecycle event. The sandbox tags
// it via `kind` ("plan-approval" / "plan-rejection"); we render a centered
// notice instead of a host bubble so the history reads clearly. Approval shows
// just who approved; rejection also surfaces the feedback the model was given.
const REJECT_PREFIX = /^The plan was rejected\. Revise it based on this feedback:\s*/;

const PlanDecisionNotice = memo(function PlanDecisionNotice({
  row,
  variant,
}: {
  row: EventRow;
  variant: "approval" | "rejection";
}) {
  const approved = variant === "approval";
  const who = row.author && row.author !== "host" ? row.author : "host";
  const feedback = approved ? "" : userPromptText(row).replace(REJECT_PREFIX, "").trim();
  const Icon = approved ? CheckCircle2 : PencilLine;
  return (
    <div className="flex justify-center">
      <div
        className={cn(
          "inline-flex max-w-[85%] flex-col gap-1 rounded-xl px-3.5 py-2 text-[12px] ring-1 ring-inset",
          approved
            ? "bg-wrap/10 ring-wrap/30 text-wrap"
            : "bg-live/10 ring-live/30 text-live",
        )}
      >
        <div className="flex items-center gap-1.5 font-medium">
          <Icon className="w-3.5 h-3.5 shrink-0" />
          <span>{approved ? "Plan approved" : "Changes requested"}</span>
          <span className="text-ink-faint font-normal">· {who}</span>
          <span className="font-mono text-[10px] text-ink-faint font-normal">{clockTime(row.ts)}</span>
        </div>
        {!approved && feedback && (
          <div className="whitespace-pre-wrap break-words text-ink-soft">{feedback}</div>
        )}
      </div>
    </div>
  );
});

// An AskUserQuestion answered by the host/a peer. The picked options are relayed
// to the model as a follow-up turn, but in the transcript that turn is a hidden
// directive (see AGENT_DIRECTIVE_KIND) — this centered notice is what the history
// shows instead, so an answer reads as a lifecycle event ("Question answered by
// X" + the selections) rather than an ordinary peer chat message. The sandbox
// formats the relayed answer as `The user answered your question(s):\n- Q → A`;
// we strip that lead-in and render each `Q → A` as a labeled selection.
const QUESTION_ANSWER_PREFIX = /^The user answered your question\(s\):\s*/;

/**
 * The sweeper reclaimed something this session was holding — its preview, or its
 * share links — because the session went quiet.
 *
 * It reads as a system notice rather than a chat turn because that is what it is:
 * nobody said it. Without this branch it would render as a HostBubble, i.e. as
 * though the human had typed "Preview X was stopped…", which is worse than
 * saying nothing at all. Deliberately quiet (`ink-faint`, no cue colour): it
 * reports housekeeping, and none of the six DS cues mean "we tidied up".
 */
/**
 * Something that happened TO the session, which nobody typed.
 *
 * The sweeper reclaiming an idle preview, a share expiring, a viewer taking the
 * page out of the agent's hands. Centred and quiet, and deliberately not a chat
 * bubble: attributing it to whoever the request authenticated as would put words
 * in the mouth of somebody who never spoke.
 */
const LifecycleNotice = memo(function LifecycleNotice({ row }: { row: EventRow }) {
  // Idle reclaim is the session going to sleep; a takeover is a person reaching
  // in. Same shape, different cause, and the icon is the only thing that says so.
  const Icon = row.kind === "preview-taken-over" ? MousePointerClick : Moon;
  return (
    <div className="flex justify-center">
      <div className="inline-flex max-w-[85%] items-start gap-1.5 rounded-xl bg-sunken px-3.5 py-2 text-[12px] text-ink-mute ring-1 ring-inset ring-divider">
        <Icon className="mt-0.5 w-3.5 h-3.5 shrink-0 text-ink-faint" />
        <span className="break-words">{userPromptText(row)}</span>
        <span className="mt-0.5 shrink-0 font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
      </div>
    </div>
  );
});

const QuestionAnswerNotice = memo(function QuestionAnswerNotice({ row }: { row: EventRow }) {
  const who = row.author && row.author !== "host" ? row.author : "host";
  const body = userPromptText(row).replace(QUESTION_ANSWER_PREFIX, "").trim();
  // Each answer line is `- <question> → <picks>`; a plain reason (no bullet)
  // renders as a single answer with no question label.
  const items = body
    .split("\n")
    .map((l) => l.replace(/^[-•]\s*/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const sep = l.indexOf(" → ");
      return sep >= 0 ? { q: l.slice(0, sep).trim(), a: l.slice(sep + 3).trim() } : { q: "", a: l };
    });
  return (
    <div className="flex justify-center">
      <div className="inline-flex max-w-[85%] flex-col gap-1 rounded-xl px-3.5 py-2 text-[12px] ring-1 ring-inset bg-live/10 ring-live/30 text-live">
        <div className="flex items-center gap-1.5 font-medium">
          <HelpCircle className="w-3.5 h-3.5 shrink-0" />
          <span>Question answered</span>
          <span className="text-ink-faint font-normal">· {who}</span>
          <span className="font-mono text-[10px] text-ink-faint font-normal">{clockTime(row.ts)}</span>
        </div>
        {items.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {items.map((it, i) => (
              <div key={i} className="break-words text-ink-soft">
                {it.q && <span className="text-ink-faint">{it.q}: </span>}
                <span className="font-medium text-ink">{it.a}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// A slash-command turn (`/plan`, `/cost`, a plugin command, …). It IS a host
// action, so it stays right-aligned with the host label — but it's an
// instruction to the tooling, not conversational prose, so it renders as a
// compact accent-tinted monospace command line (slash glyph + command text)
// rather than an ordinary chat bubble. The sandbox tags these `kind="command"` and
// restores the original typed text (see writeUserTurn), so `/plan add caching`
// shows verbatim here even though the model only received "add caching".
const CommandCard = memo(function CommandCard({ row }: { row: EventRow }) {
  const text = userPromptText(row);
  // Split the command token (`/plan`) from its arguments so the token sits in
  // the accent badge and the args read as ordinary text beside it.
  const match = /^(\/\S+)\s*([\s\S]*)$/.exec(text.trim());
  const command = match ? match[1] : text.trim();
  const args = match ? match[2].trim() : "";
  const peerAuthored = !authorIsHost(row);
  const author = authorLabel(row);
  return (
    <div className="flex flex-col items-end gap-1" data-testid="command-turn">
      <div className="flex items-center gap-1.5 pr-1">
        <span
          className={cn(
            "text-[10px] uppercase tracking-wide",
            peerAuthored ? "text-sdk" : "text-ink-faint",
          )}
        >
          {author}
        </span>
        <span className="font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
      </div>
      <div className="flex items-center gap-2 rounded-xl px-3 py-2 font-mono text-[12px] ring-1 ring-inset ring-accent/30 bg-accent/[0.08] text-ink max-w-full">
        <span className="flex h-5 p-1 shrink-0 items-center justify-center rounded-md bg-accent/15 text-accent font-semibold leading-none">
          {command}
        </span>
        {args && <span className="break-all text-ink">{args}</span>}
      </div>
    </div>
  );
});

const AssistantBubble = memo(function AssistantBubble({ row }: { row: EventRow }) {
  const text = assistantText(row);
  return (
    <div className="flex items-start gap-2.5">
      <AssistantAvatar />
      <div className="min-w-0 flex flex-col gap-1.5">
        <div className="bubble bubble-assistant msg-wide px-3.5 py-3 text-[13px] leading-relaxed">
          <Markdown source={text} />
        </div>
        <div className="flex items-center gap-1 pl-1">
          <span className="font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
          {text && <CopyResponseButton text={text} />}
        </div>
      </div>
    </div>
  );
});

// An API failure surfaced by claude as a synthetic frame — a usage/rate limit,
// an overload, an auth failure. The sandbox tags these kind=error (distinct from
// the kind=info catch-all, which also carries benign notices like /cost output).
// Rendering it as an assistant bubble implied the model had answered; this reads
// as what it is — the turn failed, nothing was produced.
const ErrorNotice = memo(function ErrorNotice({ row }: { row: EventRow }) {
  const text = assistantText(row);
  return (
    <div className="flex items-start gap-2.5">
      <AssistantAvatar tone="error" />
      <div
        className="min-w-0 msg-wide rounded-2xl px-3.5 py-3 ring-1 ring-inset ring-fail/30"
        style={{ background: "color-mix(in oklab, rgb(var(--fail)) 10%, rgb(var(--elevated)))" }}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide font-semibold text-fail">
            turn failed
          </span>
          <span className="font-mono text-[10px] text-ink-faint">{clockTime(row.ts)}</span>
        </div>
        <p className="text-[13px] leading-relaxed text-ink-soft mt-1.5 whitespace-pre-wrap break-words">
          {text}
        </p>
      </div>
    </div>
  );
});

// Context compaction (`/compact`, or an automatic compaction) — a lifecycle
// event, NOT the model talking, so it renders as a centered notice like the
// plan/answer notices rather than as an assistant bubble.
//
// COLLAPSED BY DEFAULT, which is the point. The sandbox tags the row
// kind=compaction (active-sessions.ts) and its text is claude's replacement
// context: a full conversation summary with the harness's own continuation
// instructions appended ("Continue the conversation from where it left off …
// do not acknowledge the summary …"). That is prompt plumbing addressed to the
// model, and it used to fall through to <AssistantBubble> and render verbatim
// in the chat as if the model had said it. Keep it behind a toggle — still
// reachable for debugging, never chat content.
const CompactionNotice = memo(function CompactionNotice({ row }: { row: EventRow }) {
  const [expanded, setExpanded] = useState(false);
  const summary = assistantText(row).trim();
  return (
    <div className="flex justify-center">
      <div className="inline-flex max-w-[85%] flex-col gap-1 rounded-xl bg-elevated px-3.5 py-2 text-[12px] ring-1 ring-inset ring-divider">
        <div className="flex items-center gap-1.5 font-medium text-ink-mute">
          <FoldVertical className="w-3.5 h-3.5 shrink-0" />
          <span>Context compacted</span>
          <span className="font-mono text-[10px] text-ink-faint font-normal">{clockTime(row.ts)}</span>
          {summary && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="ml-1 text-[10px] font-normal text-ink-faint hover:text-ink-mute"
              aria-expanded={expanded}
            >
              {expanded ? "hide summary" : "show summary"}
            </button>
          )}
        </div>
        {expanded && summary && (
          <div className="whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-faint">
            {summary}
          </div>
        )}
      </div>
    </div>
  );
});

// A single tool call — the card only, WITHOUT the avatar/row wrapper. Rendered
// inside a ToolCluster so consecutive calls share one avatar and stack tightly.
const ToolCardBody = memo(function ToolCardBody({ pre, post }: { pre: EventRow; post?: EventRow }) {
  const [expanded, setExpanded] = useState(false);
  const toolName = pre.tool_name ?? "tool";
  const args = toolArgsText(pre);
  const result = post ? toolResultText(post) : null;
  const hasResult = result != null && result.length > 0;
  const LIMIT = 300;
  const long = hasResult && result!.length > LIMIT;
  const shown = long && !expanded ? result!.slice(0, LIMIT) : result;
  return (
    <div className="tool-card px-3 py-2 msg-wide">
      <div className="flex items-center gap-2 font-mono text-[11px]">
        <span className="shrink-0 text-wrap">●</span>
        <span
          className="shrink-0 truncate max-w-[60%] font-medium text-ink"
          title={toolName}
        >
          {prettyToolName(toolName)}
        </span>
        {args && (
          <span className="min-w-0 flex-1 truncate text-ink-faint" title={args}>
            {args}
          </span>
        )}
        <span className="ml-auto shrink-0 chip text-[9px] px-1.5 py-0.5 text-ink-faint">tool</span>
      </div>
      {hasResult && (
        <div className="mt-1.5 flex items-start gap-1.5 font-mono text-[11px] text-ink-faint">
          <span className="text-ink-hush">⎿</span>
          <div className="min-w-0 flex-1">
            <pre className="m-0 whitespace-pre-wrap break-words text-ink-faint">{shown}</pre>
            {long && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="mt-0.5 text-[10px] text-ink-faint hover:text-ink-mute"
              >
                {expanded ? "show less" : `show ${result!.length - LIMIT} more chars`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// Above this many calls, a cluster auto-collapses to a one-line summary so a
// tool-heavy turn doesn't dominate the frame.
const CLUSTER_COLLAPSE_ABOVE = 2;

// Rough token estimate for a collapsed cluster. Events carry no per-tool token
// count (see EventRow), so we approximate from the args+result character volume
// (~4 chars/token). Prefixed with `~` in the UI to signal it's an estimate.
function approxTokensOf(chars: number): number {
  return Math.ceil(chars / 4);
}
function formatApprox(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1) : Math.round(k)}k`;
}

// A run of consecutive agent tool calls, clustered under ONE assistant avatar
// with tight spacing — collapses the dead vertical space a turn's tool activity
// used to eat (one avatar + one gap per call). The cluster closes when the model
// emits a visible text turn; the next tool call opens a fresh one. Beyond
// CLUSTER_COLLAPSE_ABOVE calls it auto-collapses to a `N tool calls · ~T tokens`
// summary with a show-all toggle.
type ToolItem = { key: string; pre: EventRow; post?: EventRow };
const ToolCluster = memo(function ToolCluster({ tools }: { tools: ToolItem[] }) {
  // null = follow the auto rule (collapse when big); a boolean = the user's
  // explicit choice, which then sticks even as the cluster keeps streaming.
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const collapsible = tools.length > CLUSTER_COLLAPSE_ABOVE;
  const expanded = userExpanded ?? !collapsible;

  const approxTokens = useMemo(() => {
    let chars = 0;
    for (const t of tools) {
      chars += toolArgsText(t.pre).length;
      if (t.post) chars += toolResultText(t.post).length;
    }
    return approxTokensOf(chars);
  }, [tools]);

  return (
    <div className="flex items-start gap-2.5" data-testid="tool-cluster">
      <AssistantAvatar />
      <div className="min-w-0 flex flex-col gap-1">
        {expanded ? (
          <>
            {tools.map((t) => (
              <ToolCardBody key={t.key} pre={t.pre} post={t.post} />
            ))}
            {collapsible && (
              <button
                onClick={() => setUserExpanded(false)}
                className="self-start pl-1 text-[10px] text-ink-faint hover:text-ink-mute"
              >
                show less
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            onClick={() => setUserExpanded(true)}
            data-testid="tool-cluster-collapsed"
            title="Show all tool calls"
            className="tool-card px-3 py-2 msg-wide flex items-center gap-2 font-mono text-[11px] text-left hover:bg-elevated transition-colors"
          >
            <span className="shrink-0 text-wrap">●</span>
            <span className="text-ink-soft">{tools.length} tool calls</span>
            <span className="text-ink-faint">· ~{formatApprox(approxTokens)} tokens</span>
            <span className="ml-auto shrink-0 text-ink-faint hover:text-ink-mute">show all</span>
          </button>
        )}
      </div>
    </div>
  );
});

const BashCard = memo(function BashCard({ row }: { row: EventRow }) {
  const data = bashShortcutData(row);
  const command = data?.command ?? "";
  const running = data?.status === "running";
  const exitCode = data?.exitCode;
  const timedOut = data?.timedOut ?? false;
  const stdout = data?.stdout ?? "";
  const stderr = data?.stderr ?? "";
  const hasOutput = stdout.length > 0 || stderr.length > 0;
  const exitLabel = timedOut
    ? "timed out"
    : exitCode == null ? "" : exitCode === 0 ? "exit 0" : `exit ${exitCode}`;
  return (
    <div className="flex items-start gap-2.5">
      <AssistantAvatar tone="fail" />
      <div className="min-w-0 font-mono text-[11px] msg-wide rounded-xl px-3 py-2.5 bg-sunken border border-divider">
        <div className="flex items-baseline gap-1.5">
          <span aria-hidden className="text-fail">$</span>
          <span className="chip text-[9px] uppercase tracking-wide px-1.5 py-px shrink-0 text-ink-faint">
            host
          </span>
          <span className="truncate text-ink-soft">{command}</span>
          {running ? (
            <span className="ml-auto flex items-center gap-1 whitespace-nowrap text-[10px] text-live">
              <span className="w-1.5 h-1.5 rounded-full bg-live motion-safe:animate-pulse" />
              running
            </span>
          ) : (
            exitLabel && (
              <span
                className={cn(
                  "ml-auto whitespace-nowrap text-[10px]",
                  !timedOut && exitCode === 0 ? "text-wrap" : "text-fail",
                )}
              >
                {exitLabel}
              </span>
            )
          )}
        </div>
        {hasOutput ? (
          <div className="mt-2 pt-2 border-t border-divider">
            {stdout && <div className="whitespace-pre-wrap [overflow-wrap:anywhere] text-ink-soft">{stdout}</div>}
            {stderr && <div className="whitespace-pre-wrap [overflow-wrap:anywhere] text-fail">{stderr}</div>}
          </div>
        ) : (
          running && <div className="mt-2 pt-2 border-t border-divider text-ink-faint">waiting for output…</div>
        )}
      </div>
    </div>
  );
});

function Waiting() {
  return (
    <div className="flex items-end gap-2.5" data-testid="waiting-indicator">
      <AssistantAvatar />
      <div className="bubble bubble-assistant px-4 py-3 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-accent motion-safe:animate-[typing-bounce_1.3s_ease-in-out_0ms_infinite]" />
        <span className="w-1.5 h-1.5 rounded-full bg-accent motion-safe:animate-[typing-bounce_1.3s_ease-in-out_180ms_infinite]" />
        <span className="w-1.5 h-1.5 rounded-full bg-accent motion-safe:animate-[typing-bounce_1.3s_ease-in-out_360ms_infinite]" />
      </div>
    </div>
  );
}

// Another participant is composing — the peer-side counterpart to Waiting.
// Always "other" (self is excluded upstream), so it's always a blue peer bubble,
// right-aligned like their message will be, with the same `...` pulse.
function PeerTypingBubble({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-end gap-1" data-testid="peer-typing">
      <span className="text-[10px] uppercase tracking-wide text-sdk pr-1">{label}</span>
      <div className="bubble bubble-peer px-4 py-3 flex items-center gap-1.5">
        <span className="w-1.5 h-1.5 rounded-full bg-bubble-ink/70 motion-safe:animate-[typing-bounce_1.3s_ease-in-out_0ms_infinite]" />
        <span className="w-1.5 h-1.5 rounded-full bg-bubble-ink/70 motion-safe:animate-[typing-bounce_1.3s_ease-in-out_180ms_infinite]" />
        <span className="w-1.5 h-1.5 rounded-full bg-bubble-ink/70 motion-safe:animate-[typing-bounce_1.3s_ease-in-out_360ms_infinite]" />
      </div>
    </div>
  );
}

// A session-wide image lightbox: click any thumbnail to open the clicked image
// full size, then page through every image in the session with the arrows, a
// thumbnail strip, or ←/→. Images are the sandbox's ≤512² base64 thumbnails —
// "full size" here means the thumbnail shown unshrunk, capped to the viewport.
// Portals to <body> so the theme vars (on <html>) still cascade in, and so the
// scroll container's overflow/stacking never clips it. Esc / backdrop click /
// the ✕ all close.
type LightboxImage = { key: string; src: string };
function ImageLightbox({
  images,
  openKey,
  onClose,
  onSelect,
}: {
  images: LightboxImage[];
  openKey: string | null;
  onClose: () => void;
  onSelect: (key: string) => void;
}) {
  const idx = openKey == null ? -1 : images.findIndex((im) => im.key === openKey);
  const open = idx >= 0;
  const count = images.length;
  const activeThumbRef = useRef<HTMLButtonElement>(null);

  const go = useCallback(
    (delta: number) => {
      if (count === 0) return;
      const next = (idx + delta + count) % count;
      onSelect(images[next].key);
    },
    [idx, count, images, onSelect],
  );

  // Esc closes; ←/→ page. Bound while open so it doesn't shadow the composer's
  // own keys the rest of the time.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, go, onClose]);

  // Lock body scroll while open; keep the active thumbnail in view.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const thumb = activeThumbRef.current;
    // jsdom (tests) doesn't implement scrollIntoView; guard so the effect can't throw.
    if (thumb && typeof thumb.scrollIntoView === "function") {
      try {
        thumb.scrollIntoView({ block: "nearest", inline: "center" });
      } catch {
        /* non-fatal: keeping the active thumbnail centered is best-effort */
      }
    }
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open, openKey]);

  if (!open || typeof document === "undefined") return null;
  const current = images[idx];

  return createPortal(
    <div
      className="fixed inset-0 z-[95] flex flex-col bg-black/85 motion-safe:animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Image viewer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Top bar: position + close. */}
      <div
        className="flex items-center justify-between px-4 py-3 text-white/80"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="font-mono text-[12px] tabular-nums">
          {idx + 1} / {count}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-md p-1.5 text-white/70 hover:text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          autoFocus
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Stage: the current image, plus prev/next when there's more than one. */}
      <div
        className="relative flex min-h-0 flex-1 items-center justify-center px-4"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        {count > 1 && (
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous image"
            className="absolute left-2 sm:left-4 z-10 rounded-full p-2 bg-black/40 text-white/80 hover:bg-black/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={current.src}
          alt="attached image"
          className="max-h-full max-w-full rounded-lg object-contain shadow-overlay select-none"
          onMouseDown={(e) => e.stopPropagation()}
        />
        {count > 1 && (
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next image"
            className="absolute right-2 sm:right-4 z-10 rounded-full p-2 bg-black/40 text-white/80 hover:bg-black/60 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>

      {/* Thumbnail strip — the carousel. Active one ringed in accent. */}
      {count > 1 && (
        <div
          className="flex gap-2 overflow-x-auto px-4 py-3"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {images.map((im, i) => (
            <button
              key={im.key}
              ref={i === idx ? activeThumbRef : undefined}
              type="button"
              onClick={() => onSelect(im.key)}
              aria-label={`Image ${i + 1}`}
              aria-current={i === idx}
              className={cn(
                "shrink-0 rounded-md overflow-hidden border transition focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                i === idx
                  ? "border-accent ring-2 ring-accent"
                  : "border-white/20 opacity-60 hover:opacity-100",
              )}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={im.src} alt="" className="h-14 w-14 object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
}

export const ShellTranscript = memo(function ShellTranscript({
  events,
  hasMore,
  onLoadMore,
  isWaiting,
  viewerKind = "host",
  viewerName = "Host",
  typingLabel = "",
}: {
  events: EventRow[];
  hasMore: boolean;
  onLoadMore: () => void;
  isWaiting: boolean;
  // Who's viewing, so bubble color is relative to them (my turns green, others
  // blue). Optional with host defaults: unset → the host perspective (identical
  // to the pre-viewer-relative behavior), which keeps standalone renders simple.
  viewerKind?: "host" | "peer";
  viewerName?: string;
  // Comma-joined display names of OTHER participants currently composing (self
  // already excluded upstream). Empty → no typing bubble.
  typingLabel?: string;
}) {
  const viewer: Viewer = { kind: viewerKind, name: viewerName };

  // Every image in the session, in event order, so a click on any thumbnail can
  // open a lightbox that pages through all of them. Keyed `${row.id}:${i}` to
  // match the per-image key HostBubble emits. `openImage` is stable so it never
  // defeats HostBubble's memo.
  const allImages = useMemo(() => {
    const out: LightboxImage[] = [];
    for (const e of events) {
      if (e.agent_id) continue; // mirror the transcript's own subagent filter
      const imgs = Array.isArray(e.images) ? e.images : [];
      imgs.forEach((img, i) =>
        out.push({ key: `${e.id}:${i}`, src: `data:${img.media_type};base64,${img.data}` }),
      );
    }
    return out;
  }, [events]);
  const [openImageKey, setOpenImageKey] = useState<string | null>(null);
  const openImage = useCallback((key: string) => setOpenImageKey(key), []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);
  const prevLenRef = useRef(0);
  // Mirrors wasAtBottomRef into state, since the ref alone (read by the
  // auto-scroll effect below) never triggers a render — the "Scroll down"
  // bubble needs an actual state flip to appear/disappear.
  const [showScrollDown, setShowScrollDown] = useState(false);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 64;
    wasAtBottomRef.current = atBottom;
    setShowScrollDown(!atBottom);
  }

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Instant, not smooth: a smooth scrollTo fires intermediate `scroll` events
    // for the whole animation, and handleScroll would read those as still-far-
    // from-bottom and flip the bubble back on for the duration of its own click.
    el.scrollTop = el.scrollHeight;
    wasAtBottomRef.current = true;
    setShowScrollDown(false);
  }, []);

  const lastEventId = events.length > 0 ? events[events.length - 1].id : 0;
  useEffect(() => {
    if (events.length === 0) wasAtBottomRef.current = true;
    const justLoaded = prevLenRef.current === 0 && events.length > 0;
    prevLenRef.current = events.length;
    if (!wasAtBottomRef.current && !justLoaded) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setShowScrollDown(false);
  }, [events.length, lastEventId, isWaiting, typingLabel]);

  // Mirror the legacy dedup: only the FIRST SessionStart and a TERMINAL
  // SessionEnd are genuine boundaries (every /stop + /model churns a pair).
  let firstStartIdx = -1;
  let lastStartIdx = -1;
  for (let i = 0; i < events.length; i++) {
    if (events[i].hook_type === "SessionStart") {
      if (firstStartIdx === -1) firstStartIdx = i;
      lastStartIdx = i;
    }
  }

  // Coalesce streaming BashShortcut snapshots: a `!bash` emits many events that
  // share a run_id (start → throttled progress → done). Render ONE card, anchored
  // at the FIRST snapshot's position (so it doesn't jump to the bottom as updates
  // arrive) but showing the LATEST snapshot's data. Legacy single-shot events
  // (no run_id) fall back to one-card-per-event.
  const bashByRun = new Map<string, { firstId: number; latest: EventRow }>();
  for (const e of events) {
    if (e.hook_type !== "BashShortcut") continue;
    const rid = bashShortcutData(e)?.runId;
    if (!rid) continue;
    const cur = bashByRun.get(rid);
    if (!cur) bashByRun.set(rid, { firstId: e.id, latest: e });
    else cur.latest = e; // events are oldest→newest here, so the last one wins
  }

  const items: { key: string; node: React.ReactNode }[] = [];

  // Open tool-cluster buffer. Consecutive agent tool calls accumulate here and
  // flush as ONE ToolCluster (single avatar) the moment a VISIBLE non-tool item
  // is emitted — a model text turn, a host/peer bubble, a divider, a bash card.
  // Invisible events (empty Stop, permission frames, subagent-internal rows)
  // don't flush, so they never fracture an otherwise-contiguous run of tools.
  let pending: ToolItem[] = [];
  const flushTools = () => {
    if (pending.length === 0) return;
    const list = pending;
    pending = [];
    items.push({ key: `tc-${list[0].key}`, node: <ToolCluster tools={list} /> });
  };
  // Every visible non-tool item goes through here so the open cluster closes
  // first, preserving chronological order.
  const pushNode = (key: string, node: React.ReactNode) => {
    flushTools();
    items.push({ key, node });
  };

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    // Subagent-internal events (claude sets ctx.agent_id on a sidechain's
    // PreToolUse/PostToolUse/SubagentStop) don't belong in the main thread —
    // they're surfaced in the Agents rail. The parent's own Task/Agent tool
    // call has no agent_id, so the "a subagent ran" marker still shows here.
    if (e.agent_id) continue;
    switch (e.hook_type) {
      // Preview lifecycle. Still INGESTED — it stays in the events feed, search
      // and the notification classifier, so the shared record is intact — but it
      // is not chat. The preview has a permanent home in the right rail that
      // shows its live state, so replaying every start/share/stop as transcript
      // furniture just pushed the conversation around. Breaks without pushNode
      // so, like a hidden turn, it cannot split an open tool cluster.
      case "PreviewStarted":
      case "PreviewFailed":
      case "PreviewShared":
      case "PreviewRebuilt":
      case "PreviewStopped":
        break;
      // The exception to the rule above: this one is not lifecycle furniture but
      // a request the agent is blocked on. The rail shows preview STATE; it has
      // nowhere to say "somebody please open me", and a nudge nobody sees is not
      // a nudge.
      case "PreviewNeedsViewer":
        pushNode(`pv-${e.id}`, <Divider label={systemText(e) || "the agent needs the preview open"} />);
        break;
      case "SessionStart":
        if (i === firstStartIdx) pushNode(`s-${e.id}`, <Divider label="session start" />);
        break;
      case "SessionEnd":
        if (i > lastStartIdx) pushNode(`e-${e.id}`, <Divider label="session end" />);
        break;
      case "UserPromptSubmit":
        if (isHiddenTurnKind(e.kind)) {
          // A system-injected turn the model acts on but that must never
          // render as chat (see shared/turn-kinds.ts): a plan proceed/revise
          // or answer relay, whose user-facing lifecycle notice is a separate
          // event, or a background sub-agent's <task-notification> result,
          // whose data belongs in the Agents rail instead. Invisible like an
          // empty Stop: it must NOT flush an open tool cluster, so we break
          // without pushNode.
          break;
        }
        if (e.kind === "plan-approval" || e.kind === "plan-rejection") {
          pushNode(
            `u-${e.id}`,
            <PlanDecisionNotice row={e} variant={e.kind === "plan-approval" ? "approval" : "rejection"} />,
          );
        } else if (e.kind === "question-answer") {
          pushNode(`u-${e.id}`, <QuestionAnswerNotice row={e} />);
        } else if (
          e.kind === "preview-idle-release" || e.kind === "share-idle-revoke"
          // Something happened TO the session — nobody typed it. Falling through
          // to the default would draw it as a chat bubble from whoever the
          // request authenticated as, which in a shared session is a message
          // attributed to a person who never sent one.
          || e.kind === "preview-taken-over"
        ) {
          pushNode(`u-${e.id}`, <LifecycleNotice row={e} />);
        } else if (e.kind === "command") {
          pushNode(`u-${e.id}`, <CommandCard row={e} />);
        } else {
          pushNode(`u-${e.id}`, <HostBubble row={e} mine={isMine(e, viewer)} onOpenImage={openImage} />);
        }
        break;
      case "Stop":
      case "SubagentStop":
        if ((e.text ?? "").trim().length > 0) {
          // An API failure (usage/rate limit, overload) is NOT the model talking
          // — the sandbox tags it kind=error. Show it as a failure rather than as
          // an assistant reply, which is what it used to look like. A visible model
          // text turn CLOSES the current tool cluster (via pushNode).
          pushNode(
            `a-${e.id}`,
            e.kind === "compaction"
              ? <CompactionNotice row={e} />
              : e.kind === "error"
                ? <ErrorNotice row={e} />
                : <AssistantBubble row={e} />,
          );
        }
        // An empty Stop (no text) renders nothing and must NOT split a cluster —
        // so we deliberately don't flush here.
        break;
      case "PreToolUse": {
        const next = events[i + 1];
        if (next && !next.agent_id && next.hook_type === "PostToolUse" && e.tool_name != null && next.tool_name === e.tool_name) {
          pending.push({ key: `t-${e.id}-${next.id}`, pre: e, post: next });
          i += 1;
        } else {
          pending.push({ key: `t-${e.id}`, pre: e });
        }
        break;
      }
      case "PostToolUse":
        pending.push({ key: `to-${e.id}`, pre: e, post: e });
        break;
      case "BashShortcut": {
        const rid = bashShortcutData(e)?.runId;
        if (rid) {
          const grp = bashByRun.get(rid);
          // Only the first snapshot anchors the card; later snapshots for the
          // same run are absorbed (the anchor renders the latest data). Stable
          // key by run id so React updates the card in place.
          if (grp && e.id === grp.firstId) {
            pushNode(`b-${rid}`, <BashCard row={grp.latest} />);
          }
        } else {
          pushNode(`b-${e.id}`, <BashCard row={e} />);
        }
        break;
      }
      case "Chat":
        pushNode(`c-${e.id}`, <HostBubble row={e} mine={isMine(e, viewer)} chat onOpenImage={openImage} />);
        break;
      case "PermissionRequest":
      case "PermissionResponse":
        break;
      default: {
        const t = systemText(e);
        pushNode(`n-${e.id}`, <Divider label={(t || e.hook_type || "event").toLowerCase()} />);
        break;
      }
    }
  }
  // Close any tool cluster still open at the end of the stream.
  flushTools();

  return (
    <>
    <div className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="shell-transcript"
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-5 py-5 flex flex-col gap-4"
      >
        {hasMore && (
          <div className="flex justify-center pb-1">
            <button onClick={onLoadMore} className="pill-btn text-[11px] px-3 py-1.5">
              <ArrowUp className="w-3.5 h-3.5" /> load earlier
            </button>
          </div>
        )}
        {items.length === 0 && !isWaiting && !typingLabel ? (
          <p className="font-mono text-[11px] text-ink-faint">waiting for first turn…</p>
        ) : (
          <>
            {items.map((it) => (
              <div key={it.key} className="motion-safe:animate-msg-in">
                {it.node}
              </div>
            ))}
            {isWaiting && <Waiting />}
            {typingLabel && <PeerTypingBubble label={typingLabel} />}
          </>
        )}
      </div>
      {/* Only once scrolled away from the bottom — a live transcript already
        * sticks to the bottom on its own (see the auto-scroll effect above),
        * so this only ever appears once someone has deliberately scrolled up
        * to read history. */}
      {showScrollDown && (
        <button
          type="button"
          onClick={scrollToBottom}
          aria-label="Scroll to the latest message"
          title="Scroll to the latest message"
          className="absolute bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1.5
                     rounded-full bg-elevated border border-divider shadow-overlay
                     px-3 py-1.5 text-[11px] text-ink-soft hover:text-ink hover:bg-elevated/80
                     transition-colors motion-safe:animate-modal-in"
        >
          <ArrowDown className="w-3.5 h-3.5" />
          Scroll down
        </button>
      )}
    </div>
    <ImageLightbox
      images={allImages}
      openKey={openImageKey}
      onClose={() => setOpenImageKey(null)}
      onSelect={setOpenImageKey}
    />
    </>
  );
});
