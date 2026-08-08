"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Workflow, X } from "lucide-react";
import { useSSE } from "../useSSE";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { prettyModel, formatDuration } from "../lib/format";
import { Chip, IconButton, Readout, SectionTitle, SkeletonRows, StatusDot } from "../ui";
import { SlideOver } from "../ui/Overlay";

// Desktop-shell Sub-agents tree (Phase 3). Same data flow as the legacy
// AgentsPanel — /api/agents scoped to the selected session (canonical id or an
// alias), refreshed when a Task/Agent event streams in — presented with the
// primitives, and with the detail moved onto the shared SlideOver (backdrop,
// Esc, focus-trap) instead of the hand-rolled drawer.

interface AgentRun {
  id: number;
  sessionId: string | null;
  subagentType: string | null;
  model: string | null;
  prompt: string | null;
  description: string | null;
  startTs: string;
  endTs: string | null;
  durationMs: number | null;
  toolUseCount: number | null;
  result: string | null;
  parentAgentId: number | null;
  status: "running" | "completed";
}

export function AgentsRail() {
  const [agents, setAgents] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<number | null>(null);
  const { selectedId, aliases } = useSelectedSession();

  const inSession = (sid: string | null): boolean =>
    !!sid && !!selectedId && (sid === selectedId || aliases.includes(sid));
  const scoped = agents.filter((a) => inSession(a.sessionId));

  const refresh = useCallback(async () => {
    const r = await fetch("/api/agents?limit=100");
    if (r.ok) setAgents(await r.json());
    setLoading(false);
  }, []);

  // A busy turn spawns many Task/Agent events back-to-back. Refetching per
  // event hammered /api/agents and re-rendered the tree on every frame (the
  // stutter). Coalesce the SSE-driven refreshes onto a trailing debounce so a
  // burst collapses into one fetch once it settles; the fetch itself is async
  // and never blocks the main thread.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void refresh(), 350);
  }, [refresh]);

  useEffect(() => {
    void refresh();
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [refresh]);

  useSSE({
    event: (raw: unknown) => {
      const e = raw as { tool_name?: string | null };
      if (e?.tool_name === "Task" || e?.tool_name === "Agent") scheduleRefresh();
    },
  });

  const scopedIds = new Set(scoped.map((a) => a.id));
  const byParent: Map<number | null, AgentRun[]> = new Map();
  for (const a of scoped) {
    const parent =
      a.parentAgentId != null && scopedIds.has(a.parentAgentId) ? a.parentAgentId : null;
    const list = byParent.get(parent) ?? [];
    list.push(a);
    byParent.set(parent, list);
  }

  function Node({ agent, depth }: { agent: AgentRun; depth: number }) {
    const children = byParent.get(agent.id) ?? [];
    const subtitle = agent.description ?? agent.prompt ?? "";
    return (
      <li>
        <button
          onClick={() => setSelected(agent.id)}
          className="w-full text-left text-xs flex items-center gap-2 hover:bg-elevated px-1.5 py-1 rounded-[11px] transition-colors"
          style={{ paddingLeft: 8 + depth * 14 }}
          title={agent.subagentType ?? ""}
        >
          <StatusDot
            state={agent.status === "running" ? "live" : "wrap"}
            size="sm"
            pulse={agent.status === "running"}
            aria-label={agent.status}
          />
          <span className="font-mono text-ink-soft truncate shrink-0">
            {prettyModel(agent.model) ?? agent.subagentType ?? "Agent"}
          </span>
          <span className="text-ink-faint truncate flex-1">{subtitle.slice(0, 80)}</span>
          {agent.durationMs != null && (
            <Readout tone="mute" size="sm" className="shrink-0">
              {formatDuration(agent.durationMs)}
            </Readout>
          )}
        </button>
        {children.length > 0 && (
          <ul>
            {children.map((c) => (
              <Node key={c.id} agent={c} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const roots = byParent.get(null) ?? [];

  return (
    <section className="border-b border-divider p-3">
      <div className="flex items-center gap-2 px-1 mb-2">
        <Workflow className="w-3.5 h-3.5 text-ink-mute" />
        <SectionTitle className="flex-1">Sub-agents</SectionTitle>
        <Chip>{scoped.length}</Chip>
      </div>

      {loading ? (
        <SkeletonRows rows={3} chip={false} className="-mx-1 px-1" />
      ) : !selectedId ? (
        <p className="text-xs text-ink-faint px-1">Select a session to see its sub-agents.</p>
      ) : scoped.length === 0 ? (
        <p className="text-xs text-ink-faint px-1">
          No sub-agents in this session yet. Spawn one via the Agent tool to populate.
        </p>
      ) : (
        <ul className="max-h-[19rem] overflow-y-auto -mx-1 px-1">
          {roots.map((r) => (
            <Node key={r.id} agent={r} depth={0} />
          ))}
        </ul>
      )}

      <AgentDetailSlideOver id={selected} onClose={() => setSelected(null)} />
    </section>
  );
}

function AgentDetailSlideOver({ id, onClose }: { id: number | null; onClose: () => void }) {
  const [data, setData] = useState<AgentRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (id == null) return;
    setData(null);
    setError(null);
    fetch(`/api/agents/${id}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [id]);

  return (
    <SlideOver open={id != null} onClose={onClose} label="Agent detail">
      <div className="flex items-start justify-between gap-4 p-5 border-b border-divider shrink-0">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[17px] font-bold text-ink">
            <span className="text-direct">●</span> Agent
            {data?.model && (
              <span className="text-[13px] font-normal text-ink-mute truncate">
                {prettyModel(data.model)}
              </span>
            )}
          </h3>
          {data?.description && <p className="mt-1 text-[12px] text-ink-faint">{data.description}</p>}
        </div>
        <IconButton label="Close" size="sm" className="shrink-0" onClick={onClose}>
          <X className="w-4 h-4" />
        </IconButton>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-5">
        {error ? (
          <p className="text-xs text-fail">Error: {error}</p>
        ) : !data ? (
          <p className="text-xs text-ink-faint">Loading…</p>
        ) : (
          <>
            <div className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1.5 text-xs mb-4">
              <Label>status</Label>
              <Value>{data.status}</Value>
              {data.subagentType && (
                <>
                  <Label>type</Label>
                  <Value mono>{data.subagentType}</Value>
                </>
              )}
              {data.model && (
                <>
                  <Label>model</Label>
                  <Value mono>{data.model}</Value>
                </>
              )}
              {data.durationMs != null && (
                <>
                  <Label>duration</Label>
                  <Value mono>{formatDuration(data.durationMs)}</Value>
                </>
              )}
              {data.toolUseCount != null && (
                <>
                  <Label>tool uses</Label>
                  <Value mono>{data.toolUseCount}</Value>
                </>
              )}
              {data.sessionId && (
                <>
                  <Label>session</Label>
                  <Value mono>{data.sessionId.slice(0, 8)}…</Value>
                </>
              )}
            </div>

            {data.prompt && <Block title="Prompt" body={data.prompt} />}
            {data.result && <Block title="Result" body={data.result} tone="ink" />}
          </>
        )}
      </div>
    </SlideOver>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <SectionTitle className="text-[10px] pt-0.5">{children}</SectionTitle>;
}
function Value({ children, mono }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <span className={mono ? "font-mono text-ink-soft truncate tabular-nums" : "text-ink-soft truncate"}>
      {children}
    </span>
  );
}
function Block({ title, body, tone }: { title: string; body: string; tone?: "ink" }) {
  return (
    <div className="mb-4">
      <SectionTitle className="mb-1">{title}</SectionTitle>
      <div
        className={`text-[12px] whitespace-pre-wrap leading-relaxed border-l border-divider pl-3 ${
          tone === "ink" ? "text-ink" : "text-ink-soft"
        }`}
      >
        {body}
      </div>
    </div>
  );
}
