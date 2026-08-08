"use client";
import { useMemo } from "react";
import hljs from "highlight.js/lib/common";
import { cn } from "./cn";

// Fenced code with highlight.js token colors inside the `.hooop-code` chrome
// (styled in globals.css — dark uses github-dark-dimmed, light overrides to a
// github-light palette). highlight.js escapes its input, so the resulting HTML
// is safe to dangerouslySet. Mirrors the CodeBlock in Markdown.tsx, extracted
// as a reusable primitive.
const LANG_ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
};

function normaliseLang(lang: string): string | null {
  if (!lang) return null;
  const l = lang.toLowerCase().trim();
  return LANG_ALIASES[l] ?? l;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export type CodeBlockProps = {
  code: string;
  lang?: string;
  className?: string;
};

export function CodeBlock({ code, lang = "", className }: CodeBlockProps) {
  const highlighted = useMemo(() => {
    try {
      const normalised = normaliseLang(lang);
      if (normalised && hljs.getLanguage(normalised)) {
        return hljs.highlight(code, { language: normalised, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(code).value;
    } catch {
      return escapeHtml(code);
    }
  }, [code, lang]);

  return (
    <div className={cn("hooop-code my-1.5 rounded overflow-hidden", className)}>
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
