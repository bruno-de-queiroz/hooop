"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Search, Sparkles, Loader2 } from "lucide-react";
import { useSelectedSession } from "../../context/SelectedSessionProvider";
import { useSessions } from "../../context/SessionsProvider";
import { useSSE } from "../useSSE";
import { isPeerClient, peerCapability, useMounted } from "../lib/participant";
import { Chip, SectionTitle, SkeletonRows } from "../ui";
import { cn } from "../ui/cn";

// Desktop-shell Skills launcher (Phase 3). Reuses the same data flow as the
// legacy SkillsPanel — /api/skills scoped to the selected session's cwd, live
// refetch on the `skills` SSE event — but presents with the primitives and the
// mockup's rail treatment. A skill run is now a REGULAR session: POST returns
// its { sessionId } and we snap straight to it (no run-id poll). Kept separate
// from SkillsPanel so the default dashboard stays frozen until the Phase 4 cutover.

interface Skill {
  name: string;
  description: string | null;
  source: "user" | "plugin";
  plugin?: string;
}

interface Status {
  state: "launching" | "ok" | "error";
  message: string;
}

export function SkillsRail() {
  const { selectedId, setSelected } = useSelectedSession();
  const { sessions } = useSessions();
  // Spectators watch only — skill runs are read-only for them (mount-gated for
  // hydration; the sandbox enforces the capability regardless).
  const spectator = useMounted() && isPeerClient() && peerCapability() === "spectate";
  const selectedCwd = selectedId
    ? sessions.find((s) => s.sessionId === selectedId)?.cwd ?? null
    : null;

  const [skills, setSkills] = useState<Skill[]>([]);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [picker, setPicker] = useState<string | null>(null);
  const [argInputs, setArgInputs] = useState<Record<string, string>>({});
  const [statuses, setStatuses] = useState<Record<string, Status>>({});

  const reqSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reqSeq.current;
    const url = selectedCwd ? `/api/skills?cwd=${encodeURIComponent(selectedCwd)}` : "/api/skills";
    try {
      const r = await fetch(url);
      const d: Skill[] = r.ok ? await r.json() : [];
      if (seq !== reqSeq.current) return;
      setSkills(d);
    } catch {
      /* leave prior list in place on transient error */
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [selectedCwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useSSE({ skills: () => void reload() });

  const q = filter.trim().toLowerCase();
  const shown = q
    ? skills.filter(
        (s) => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q),
      )
    : skills;

  function clearStatus(key: string, delayMs: number) {
    setTimeout(() => {
      setStatuses((m) => {
        const c = { ...m };
        delete c[key];
        return c;
      });
    }, delayMs);
  }

  async function run(key: string, name: string, args: string) {
    setStatuses((m) => ({ ...m, [key]: { state: "launching", message: "launching new session…" } }));
    setPicker(null);

    let resp: Response;
    try {
      resp = await fetch(`/api/skill/${encodeURIComponent(name)}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ args }),
      });
    } catch (e) {
      setStatuses((m) => ({ ...m, [key]: { state: "error", message: `network error: ${e}` } }));
      clearStatus(key, 5000);
      return;
    }

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      setStatuses((m) => ({
        ...m,
        [key]: { state: "error", message: `HTTP ${resp.status}: ${text.slice(0, 120)}` },
      }));
      clearStatus(key, 5000);
      return;
    }

    let sessionId: string | undefined;
    try {
      const body = (await resp.json()) as { sessionId?: string };
      sessionId = body?.sessionId;
    } catch {
      /* no body / not JSON */
    }

    if (sessionId) {
      setSelected(sessionId);
      setStatuses((m) => ({ ...m, [key]: { state: "ok", message: "opened new session ↗" } }));
    } else {
      setStatuses((m) => ({
        ...m,
        [key]: { state: "ok", message: "session launched — open it in Sessions ↗" },
      }));
    }
    clearStatus(key, 4000);
  }

  const statusTone = (s: Status["state"]) =>
    s === "ok" ? "text-wrap" : s === "error" ? "text-fail" : "text-live";

  return (
    <section className="border-b border-divider p-3">
      <div className="flex items-center gap-2 px-1 mb-2">
        <Sparkles className="w-3.5 h-3.5 text-ink-mute" />
        <SectionTitle className="flex-1">Skills</SectionTitle>
        <Chip>{skills.length}</Chip>
      </div>

      <div className="relative mb-2">
        <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-ink-mute pointer-events-none" />
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="filter skills…"
          className="field w-full text-[12px] pl-9 pr-3 py-2"
        />
      </div>

      {loading ? (
        <SkeletonRows rows={6} className="-mx-1 px-1" />
      ) : (
        <ul className="space-y-0.5 max-h-[19rem] overflow-y-auto -mx-1 px-1">
          {shown.map((s) => {
            const key = `${s.source}-${s.plugin ?? ""}-${s.name}`;
            const isPicking = picker === key;
            const args = argInputs[key] ?? "";
            const status = statuses[key];
            const colon = s.name.indexOf(":");
            const ns = colon >= 0 ? s.name.slice(0, colon) : null;
            const base = colon >= 0 ? s.name.slice(colon + 1) : s.name;
            return (
              <li key={key} className="text-xs">
                <div
                  className={cn(
                    "list-row group flex items-center gap-2 px-2 py-1.5",
                    isPicking && "is-active",
                  )}
                >
                  <button
                    onClick={() => setPicker(isPicking ? null : key)}
                    title={
                      spectator
                        ? "Spectating — read only"
                        : isPicking
                          ? "Hide form"
                          : `Run skill: ${s.name}`
                    }
                    aria-label={`Run skill ${s.name}`}
                    className="icon-btn w-6 h-6 shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
                    disabled={status?.state === "launching" || spectator}
                  >
                    {status?.state === "launching" ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-live" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    onClick={() => setPicker(isPicking ? null : key)}
                    className="flex-1 min-w-0 text-[12.5px] text-ink-soft text-left truncate"
                    title={`${s.name}${s.description ? `\n\n${s.description}` : ""}`}
                  >
                    {base}
                  </button>
                  {/* Namespace chip — lowercase mono, sdk text for a `user`
                    * skill, ink-faint for a plugin ns (matches the mockup). */}
                  <span
                    className={cn(
                      "chip font-mono text-[10px] px-1.5 py-0.5 shrink-0 max-w-[7rem] truncate",
                      ns ? "text-ink-faint" : "text-sdk",
                    )}
                    title={ns ?? "user"}
                  >
                    {ns ?? "user"}
                  </span>
                </div>

                {status && (
                  <p
                    className={cn("pl-6 pr-1 pb-1 text-[10px] truncate", statusTone(status.state))}
                    title={status.message}
                  >
                    {status.message}
                  </p>
                )}

                {isPicking && (
                  <div className="mx-1 mb-1 rounded-lg bg-sunken border border-divider p-2.5">
                    {s.description && (
                      <p className="text-[11px] text-ink-mute mb-2 leading-relaxed">
                        {s.description}
                      </p>
                    )}
                    <div
                      className="font-mono text-[10px] uppercase tracking-wide text-ink-faint mb-1.5 truncate"
                      title={`skill: ${s.name}`}
                    >
                      skill · {base}
                    </div>
                    <input
                      type="text"
                      autoFocus
                      value={args}
                      onChange={(e) => setArgInputs((m) => ({ ...m, [key]: e.target.value }))}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") run(key, s.name, args.trim());
                        else if (e.key === "Escape") setPicker(null);
                      }}
                      placeholder="args (optional)…"
                      className="field w-full text-[12px] px-2.5 py-1.5 mb-2 font-mono"
                    />
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setPicker(null)}
                        className="pill-btn text-[11px] px-2.5 py-1"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => run(key, s.name, args.trim())}
                        disabled={spectator}
                        title={spectator ? "Spectating — read only" : undefined}
                        className="accent-btn text-[11px] px-3 py-1 ml-auto disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        <Play className="w-3 h-3" /> Run
                      </button>
                    </div>
                    <p className="text-[11px] leading-snug text-ink-mute mt-2">
                      Spawns a new Claude session · watch it in the center pane
                    </p>
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
