"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Skill, SlashCommand } from "@/lib/sandbox-client";
import { useSelectedCwd } from "./useSelectedCwd";
import { useSSE } from "@/app/components/useSSE";

export interface AutocompleteEntry {
  /** Visible insertion text, including leading "/" or "@". e.g. "/hooop:setup", "@src/index.ts". */
  insert: string;
  /** Short label for the popover; usually identical to insert minus the prefix. */
  label: string;
  /** One-line subtext. */
  description: string | null;
  /** Used to colour the chip in the popover. */
  kind: "command" | "skill" | "builtin" | "file" | "dir";
  /** Source plugin/owner for the row, when meaningful. */
  source?: string | null;
  /** Capability the viewer needs for this command (mirrors SlashCommand.requires).
   * "permission" = host / full peer only; the composer hides it otherwise. */
  requires?: "permission" | null;
}

export interface CommandsValue {
  entries: AutocompleteEntry[];
  loading: boolean;
}

const CommandsContext = createContext<CommandsValue | null>(null);

// Builtins first, then plugin/project commands, then skills — alphabetical
// within each group. Without this, the handful of built-ins (`/plan`,
// `/model`, `/stop`, ...) can get sorted past a large plugin's namespace
// (e.g. many `claude-mem:*` commands) and fall off the composer's
// top-N slice for a bare "/", making them effectively invisible.
const KIND_RANK: Record<AutocompleteEntry["kind"], number> = {
  builtin: 0,
  command: 1,
  skill: 2,
  file: 3,
  dir: 3,
};

/**
 * Loads `/api/commands` and `/api/skills` once at mount and merges them
 * into a single autocomplete corpus. Shared by every `CommandAutocomplete`
 * instance, so the corpus is fetched exactly once per dashboard load.
 *
 * Refetches on the `skills` SSE event so a skill the agent authors inside the
 * sandbox (a SKILL.md written under a watched tree) shows up in autocomplete
 * without a reload. The event is a notification edge only — we always re-pull
 * both endpoints for the canonical corpus.
 */
export function CommandsProvider({ children }: { children: React.ReactNode }) {
  // Per Claude Code's discovery rule, skills + commands come from either
  // `~/.claude` (global) or `<cwd>/.claude` (project). Scope this corpus to
  // the active session's cwd so a project's bundled commands show up in
  // autocomplete when that session is selected.
  const selectedCwd = useSelectedCwd();

  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);

  // Monotonic request id: a slow in-flight load (e.g. fired on cwd change)
  // must not overwrite a newer one (e.g. a subsequent skills-changed refetch).
  const reqSeq = useRef(0);

  const reload = useCallback(async () => {
    const seq = ++reqSeq.current;
    try {
      const qs = selectedCwd ? `?cwd=${encodeURIComponent(selectedCwd)}` : "";
      const [cRes, sRes] = await Promise.all([
        fetch(`/api/commands${qs}`),
        fetch(`/api/skills${qs}`),
      ]);
      const c = cRes.ok ? ((await cRes.json()) as SlashCommand[]) : [];
      const s = sRes.ok ? ((await sRes.json()) as Skill[]) : [];
      if (seq !== reqSeq.current) return; // a newer reload superseded this one
      setCommands(c);
      setSkills(s);
    } finally {
      if (seq === reqSeq.current) setLoading(false);
    }
  }, [selectedCwd]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useSSE({ skills: () => void reload() });

  const entries = useMemo<AutocompleteEntry[]>(() => {
    const cmdEntries: AutocompleteEntry[] = commands.map((c) => ({
      insert: c.name.startsWith("/") ? c.name : `/${c.name}`,
      label: c.name.replace(/^\//, ""),
      description: c.description,
      kind: c.kind,
      source: c.plugin || null,
      requires: c.requires ?? null,
    }));
    // Skills not already in the command list (sandbox sometimes merges
    // them in /api/commands as kind="skill"; de-dupe by insert key).
    const seenInsert = new Set(cmdEntries.map((e) => e.insert));
    const skillEntries: AutocompleteEntry[] = skills
      .map((s): AutocompleteEntry => ({
        insert: `/${s.name}`,
        label: s.name,
        description: s.description,
        kind: "skill",
        source: s.plugin ?? (s.source === "user" ? "user" : null),
      }))
      .filter((e) => !seenInsert.has(e.insert));

    return [...cmdEntries, ...skillEntries].sort((a, b) => {
      const rankDiff = KIND_RANK[a.kind] - KIND_RANK[b.kind];
      return rankDiff !== 0 ? rankDiff : a.label.localeCompare(b.label);
    });
  }, [commands, skills]);

  const value = useMemo<CommandsValue>(() => ({ entries, loading }), [entries, loading]);

  return <CommandsContext.Provider value={value}>{children}</CommandsContext.Provider>;
}

export function useCommands(): CommandsValue {
  const ctx = useContext(CommandsContext);
  if (!ctx) throw new Error("useCommands must be used inside <CommandsProvider>");
  return ctx;
}
