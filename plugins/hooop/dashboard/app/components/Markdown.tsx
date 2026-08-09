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

function splitFileMentions(value: string): HastNode[] {
  const out: HastNode[] = [];
  let last = 0;
  for (const m of value.matchAll(FILE_MENTION)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ type: "text", value: value.slice(last, start) });
    // The path/line ride along as data attributes rather than being re-parsed
    // from the rendered text: the chip's children are display text, and the
    // click target must not depend on scraping them back apart.
    const { path, line } = parseFileMention(m[0]);
    out.push({
      type: "element",
      tagName: "span",
      properties: {
        className: ["hooop-file-chip"],
        "data-mention-path": path,
        ...(line != null ? { "data-mention-line": String(line) } : {}),
      },
      children: [{ type: "text", value: m[0] }],
    });
    last = start + m[0].length;
  }
  if (last < value.length) out.push({ type: "text", value: value.slice(last) });
  return out;
}

// rehype plugin: wrap `#file` mentions in text nodes as chip spans. Skips code /
// pre subtrees, where "#" is literal source (a comment, usually), not a mention
// — the same subtrees toClaudeFileRefs refuses to rewrite on the way out.
function rehypeFileChips() {
  const walk = (node: HastNode) => {
    if (!node.children || node.tagName === "code" || node.tagName === "pre") return;
    const next: HastNode[] = [];
    for (const child of node.children) {
      if (child.type === "text" && typeof child.value === "string" && child.value.includes("#")) {
        next.push(...splitFileMentions(child.value));
      } else {
        walk(child);
        next.push(child);
      }
    }
    node.children = next;
  };
  return (tree: HastNode) => walk(tree);
}

const REHYPE_FILE_CHIPS = [rehypeFileChips];

/** What a `#file` chip hands back when clicked. */
export type MentionClickHandler = (mention: { path: string; line: number | null }) => void;

// Supplied by <Markdown onFileMention>. Passed by CONTEXT rather than threaded
// through `components` because COMPONENTS has to stay a module-level constant:
// react-markdown remounts the subtree when the components object changes
// identity, so rebuilding it per render would tear down and recreate every node
// of every message on each transcript update.
const MentionClickContext = createContext<MentionClickHandler | null>(null);

const CHIP_CLASS =
  "mx-px inline-flex items-center rounded px-1.5 font-mono text-[11px] font-semibold text-white align-baseline";
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
    if (cls.includes("hooop-file-chip")) {
      const attrs = rest as Record<string, unknown>;
      const path = typeof attrs["data-mention-path"] === "string" ? attrs["data-mention-path"] : null;
      const rawLine = attrs["data-mention-line"];
      const line = typeof rawLine === "string" ? Number(rawLine) : null;
      return (
        <FileChip path={path} line={line}>
          {children}
        </FileChip>
      );
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
}: {
  source: string;
  fileChips?: boolean;
  onFileMention?: MentionClickHandler;
}) {
  return (
    <MentionClickContext.Provider value={onFileMention ?? null}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={fileChips ? REHYPE_FILE_CHIPS : undefined}
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
