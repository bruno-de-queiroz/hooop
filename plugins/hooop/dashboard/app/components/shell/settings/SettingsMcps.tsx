"use client";
import { useEffect, useState } from "react";
import { ChevronRight, Plug } from "lucide-react";
import { SectionTitle } from "../../ui";
import { cn } from "../../ui/cn";

// Settings → Enabled MCPs (Phase 3). Same /api/mcps data + expand behavior as
// the legacy MCPsPanel, restyled to the mockup's Settings section exactly:
// section-title with plug icon + count chip, sunken rows with a wrap dot, mono
// name, transport chip (stdio=sdk / http=wrap / sse=direct), expand → detail
// grid (scope / command|url / env).

interface MCP {
  name: string;
  scope: "user" | "project";
  type: string;
  target: string;
  envKeys: string[];
  project?: string;
}

const TRANSPORT_TONE: Record<string, string> = {
  stdio: "bg-sdk/[0.16] text-sdk",
  http: "bg-wrap/[0.16] text-wrap",
  sse: "bg-direct/[0.16] text-direct",
};

function shortPath(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/").filter(Boolean);
  return parts.slice(-2).join("/");
}

export function SettingsMcps() {
  const [servers, setServers] = useState<MCP[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/mcps")
      .then((r) => (r.ok ? r.json() : { servers: [] }))
      .then((d) => setServers(d.servers ?? []))
      .finally(() => setLoading(false));
  }, []);

  return (
    <section>
      <div className="section-title mb-2 flex items-center gap-2">
        <Plug className="w-3.5 h-3.5" /> Enabled MCPs
        <span className="ml-1 rounded-[6px] bg-elevated px-1.5 py-0.5 font-mono text-[10px] text-ink-faint">
          {servers.length}
        </span>
      </div>

      {loading ? (
        <p className="text-xs text-ink-faint">Loading…</p>
      ) : servers.length === 0 ? (
        <p className="text-xs text-ink-faint">
          No MCP servers configured. Add one with{" "}
          <span className="font-mono text-ink-mute">claude mcp add</span> or via the setup wizard.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {servers.map((s) => {
            const key = `${s.scope}:${s.project ?? ""}:${s.name}`;
            const isOpen = expanded === key;
            return (
              <li
                key={key}
                className="rounded-control overflow-hidden bg-sunken border border-divider"
              >
                <button
                  onClick={() => setExpanded(isOpen ? null : key)}
                  aria-expanded={isOpen}
                  className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-left"
                >
                  <ChevronRight
                    className={cn(
                      "w-3.5 h-3.5 text-ink-mute shrink-0 transition-transform",
                      isOpen && "rotate-90",
                    )}
                  />
                  <span className="text-wrap shrink-0" title="configured">
                    ●
                  </span>
                  <span className="flex-1 min-w-0 font-mono text-ink-soft truncate" title={s.name}>
                    {s.name}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 rounded-[6px] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide",
                      TRANSPORT_TONE[s.type] ?? "bg-elevated text-ink-faint",
                    )}
                  >
                    {s.type}
                  </span>
                </button>
                {isOpen && (
                  <div className="px-3 pb-2.5 pl-9 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 text-[11px]">
                    <SectionTitle className="pt-0.5">scope</SectionTitle>
                    <span className="font-mono text-ink-soft">
                      {s.scope}
                      {s.project ? ` · ${shortPath(s.project)}` : ""}
                    </span>
                    <SectionTitle className="pt-0.5">{s.type === "stdio" ? "command" : "url"}</SectionTitle>
                    <span className="font-mono text-ink-soft break-all">{s.target}</span>
                    {s.envKeys.length > 0 && (
                      <>
                        <SectionTitle className="pt-0.5">env</SectionTitle>
                        <span className="font-mono text-ink-soft break-all">
                          {s.envKeys.join(", ")}
                        </span>
                      </>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
