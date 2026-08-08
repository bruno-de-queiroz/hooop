"use client";
import { useState } from "react";
import { Braces, FileText } from "lucide-react";
import { cn } from "../ui/cn";

// Desktop-shell event detail (Phase 3). The mockup's sunken card chrome — a
// dv-b header (timestamp + session + cwd, view/raw `.tab tab-neutral` toggles)
// over a scrolling body — wrapping the legacy EventDetail's richer recursive
// structured renderer (ported to tokens so real payloads still read well).

interface EventDetail {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  payload: unknown;
}

export function ShellEventDetail({ detail }: { detail: EventDetail | undefined }) {
  const [mode, setMode] = useState<"view" | "raw">("view");

  if (!detail) {
    return <p className="text-ink-faint text-[11px] px-2 py-1">Loading…</p>;
  }

  const payload = detail.payload as Record<string, unknown> | null;
  const ctx = (payload?.ctx ?? {}) as Record<string, unknown>;
  const meta: Array<[string, string]> = [];
  if (detail.session_id) meta.push(["session", detail.session_id.slice(0, 8) + "…"]);
  if (typeof ctx.cwd === "string") meta.push(["cwd", ctx.cwd]);

  return (
    <div className="rounded-lg overflow-hidden bg-sunken border border-divider">
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 border-b border-divider text-[10px] text-ink-faint">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="font-mono">{detail.ts.replace("T", " ").replace("Z", " UTC")}</span>
          {meta.map(([k, v]) => (
            <span key={k} className="flex items-center gap-1">
              <span>{k}</span>
              <span className="font-mono text-ink-mute truncate max-w-[40ch]" title={v}>
                {v}
              </span>
            </span>
          ))}
        </div>
        <div className="flex gap-1 shrink-0">
          <button
            onClick={() => setMode("view")}
            className={cn("tab tab-neutral px-1.5 py-0.5 flex items-center gap-1", mode === "view" && "is-on")}
          >
            <FileText className="w-2.5 h-2.5" /> view
          </button>
          <button
            onClick={() => setMode("raw")}
            className={cn("tab tab-neutral px-1.5 py-0.5 flex items-center gap-1", mode === "raw" && "is-on")}
          >
            <Braces className="w-2.5 h-2.5" /> raw
          </button>
        </div>
      </div>

      <div className="p-3 text-[11px] max-h-80 overflow-y-auto">
        {mode === "raw" ? (
          <pre className="whitespace-pre-wrap break-words text-ink-soft font-mono">
            {formatJson(detail.payload)}
          </pre>
        ) : (
          <StructuredView ctx={ctx} text={detail.text} />
        )}
      </div>
    </div>
  );
}

function StructuredView({ ctx, text }: { ctx: Record<string, unknown>; text: string | null }) {
  const prompt = typeof ctx.prompt === "string" ? ctx.prompt : null;
  const toolInput = ctx.tool_input;
  const toolResponse = ctx.tool_response ?? ctx.tool_result;
  const message = typeof ctx.message === "string" ? ctx.message : null;
  const transcript = typeof ctx.transcript === "string" ? ctx.transcript : null;

  const handled = new Set([
    "prompt", "tool_input", "tool_response", "tool_result",
    "message", "transcript", "cwd", "transcript_path", "session_id", "tool_name",
  ]);
  const rest = Object.fromEntries(
    Object.entries(ctx).filter(([k, v]) => !handled.has(k) && v != null),
  );

  const sections: React.ReactNode[] = [];
  if (prompt) sections.push(<Section key="prompt" title="Prompt" value={prompt} />);
  if (toolInput !== undefined) sections.push(<Section key="input" title="Input" value={toolInput} />);
  if (toolResponse !== undefined) sections.push(<Section key="output" title="Output" value={toolResponse} />);
  if (message) sections.push(<Section key="message" title="Message" value={message} />);
  if (transcript) sections.push(<Section key="transcript" title="Transcript" value={transcript} />);
  if (Object.keys(rest).length > 0) sections.push(<Section key="rest" title="Other" value={rest} />);

  if (sections.length === 0) {
    return (
      <pre className="whitespace-pre-wrap break-words text-ink-faint font-mono">
        {text || "(no details)"}
      </pre>
    );
  }
  return <div className="space-y-2">{sections}</div>;
}

function Section({ title, value }: { title: string; value: unknown }) {
  return (
    <div>
      <div className="section-title mb-0.5">{title}</div>
      <ValueRenderer value={value} />
    </div>
  );
}

function ValueRenderer({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value == null) return <span className="text-ink-faint italic">null</span>;
  if (typeof value === "string") return <Collapsible text={value} />;
  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="font-mono text-ink-soft">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-faint italic">[]</span>;
    if (value.every((v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
      return (
        <ul className="space-y-0.5">
          {value.map((v, i) => (
            <li key={i} className="font-mono text-ink-soft">• {String(v)}</li>
          ))}
        </ul>
      );
    }
    return (
      <pre className="whitespace-pre-wrap break-words text-ink-soft font-mono bg-window rounded p-1.5 border border-divider">
        {formatJson(value)}
      </pre>
    );
  }
  if (typeof value === "object") {
    return <ObjectRenderer value={value as Record<string, unknown>} depth={depth} />;
  }
  return <span className="text-ink-mute">{String(value)}</span>;
}

function ObjectRenderer({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-ink-faint italic">{"{}"}</span>;
  const indent = depth > 0 ? "border-l border-divider pl-3" : "";
  return (
    <ul className={cn("space-y-0.5", indent)}>
      {entries.map(([k, v]) => {
        const inline =
          v == null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
        const compact =
          inline && (typeof v !== "string" || (v.length <= 120 && !v.includes("\n")));
        if (compact) {
          return (
            <li key={k} className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-ink-faint font-mono text-[10px] shrink-0">{k}</span>
              <span className="font-mono text-ink-soft break-all">
                {v == null ? <span className="text-ink-faint italic">null</span> : String(v)}
              </span>
            </li>
          );
        }
        return (
          <li key={k} className="space-y-0.5">
            <div className="text-ink-faint font-mono text-[10px]">{k}</div>
            <div className="pl-2">
              <ValueRenderer value={v} depth={depth + 1} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Collapsible({ text }: { text: string }) {
  const LIMIT = 800;
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > LIMIT;
  const shown = !isLong || expanded ? text : text.slice(0, LIMIT) + "…";
  return (
    <div>
      <pre className="whitespace-pre-wrap break-words text-ink-soft font-mono text-[11px] leading-relaxed border-l border-divider pl-2">
        {shown}
      </pre>
      {isLong && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[10px] text-ink-faint hover:text-ink-mute mt-0.5 pl-2"
        >
          {expanded ? "show less" : `show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

function formatJson(p: unknown): string {
  if (p == null) return "(empty)";
  if (typeof p === "string") return p;
  try {
    return JSON.stringify(p, null, 2);
  } catch {
    return String(p);
  }
}
