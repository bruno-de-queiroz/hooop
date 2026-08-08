"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Search, TriangleAlert, X } from "lucide-react";
import { ShellEventDetail } from "./ShellEventDetail";
import { cn } from "../ui/cn";

// Desktop-shell search (Phase 3). The `.field` title-bar trigger + ⌘K modal,
// matching the mockup exactly: a live warning banner when semantic is
// unavailable, the search input with bm25 / semantic / hybrid `.tab` toggles,
// and result rows that expand into ShellEventDetail. Same /api/search flow and
// keyboard handling as the old SearchBar (removed at the Phase 4 cutover).

type SearchType = "bm25" | "semantic" | "hybrid";

interface SearchResult {
  id: number;
  ts: string;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  score: number;
}
interface SearchMeta {
  bm25_used?: boolean;
  semantic_used?: boolean;
  semantic_unavailable?: string;
}
interface EventDetail {
  id: number;
  ts: string;
  session_id: string | null;
  hook_type: string | null;
  tool_name: string | null;
  text: string | null;
  payload: unknown;
}

/** Hook → cue token (mirrors DESIGN.md state vocabulary). */
function hookTone(hook: string): string {
  switch (hook) {
    case "PreToolUse": return "bg-sdk/[0.16] text-sdk";
    case "PostToolUse": return "bg-wrap/[0.16] text-wrap";
    case "UserPromptSubmit": return "bg-direct/[0.16] text-direct";
    case "SessionStart": return "bg-live/[0.16] text-live";
    case "Stop": return "bg-fail/[0.16] text-fail";
    default: return "bg-elevated text-ink-faint";
  }
}

function parseText(text: string | null): Array<[string, string]> {
  if (!text) return [];
  const parts = text.split(" | ").map((s) => s.trim()).filter(Boolean);
  const out: Array<[string, string]> = [];
  for (const part of parts) {
    if (part.startsWith("[") && part.endsWith("]")) continue;
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "tool") continue;
    out.push([k, v.length > 240 ? v.slice(0, 240) + "…" : v]);
  }
  return out;
}

export function ShellSearch() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [type, setType] = useState<SearchType>("hybrid");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [meta, setMeta] = useState<SearchMeta | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [details, setDetails] = useState<Record<number, EventDetail>>({});
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (!q.trim()) {
      setResults([]);
      setMeta(null);
      return;
    }
    const controller = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch("/api/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, type, limit: 50 }),
          signal: controller.signal,
        });
        const data = await r.json();
        setResults(data.results ?? []);
        setMeta(data.meta ?? null);
      } catch (err) {
        if ((err as { name?: string })?.name !== "AbortError") console.error(err);
      } finally {
        setLoading(false);
      }
    }, 200);
    return () => {
      clearTimeout(t);
      controller.abort();
    };
  }, [q, type]);

  async function toggle(r: SearchResult) {
    if (expanded === r.id) {
      setExpanded(null);
      return;
    }
    setExpanded(r.id);
    if (details[r.id]) return;
    try {
      const resp = await fetch(`/api/events/${r.id}`);
      if (resp.ok) {
        const d: EventDetail = await resp.json();
        setDetails((prev) => ({ ...prev, [r.id]: d }));
      }
    } catch {
      /* ignore */
    }
  }

  const semanticDisabled = useMemo(
    () => Boolean(meta?.semantic_unavailable) && (type === "semantic" || type === "hybrid"),
    [meta, type],
  );

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="field flex items-center gap-2 text-[11px] text-ink-mute px-2.5 py-1.5 hover:text-ink-soft"
        title="Search (⌘K)"
      >
        <Search className="w-3.5 h-3.5" />
        <span>Search…</span>
        <span className="chip ml-1 font-mono text-[10px] px-1.5 py-0.5">⌘K</span>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[90] flex items-start justify-center pt-20 bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="w-full max-w-3xl rounded-xl overflow-hidden flex flex-col max-h-[70vh] bg-window border border-divider shadow-overlay">
            {semanticDisabled && (
              <div className="flex items-center gap-2 px-3 py-2 text-[11px] bg-live/15 border-b border-live/30 text-live">
                <TriangleAlert className="w-3.5 h-3.5 shrink-0" />
                <span className="font-medium">Semantic disabled — falling back to BM25.</span>
                <span className="ml-auto truncate hidden sm:inline text-live/70">
                  set <span className="font-mono">EMBEDDING_BASE_URL</span> or{" "}
                  <span className="font-mono">OPENAI_API_KEY</span>
                </span>
              </div>
            )}

            <div className="flex items-center gap-2 px-3 py-2.5 border-b border-divider shrink-0">
              <Search className="w-4 h-4 text-ink-mute" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search events…"
                className="flex-1 bg-transparent border-0 outline-none text-[14px] text-ink placeholder:text-ink-hush"
              />
              <div className="flex items-center gap-1 text-[10px]">
                {/* Fixed-size slot so the tabs never shift when loading toggles
                    on each keystroke — only the icon inside appears/disappears. */}
                <span
                  className="w-3.5 h-3.5 flex items-center justify-center shrink-0"
                  aria-hidden={!loading}
                >
                  {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-ink-mute" />}
                </span>
                {(["bm25", "semantic", "hybrid"] as SearchType[]).map((t) => {
                  const blocked =
                    (t === "semantic" || t === "hybrid") && Boolean(meta?.semantic_unavailable);
                  return (
                    <button
                      key={t}
                      onClick={() => setType(t)}
                      title={blocked ? "Semantic not configured — using BM25 only" : `Switch to ${t}`}
                      className={cn("tab px-2 py-0.5", type === t && "is-on", blocked && "opacity-60")}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>
              <button
                onClick={() => setOpen(false)}
                className="icon-btn w-8 h-8"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <ul className="flex-1 overflow-y-auto">
              {q.trim() && !loading && results.length === 0 && (
                <li className="text-xs text-ink-faint p-4">No results.</li>
              )}
              {results.map((r, i) => {
                const parsed = parseText(r.text);
                const isOpenRow = expanded === r.id;
                return (
                  <li key={r.id} className={cn("text-[12px]", i > 0 && "border-t border-divider")}>
                    <button
                      onClick={() => toggle(r)}
                      className="w-full text-left px-3 py-2 flex flex-col gap-1 hover:bg-elevated"
                    >
                      <div className="flex items-center gap-2">
                        {isOpenRow ? (
                          <ChevronDown className="w-3 h-3 text-ink-mute shrink-0" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-ink-mute shrink-0" />
                        )}
                        <span className="font-mono text-[10px] text-ink-faint tabular-nums">
                          {r.ts.slice(11, 19)}
                        </span>
                        {r.hook_type && (
                          <span
                            className={cn(
                              "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide",
                              hookTone(r.hook_type),
                            )}
                          >
                            {r.hook_type}
                          </span>
                        )}
                        {r.tool_name && <span className="font-mono text-ink-soft">{r.tool_name}</span>}
                        <span className="ml-auto font-mono text-[10px] text-ink-faint tabular-nums">
                          {(r.score ?? 0).toFixed(3)}
                        </span>
                      </div>
                      {parsed.length > 0 && (
                        <div className="pl-5 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5">
                          {parsed.map(([k, v], idx) => (
                            <div key={idx} className="contents">
                              <span className="font-mono text-[10px] text-ink-faint">{k}</span>
                              <span className="text-ink-mute truncate" title={v}>
                                {v}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </button>
                    {isOpenRow && (
                      <div className="px-3 pb-3 pl-8">
                        <ShellEventDetail detail={details[r.id]} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </>
  );
}
