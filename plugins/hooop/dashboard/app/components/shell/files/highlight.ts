// Syntax highlighting for the file preview. The preview renders line-by-line
// (for gutter numbers + click-to-reference), so we can't hand a whole block to
// highlight.js and keep its output — we highlight the full file once (so
// multi-line constructs like block comments/strings resolve correctly), then
// slice the resulting HTML into one fragment per line, re-opening any spans
// that straddle a newline so every line is self-balanced.
//
// Uses the same `highlight.js/lib/common` bundle + global github token theme as
// the Markdown code block, so colors match the rest of the app in both themes.
import hljs from "highlight.js/lib/common";

// Extension → highlight.js language id. Only ids present in the common bundle
// actually highlight (checked via getLanguage); the rest fall back to plain.
const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", pyw: "python", rb: "ruby", rs: "rust", go: "go",
  java: "java", kt: "kotlin", kts: "kotlin", swift: "swift", scala: "scala",
  c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp",
  cs: "csharp", php: "php", pl: "perl", pm: "perl", lua: "lua", r: "r",
  sh: "bash", bash: "bash", zsh: "bash", ksh: "bash",
  json: "json", jsonc: "json", json5: "json",
  yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  xml: "xml", html: "xml", htm: "xml", svg: "xml", xhtml: "xml", plist: "xml",
  css: "css", scss: "scss", sass: "scss", less: "less",
  sql: "sql", md: "markdown", markdown: "markdown", diff: "diff", patch: "diff",
  graphql: "graphql", gql: "graphql", vue: "xml",
};

// Filename (no extension) → language, for the well-known extension-less files.
const NAME_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
};

/** Resolve a highlight.js language id from a path, or null when we can't (which
 * means: render plain, don't guess — avoids mis-coloring logs/plain text). */
export function langFromPath(path: string): string | null {
  const base = (path.split("/").pop() ?? path).toLowerCase();
  const byName = NAME_LANG[base];
  if (byName) return hljs.getLanguage(byName) ? byName : null;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension (or dotfile like ".gitignore")
  const lang = EXT_LANG[base.slice(dot + 1)];
  return lang && hljs.getLanguage(lang) ? lang : null;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// highlight.js output is only <span…> / </span> / escaped text / newlines.
// Walk it, tracking the open-span stack, and cut at each newline — closing open
// spans to end the line and re-opening them to start the next.
function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const stack: string[] = [];
  let cur = "";
  const re = /<span[^>]*>|<\/span>|\n|[^<\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tok = m[0];
    if (tok === "\n") {
      cur += "</span>".repeat(stack.length);
      lines.push(cur);
      cur = stack.join("");
    } else if (tok === "</span>") {
      stack.pop();
      cur += tok;
    } else if (tok[0] === "<") {
      stack.push(tok);
      cur += tok;
    } else {
      cur += tok;
    }
  }
  cur += "</span>".repeat(stack.length);
  lines.push(cur);
  return lines;
}

/** Highlight a whole file into one HTML fragment per line. Falls back to
 * escaped plain lines when the language is unknown or highlighting throws. */
export function highlightToLines(code: string, lang: string | null): string[] {
  const body = code.replace(/\n$/, "");
  if (lang && hljs.getLanguage(lang)) {
    try {
      return splitHighlightedLines(hljs.highlight(body, { language: lang, ignoreIllegals: true }).value);
    } catch {
      /* fall through to plain */
    }
  }
  return body.split("\n").map(escapeHtml);
}

/** Highlight a single line (diff rows, which aren't a contiguous file). Best
 * effort with a fixed language — multi-line context can't survive, but that's
 * the accepted trade-off for a line-oriented diff view. */
export function highlightLine(text: string, lang: string | null): string {
  if (!text) return "";
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through */
    }
  }
  return escapeHtml(text);
}
