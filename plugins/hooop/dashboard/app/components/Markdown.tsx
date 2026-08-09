"use client";
import { createContext, useContext, useMemo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import hljs from "highlight.js/lib/common";
import { FILE_MENTION, parseFileMention } from "@shared/file-mentions";

/**
 * Markdown renderer for assistant transcripts, peer/host chat, and plan
 * content. Backed by react-markdown + remark-gfm so we get a real, spec-tested
 * CommonMark/GFM parser (tables, task lists, strikethrough, escapes, nested
 * lists) instead of a hand-rolled one that trips over corner cases.
 *
 * Safety: react-markdown builds React nodes — no dangerouslySetInnerHTML for
 * input — and we do NOT enable rehype-raw, so embedded HTML is shown as text.
 * URLs are sanitised by react-markdown's defaultUrlTransform (javascript:,
 * data:, etc. are stripped); we additionally drop anchors whose href didn't
 * survive that transform.
 *
 * remark-breaks maps single newlines to <br>, matching how chat/assistant
 * messages are authored (a newline is a line break, not a paragraph join).
 */
const REMARK_PLUGINS = [remarkGfm, remarkBreaks];

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastNode[];
  properties?: Record<string, unknown>;
}

// A `@handle` at a word boundary. The same lookbehind as FILE_MENTION, which is
// what keeps it out of an email address: "bruno@example.com" has no whitespace
// before the "@". Handles are slugs (see @shared/handles), so the character
// class is deliberately narrow.
const PEER_MENTION = /(?<=^|\s)@[a-z0-9-]+/g;

/** Splits one text node into plain text and chip elements. `peers` maps each
 *  handle currently in the session to its display name: an `@token` that isn't
 *  one of them is left as prose, so "@types/node" and a mention of someone who
 *  has left don't chip. */
function splitMentions(
  value: string,
  peers: ReadonlyMap<string, string>,
  me: string | null,
): HastNode[] {
  type Hit = { start: number; end: number; node: HastNode };
  const hits: Hit[] = [];

  for (const m of value.matchAll(FILE_MENTION)) {
    const start = m.index ?? 0;
    // The path/line ride along as data attributes rather than being re-parsed
    // from the rendered text: the chip's children are display text, and the
    // click target must not depend on scraping them back apart.
    const { path, line } = parseFileMention(m[0]);
    hits.push({
      start,
      end: start + m[0].length,
      node: {
        type: "element",
        tagName: "span",
        properties: {
          className: ["hooop-file-chip"],
          "data-mention-path": path,
          ...(line != null ? { "data-mention-line": String(line) } : {}),
        },
        children: [{ type: "text", value: m[0] }],
      },
    });
  }

  if (peers.size > 0) {
    for (const m of value.matchAll(PEER_MENTION)) {
      const handle = m[0].slice(1);
      const name = peers.get(handle);
      if (name === undefined) continue;
      const start = m.index ?? 0;
      hits.push({
        start,
        end: start + m[0].length,
        node: {
          type: "element",
          tagName: "span",
          properties: {
            className: ["hooop-peer-chip"],
            "data-mention-handle": handle,
            // Resolved HERE, where `me` is known, rather than compared in the
            // renderer against an attribute that would have to be threaded in
            // some other way.
            ...(me != null && handle === me ? { "data-mention-mine": "1" } : {}),
          },
          // Shows the DISPLAY NAME, not the handle. The handle exists so a
          // mention can be typed and matched; it is not what anyone calls this
          // person. The message text still carries "@bruno-de-queiroz" — which
          // is what notification targeting reads — while the bubble reads
          // "@Bruno de Queiroz".
          children: [{ type: "text", value: `@${name}` }],
        },
      });
    }
  }

  if (hits.length === 0) return [{ type: "text", value }];
  // The two patterns are scanned independently, so the hits have to be put back
  // in document order before slicing — otherwise a message with a peer mention
  // before a file mention would emit its text fragments shuffled.
  hits.sort((a, b) => a.start - b.start);

  const out: HastNode[] = [];
  let last = 0;
  for (const h of hits) {
    if (h.start < last) continue; // overlapping match; first one wins
    if (h.start > last) out.push({ type: "text", value: value.slice(last, h.start) });
    out.push(h.node);
    last = h.end;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

// rehype plugin: wrap `#file` and `@peer` mentions in text nodes as chip spans.
// Skips code / pre subtrees, where "#" is literal source (a comment, usually)
// rather than a mention — the same subtrees toClaudeFileRefs refuses to rewrite
// on the way out.
function rehypeMentions(peers: ReadonlyMap<string, string>, me: string | null) {
  return () => {
    const walk = (node: HastNode) => {
      if (!node.children || node.tagName === "code" || node.tagName === "pre") return;
      const next: HastNode[] = [];
      for (const child of node.children) {
        const v = child.type === "text" ? child.value : undefined;
        if (typeof v === "string" && (v.includes("#") || v.includes("@"))) {
          next.push(...splitMentions(v, peers, me));
        } else {
          walk(child);
          next.push(child);
        }
      }
      node.children = next;
    };
    return (tree: HastNode) => walk(tree);
  };
}

/** What a `#file` chip hands back when clicked. */
export type MentionClickHandler = (mention: { path: string; line: number | null }) => void;

// Supplied by <Markdown onFileMention>. Passed by CONTEXT rather than threaded
// through `components` because COMPONENTS has to stay a module-level constant:
// react-markdown remounts the subtree when the components object changes
// identity, so rebuilding it per render would tear down and recreate every node
// of every message on each transcript update.
const MentionClickContext = createContext<MentionClickHandler | null>(null);

// Shared chip geometry. The COLOUR is deliberately not in here: the file chip
// is always white-on-dark, while a peer chip inverts with the theme.
const CHIP_BASE =
  "mx-px inline-flex items-center rounded px-1.5 font-mono text-[11px] font-semibold align-baseline";
const CHIP_CLASS = `${CHIP_BASE} text-white`;
const CHIP_STYLE = { background: "color-mix(in oklab, rgb(var(--sdk)) 55%, black)" };

// Static when nobody's listening, a button when there is a handler. Kept as a
// real <button> (not a span with onClick) so it's tab-reachable and announced
// as an action — the chip is the only way to open a file straight from the
// transcript. A button is phrasing content, so it nests legally in a <p>.
function FileChip({
  path,
  line,
  children,
}: {
  path: string | null;
  line: number | null;
  children: React.ReactNode;
}) {
  const onMention = useContext(MentionClickContext);
  if (!onMention || !path) {
    return <span className={CHIP_CLASS} style={CHIP_STYLE}>{children}</span>;
  }
  return (
    <button
      type="button"
      onClick={() => onMention({ path, line })}
      title={`Open ${path}${line != null ? `:${line}` : ""}`}
      className={`${CHIP_CLASS} cursor-pointer hover:brightness-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50`}
      style={CHIP_STYLE}
    >
      {children}
    </button>
  );
}

// A `@handle` mention. Not interactive: it names a person, and there is nothing
// to open. It IS marked differently when it names YOU, which is the whole point
// of the sigil — the salience is the feature, not the link.
//
// The neutral chip INVERTS with the theme (ink fill, elevated text) rather than
// picking a hue. That is what makes it safe: it sits on four different
// backgrounds — the dark green/blue bubbles of the dark theme and the pale
// green/blue of the light one — and any fixed hue is muddy on at least one of
// them. Inverting guarantees separation from the bubble in both.
//
// "Mentions you" uses --accent-press, the darker pink already in the palette
// for :active, rather than the raw --accent: at 11px the full-strength accent
// glares against a saturated bubble.
const PEER_CHIP = { background: "rgb(var(--ink))", color: "rgb(var(--elevated))" };
const PEER_CHIP_MINE = { background: "rgb(var(--accent-press))", color: "#fff" };

function PeerChip({ mine, children }: { mine: boolean; children: React.ReactNode }) {
  return (
    <span className={CHIP_BASE} style={mine ? PEER_CHIP_MINE : PEER_CHIP}>
      {children}
    </span>
  );
}

const COMPONENTS: Components = {
  p: ({ children }) => <p className="my-1 break-words [overflow-wrap:anywhere]">{children}</p>,
  h1: ({ children }) => <div className="text-[15px] font-semibold text-ink mt-2 mb-1">{children}</div>,
  h2: ({ children }) => <div className="text-[14px] font-semibold text-ink mt-2 mb-1">{children}</div>,
  h3: ({ children }) => <div className="text-[13px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  h4: ({ children }) => <div className="text-[12px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  h5: ({ children }) => <div className="text-[12px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  h6: ({ children }) => <div className="text-[12px] font-semibold text-ink-soft mt-2 mb-1">{children}</div>,
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="line-through text-ink-mute">{children}</del>,
  hr: () => <hr className="border-divider my-2" />,
  ul: ({ children }) => (
    <ul className="list-disc pl-4 my-1 space-y-0.5 marker:text-ink-hush">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-4 my-1 space-y-0.5 marker:text-ink-hush">{children}</ol>
  ),
  li: ({ children }) => <li className="break-words [overflow-wrap:anywhere]">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-divider pl-2 my-1 text-ink-mute italic">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    // react-markdown already sanitised href; an empty string means the URL was
    // rejected (e.g. javascript:). Render the label as text, not a dead link.
    if (!href) return <>{children}</>;
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        className="text-sdk hover:brightness-110 underline decoration-sdk/40 hover:decoration-sdk/70"
      >
        {children}
      </a>
    );
  },
  img: ({ src, alt }) =>
    src ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt ?? ""} className="max-h-64 max-w-full rounded-lg my-1" />
    ) : null,
  table: ({ children }) => (
    <div className="my-1.5 overflow-x-auto">
      <table className="border-collapse text-[12px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead>{children}</thead>,
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => <tr>{children}</tr>,
  th: ({ children, style }) => (
    <th className={`border border-divider px-2 py-1 font-semibold text-ink ${alignClass(style?.textAlign)}`}>
      {children}
    </th>
  ),
  td: ({ children, style }) => (
    <td className={`border border-divider px-2 py-1 align-top text-ink-soft ${alignClass(style?.textAlign)}`}>
      {children}
    </td>
  ),
  // Block code is wrapped in <pre><code>; unwrap the <pre> so the fenced block
  // renders through our highlight.js CodeBlock (which brings its own chrome).
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children }) => {
    const text = String(children ?? "");
    const match = /language-([\w-]+)/.exec(className || "");
    const isBlock = Boolean(match) || text.includes("\n");
    if (isBlock) {
      return <CodeBlock lang={match?.[1] ?? ""} body={text.replace(/\n$/, "")} />;
    }
    return (
      <code className="px-1 py-0.5 rounded bg-sunken text-ink font-mono text-[11px]">{children}</code>
    );
  },
  // Only ever present when the file-chip rehype plugin is active (see below):
  // a `#file` mention rendered as a compact inline chip instead of plain text.
  // Only ever rendered inside a colored chat bubble (host/peer). A solid
  // fill with white text reads clearly against both the green host and blue
  // peer bubbles — a tinted bg + same-hue text doesn't have enough contrast
  // against a saturated bubble color underneath. We use `sdk` (blue) to match
  // the file navigator's reference accent, darkened toward black so it stays
  // legible on the blue peer bubble (see ErrorNotice for the same pattern).
  span: ({ className, children, ...rest }) => {
    const cls = Array.isArray(className) ? className.join(" ") : className ?? "";
    const attrs = rest as Record<string, unknown>;
    if (cls.includes("hooop-file-chip")) {
      const path = typeof attrs["data-mention-path"] === "string" ? attrs["data-mention-path"] : null;
      const rawLine = attrs["data-mention-line"];
      const line = typeof rawLine === "string" ? Number(rawLine) : null;
      return (
        <FileChip path={path} line={line}>
          {children}
        </FileChip>
      );
    }
    if (cls.includes("hooop-peer-chip")) {
      const handle = typeof attrs["data-mention-handle"] === "string" ? attrs["data-mention-handle"] : null;
      return <PeerChip mine={attrs["data-mention-mine"] === "1"}>{children}</PeerChip>;
    }
    return <span className={cls || undefined}>{children}</span>;
  },
};

// `fileChips` opts into `#file` mention chips — enabled for user/peer messages
// (the composer's autocomplete inserts these), left off for assistant/plan
// content where a stray "#token" shouldn't be reinterpreted as a file.
// `onFileMention` additionally makes those chips clickable; without it they
// render exactly as before, as inert labels.
export function Markdown({
  source,
  fileChips = false,
  onFileMention,
  peers,
  mePeer,
}: {
  source: string;
  fileChips?: boolean;
  onFileMention?: MentionClickHandler;
  /** Everyone currently in the session. Only these chip, so "@types/node" and a
   *  mention of somebody who has left stay as prose. The chip renders `name`;
   *  `handle` is what the message text actually contains. */
  peers?: readonly { handle: string; name: string }[];
  /** The viewer's own handle, so a mention OF them is tinted differently. */
  mePeer?: string | null;
}) {
  // Memoised on the FLATTENED roster, not the array, because it arrives fresh
  // on every presence heartbeat. Depending on its identity would hand
  // react-markdown a new plugin list every ~10s, and it remounts the subtree
  // when that changes — every message in the transcript, re-parsed, several
  // times a minute. Both fields are in the key: a rename has to re-render.
  const peerKey = peers?.length ? peers.map((p) => `${p.handle}\u0000${p.name}`).join("\u0001") : "";
  const rehypePlugins = useMemo(() => {
    if (!fileChips) return undefined;
    const map = new Map<string, string>();
    if (peerKey) {
      for (const row of peerKey.split("\u0001")) {
        const [handle, name] = row.split("\u0000");
        map.set(handle, name);
      }
    }
    return [rehypeMentions(map, mePeer ?? null)];
  }, [fileChips, peerKey, mePeer]);

  return (
    <MentionClickContext.Provider value={onFileMention ?? null}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={rehypePlugins}
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </MentionClickContext.Provider>
  );
}

function alignClass(align: string | undefined): string {
  return align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left";
}

function CodeBlock({ lang, body }: { lang: string; body: string }) {
  // Highlight the body. If the fence specifies a known language, use it;
  // otherwise fall back to auto-detection. highlight.js escapes input, so
  // the resulting HTML is safe to dangerouslySet.
  const highlighted = useMemo(() => {
    try {
      const normalised = normaliseLang(lang);
      if (normalised && hljs.getLanguage(normalised)) {
        return hljs.highlight(body, { language: normalised, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(body).value;
    } catch {
      // Highlighting is best-effort; fall back to escaped plain text.
      return escapeHtml(body);
    }
  }, [body, lang]);

  return (
    <div className="hooop-code my-1.5 rounded overflow-hidden">
      {lang && (
        <div className="hooop-code-lang px-2 py-0.5 text-[9px] uppercase tracking-wider font-mono">
          {lang}
        </div>
      )}
      <pre className="px-2 py-1.5 text-[11px] leading-relaxed overflow-x-auto whitespace-pre hljs">
        <code dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </div>
  );
}

function normaliseLang(lang: string): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase().trim();
  // Common aliases highlight.js doesn't accept by default.
  const aliases: Record<string, string> = {
    sh: "bash",
    shell: "bash",
    zsh: "bash",
    yml: "yaml",
    md: "markdown",
    py: "python",
    rb: "ruby",
    rs: "rust",
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    h: "c",
    "c++": "cpp",
    cs: "csharp",
    text: "plaintext",
    txt: "plaintext",
  };
  return aliases[l] ?? l;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
