"use client";
import { useEffect, useState } from "react";
import { Brain, Layers } from "lucide-react";
import { SectionTitle } from "../../ui";

// Settings → Stack (Phase 3). Same /api/stack data as the legacy StackPanel,
// restyled to the mockup's Settings section: shared-memory sunken card, a
// "Setup picks" label→value list, and an "Installed plugins" name→version list.

interface InstalledPlugin {
  key: string;
  name: string;
  marketplace: string;
  version: string;
  installedAt: string;
}

interface Stack {
  plugins: InstalledPlugin[];
  memory: { plugin: string; version: string } | null;
  installLog: { exists: boolean; lines: number; summary: Record<string, string> };
}

export function SettingsStack() {
  const [stack, setStack] = useState<Stack | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/stack")
      .then((r) => (r.ok ? r.json() : null))
      .then(setStack)
      .finally(() => setLoading(false));
  }, []);

  const wizardPicks = stack ? Object.entries(stack.installLog.summary) : [];

  return (
    <section>
      <div className="section-title mb-2 flex items-center gap-2">
        <Layers className="w-3.5 h-3.5" /> Stack
      </div>

      {loading ? (
        <p className="text-xs text-ink-faint">Loading…</p>
      ) : !stack ? (
        <p className="text-xs text-ink-faint">Stack unavailable.</p>
      ) : (
        <>
          {/* Shared memory */}
          <div className="rounded-control bg-sunken border border-divider px-4 py-3 mb-2.5">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-ink-faint mb-0.5">
              <Brain className="w-3 h-3" /> Shared memory
            </div>
            {stack.memory ? (
              <div className="font-mono text-[13px] text-ink-soft">
                {stack.memory.plugin}
                <span className="text-ink-faint ml-1">v{stack.memory.version}</span>
              </div>
            ) : (
              <div className="text-xs text-ink-faint">
                None configured. Run <span className="font-mono text-ink-mute">/hooop:setup</span> to
                pick one.
              </div>
            )}
          </div>

          {wizardPicks.length > 0 && (
            <>
              <SectionTitle className="mb-1.5">Setup picks</SectionTitle>
              <ul className="space-y-1 mb-3">
                {wizardPicks.map(([layer, pick]) => (
                  <li key={layer} className="flex items-center gap-2 px-1 text-[12px]">
                    <span className="text-ink-faint w-24 shrink-0 truncate">{layer}</span>
                    <span className="font-mono text-ink-soft truncate" title={pick}>
                      {pick}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <SectionTitle className="mb-1.5">Installed plugins</SectionTitle>
          {stack.plugins.length === 0 ? (
            <p className="text-xs text-ink-faint px-1">No plugins installed yet.</p>
          ) : (
            <ul className="space-y-1">
              {stack.plugins.map((p) => (
                <li key={p.key} className="flex items-center gap-2 px-1 text-[12.5px]">
                  <span className="font-mono text-ink-soft flex-1 truncate" title={p.key}>
                    {p.name}
                  </span>
                  <span className="font-mono text-ink-faint text-[11px]">v{p.version}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
