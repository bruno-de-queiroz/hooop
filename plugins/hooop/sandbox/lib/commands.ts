import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listSkills, skillsBus } from "./skills";
import { parseFrontmatter } from "./frontmatter";
import { readInstalledPluginEntries } from "./plugin-paths";

export interface SlashCommand {
  name: string;        // e.g. "hooop:setup" or "model" (built-in)
  description: string | null;
  plugin: string;      // "hooop@hooop-marketplace", "skill:<plugin>", or "built-in"
  kind: "command" | "skill" | "builtin";
  /** Capability a viewer needs for this command to be usable. "permission" =
   * host or full-access peer (drive/spectate can't). Absent = anyone who can
   * type in the composer. The sandbox route stays authoritative; this only lets
   * the dashboard hide an unusable command from autocomplete. */
  requires?: "permission";
}

/**
 * Native Claude Code slash commands that are dispatched by claude itself in the
 * dashboard's `claude -p --input-format=stream-json` subprocess. Claude runs a
 * command only when the leading `/` is at byte 0 of the input frame — so the
 * sandbox MUST send these bare (see NATIVE_PASSTHROUGH_COMMANDS + writeUserTurn).
 * The `[Session context: …]` attribution line hooop prepends to ordinary turns
 * would push the slash off byte 0 and turn the command into inert chat (claude
 * just talks ABOUT it and burns a model turn). Verified empirically against
 * claude-code v2.1.218 in stream-json print mode.
 *
 * `/clear` and `/init` are deliberately absent: `/clear` wipes the conversation
 * (meaningless for hooop's persistent, resumable sessions) and `/init` writes a
 * CLAUDE.md — neither belongs in the dashboard's command surface.
 *
 * The TUI-only set (`/help`, `/login`, `/logout`, `/exit`) is also omitted —
 * claude rejects them with "<cmd> isn't available in this environment."
 */
const BUILTIN_COMMANDS: Array<{ name: string; description: string; requires?: "permission" }> = [
  { name: "compact", description: "Compact the conversation to free context" },
  { name: "cost",    description: "Show usage info for this session" },
  // hooop-intercepted: claude's built-in /plan is TUI-only, so the sandbox
  // handles `/plan [task]` itself — it flips the turn into plan mode so the
  // agent proposes a plan for dashboard approval (see writeUserTurn).
  { name: "plan",    description: "Propose a plan for approval (runs this turn in plan mode)" },
  // hooop-intercepted (client-side, in the Composer): `/stop` aborts the
  // in-flight turn, `/model <alias>` restarts the session on a new model, and
  // `/auto-mode [on|off]` toggles unattended auto-approval. None reach the
  // model — listed here purely so autocomplete offers them.
  { name: "stop",      description: "Interrupt the model's current turn" },
  { name: "model",     description: "Switch the model for this session (e.g. /model opus)" },
  // Auto mode gates on "permission" capability server-side (host / full peer) —
  // flag it so the dashboard hides it from a drive/spectate peer's autocomplete,
  // matching the header pill and permission bubble, which don't render for them.
  { name: "auto-mode", description: "Toggle unattended auto-approval (/auto-mode on|off)", requires: "permission" },
];

/**
 * Native claude commands the sandbox forwards to the subprocess VERBATIM (bare,
 * slash at byte 0) so claude's non-interactive dispatcher runs them, instead of
 * wrapping them in the per-turn attribution prefix that would neutralise them.
 * These are harness commands (they act on the session, not the conversation),
 * so dropping the "who sent this" prefix is correct — attribution for the
 * request is carried by the synthesized command echo in the transcript.
 *
 * Only claude-native, non-intercepted commands belong here. `/plan`, `/stop`,
 * `/model` and `/auto-mode` are handled by hooop (mode flip / kill+resume /
 * toggle) and must NOT be passed through.
 */
export const NATIVE_PASSTHROUGH_COMMANDS: ReadonlySet<string> = new Set(["compact", "cost"]);

/**
 * Enumerate every slash-invokable thing the dashboard's autocomplete should
 * offer: plugin commands (`<plugin>:<cmd>`), plugin skills (`<plugin>:<skill>`),
 * and built-in commands (`/model`, `/help`, ...).
 *
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/[file].md
 *   ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/[skill]/SKILL.md
 */
// Result cache — like listSkills, this walks the plugin-cache tree with
// synchronous fs on every call (and used to walk the skills tree a second time
// via listSkills). Cached per cwd, invalidated by the same skillsBus watcher
// that covers the shared plugin-cache tree, plus a coarse TTL safety net.
const COMMANDS_CACHE_TTL_MS = 30_000;
let _commandsEpoch = 0;
const _commandsCache = new Map<string, { epoch: number; at: number; value: SlashCommand[] }>();
skillsBus.on("change", () => { _commandsEpoch++; _commandsCache.clear(); });

export function listSlashCommands(cwd?: string | null): SlashCommand[] {
  const key = cwd ?? "";
  const now = Date.now();
  const hit = _commandsCache.get(key);
  if (hit && hit.epoch === _commandsEpoch && now - hit.at < COMMANDS_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = computeSlashCommands(cwd);
  _commandsCache.set(key, { epoch: _commandsEpoch, at: now, value });
  return value;
}

function computeSlashCommands(cwd?: string | null): SlashCommand[] {
  const out: SlashCommand[] = [];

  // Plugin commands. Iterate the INSTALLED plugin entries (one active version
  // each) rather than readdir-ing every version dir under the cache — the cache
  // retains orphaned older versions after an update, and walking them all
  // double-lists a plugin's commands (the claude-mem duplication).
  for (const { key, name: pluginName, installPath } of readInstalledPluginEntries()) {
    const cmdDir = join(installPath, "commands");
    if (!isDir(cmdDir)) continue;
    for (const file of safeReaddir(cmdDir)) {
      if (!file.endsWith(".md")) continue;
      const base = file.slice(0, -3);
      const fm = parseFrontmatter(join(cmdDir, file));
      out.push({
        name: `${pluginName}:${base}`,
        description: (fm.description as string) ?? null,
        plugin: key,
        kind: "command",
      });
    }
  }

  // Project-level commands live at `<cwd>/.claude/commands/*.md` per
  // Claude Code's discovery convention. Only collected when the caller
  // passes a cwd (per-session autocomplete); the global /commands listing
  // doesn't have a cwd context.
  if (cwd) {
    const projectCmdDir = join(cwd, ".claude", "commands");
    if (isDir(projectCmdDir)) {
      for (const file of safeReaddir(projectCmdDir)) {
        if (!file.endsWith(".md")) continue;
        const base = file.slice(0, -3);
        const fm = parseFrontmatter(join(projectCmdDir, file));
        out.push({
          name: base,
          description: (fm.description as string) ?? null,
          plugin: "project",
          kind: "command",
        });
      }
    }
  }

  // Skills — invokable via `/<plugin>:<skill>` just like commands in the TUI.
  for (const s of listSkills(cwd)) {
    out.push({
      name: s.name,
      description: s.description,
      plugin: s.plugin ?? "user-skill",
      kind: "skill",
    });
  }

  // Built-ins
  for (const b of BUILTIN_COMMANDS) {
    out.push({
      name: b.name,
      description: b.description,
      plugin: "built-in",
      kind: "builtin",
      ...(b.requires ? { requires: b.requires } : {}),
    });
  }

  // Defensive dedupe by kind+name (a skill and a command can legitimately share
  // a name, so kind is part of the key). The installed-version pinning above
  // already removes cross-version dupes; this guards any residual collision.
  const seen = new Set<string>();
  return out
    .filter((c) => {
      const k = `${c.kind}\u0000${c.name}`;
      return seen.has(k) ? false : (seen.add(k), true);
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function safeReaddir(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
