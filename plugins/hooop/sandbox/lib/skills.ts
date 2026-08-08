import { existsSync, mkdirSync, readdirSync, statSync, type FSWatcher } from "node:fs";
import { watchSafe } from "./watch-safe";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { CLAUDE_SKILLS_DIR, WORKSPACE_DIR } from "./paths";
import { parseFrontmatter } from "./frontmatter";
import { readInstalledPluginEntries } from "./plugin-paths";

export interface Skill {
  name: string;
  description: string | null;
  path: string;
  source: "user" | "plugin";
  plugin?: string;
}

function collectSkillsFromDir(dir: string, source: "user" | "plugin", plugin?: string): Skill[] {
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    try {
      if (!statSync(sub).isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMd = join(sub, "SKILL.md");
    if (!existsSync(skillMd)) continue;
    const fm = parseFrontmatter(skillMd);
    // The directory name is the invocation token — that's what Claude
    // resolves when a session calls `/<plugin>:<skill>`. The frontmatter
    // `name:` is informational and can legally diverge (e.g. claude-mem's
    // `version-bump/` ships with name=`claude-code-plugin-release`), so
    // surfacing the frontmatter name would mismatch what actually runs.
    out.push({
      name,
      description: (fm.description as string) ?? null,
      path: skillMd,
      source,
      ...(plugin ? { plugin } : {}),
    });
  }
  return out;
}

function collectPluginSkills(): Skill[] {
  // Skills live under <installPath>/skills/<skill>/SKILL.md. Iterate the
  // INSTALLED plugin entries (one active version each) rather than readdir-ing
  // the cache tree: the cache can hold orphaned older versions after an update,
  // and walking every version dir double-lists a plugin's skills (the claude-mem
  // duplication). installed_plugins.json is exactly what claude loads.
  const out: Skill[] = [];
  for (const { key, installPath } of readInstalledPluginEntries()) {
    const skillsDir = join(installPath, "skills");
    if (!existsSync(skillsDir)) continue;
    out.push(...collectSkillsFromDir(skillsDir, "plugin", key));
  }
  return out;
}

/**
 * Project-level skills live at `<cwd>/.claude/skills/` per Claude Code's
 * discovery convention. The dashboard surfaces them so the autocomplete
 * for a session in `/workspace/foo` includes any skills the project ships
 * alongside its code. Without a cwd we only return user-global skills.
 */
export function collectProjectSkills(cwd: string | null | undefined): Skill[] {
  if (!cwd) return [];
  return collectSkillsFromDir(join(cwd, ".claude", "skills"), "user");
}

// Result cache for listSkills — the computation walks the whole plugin-cache
// tree with synchronous fs on every call, which blocks the single-threaded
// sandbox event loop (and /commands calls it too). Cache per cwd (project
// skills depend on cwd), invalidated by the skillsBus fs-watcher on any
// SKILL.md change, plus a coarse TTL as a safety net for changes the watcher
// doesn't cover (e.g. a plugin install under the cache root).
const SKILLS_CACHE_TTL_MS = 30_000;
let _skillsEpoch = 0;
const _skillsCache = new Map<string, { epoch: number; at: number; value: Skill[] }>();

/** Drop the memoized skill lists (called by the skillsBus watcher). */
export function invalidateSkillsCache(): void {
  _skillsEpoch++;
  _skillsCache.clear();
}

export function listSkills(cwd?: string | null): Skill[] {
  const key = cwd ?? "";
  const hit = _skillsCache.get(key);
  const now = Date.now();
  if (hit && hit.epoch === _skillsEpoch && now - hit.at < SKILLS_CACHE_TTL_MS) {
    return hit.value;
  }
  const value = computeSkills(cwd);
  _skillsCache.set(key, { epoch: _skillsEpoch, at: now, value });
  return value;
}

function computeSkills(cwd?: string | null): Skill[] {
  const user = collectSkillsFromDir(CLAUDE_SKILLS_DIR, "user");
  const project = collectProjectSkills(cwd);
  const plugin = collectPluginSkills();

  // Namespace plugin skills the same way Claude Code's /skills UI does:
  // `<plugin-name>:<skill-name>`. Our `plugin` field is "<name>@<marketplace>";
  // strip the marketplace.
  const pluginNamespaced = plugin.map((p) => {
    const ns = (p.plugin ?? "").split("@")[0];
    const base = p.name; // raw skill directory name
    return ns ? { ...p, name: `${ns}:${base}`, baseName: base } : { ...p, baseName: base };
  });

  // De-duplicate: Step 7 of the setup wizard used to copy plugin skill SKILL.md
  // files into ~/.claude/skills/ for convenience. With plugin namespaces those
  // copies are redundant — drop user-level skills whose directory name matches
  // any plugin skill, so the dashboard count matches Claude's TUI.
  const pluginBaseNames = new Set(pluginNamespaced.map((p) => (p as any).baseName as string));
  const filteredUser = user.filter((u) => !pluginBaseNames.has(u.name));
  // Project skills shadow user-level ones with the same name (Claude TUI
  // behavior: the closer scope wins). They keep their bare name — no
  // namespace prefix, since a project-level skill is invoked as `/foo`.
  const projectNames = new Set(project.map((p) => p.name));
  const filteredUserAfterProject = filteredUser.filter((u) => !projectNames.has(u.name));

  // Final dedupe by the invocation name, keeping the first occurrence (user →
  // project → plugin precedence above). collectPluginSkills already pins one
  // version per plugin, so this is a safety net against any residual collision
  // rather than the primary fix — but it guarantees the dashboard never shows
  // the same `/name` twice.
  const seen = new Set<string>();
  return [...filteredUserAfterProject, ...project, ...pluginNamespaced]
    .map(({ baseName, ...rest }: any) => rest as Skill)
    .filter((s) => (seen.has(s.name) ? false : (seen.add(s.name), true)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Push-based skill-change notifications. Subscribers receive a "change" event
 * whenever a SKILL.md (or its containing dir) is created, edited, or removed
 * under a watched skills tree. The sandbox /events/stream handler relays these
 * to the dashboard, which treats them as a refetch edge (re-pulls /api/skills
 * and /api/commands) rather than trusting an event payload — mirroring the
 * `sessionsBus` pattern.
 */
export const skillsBus = new EventEmitter();
skillsBus.setMaxListeners(100);
// Any skills-tree change invalidates the listSkills/listSlashCommands caches.
skillsBus.on("change", invalidateSkillsCache);

let _skillsWatchers: FSWatcher[] = [];
let _skillsWatchStarted = false;
let _skillsEmitTimer: ReturnType<typeof setTimeout> | null = null;

// fs.watch fires multiple raw events per logical change (a rename then a
// change, or several for an atomic write), and an agent scaffolding a handful
// of skills in one turn would otherwise storm the bus. Coalesce into one emit
// per quiet window so each consumer refetches at most once per burst.
const SKILLS_EMIT_DEBOUNCE_MS = 120;

function emitSkillsChangeDebounced() {
  if (_skillsEmitTimer) clearTimeout(_skillsEmitTimer);
  _skillsEmitTimer = setTimeout(() => {
    _skillsEmitTimer = null;
    skillsBus.emit("change");
  }, SKILLS_EMIT_DEBOUNCE_MS);
  _skillsEmitTimer.unref?.();
}

// ── Per-cwd project-skill watchers (Phase 2) ────────────────────────────────
// Keyed by project cwd. Each entry watches either the cwd's `.claude/skills`
// dir recursively (when it exists) or the nearest existing ancestor
// non-recursively (to detect that dir being created), re-arming deeper as the
// tree materializes. Reconciled against the set of active-session cwds so
// watchers for ended sessions are released.
interface ProjectWatch { watcher: FSWatcher; watching: string }
const _projectWatchers = new Map<string, ProjectWatch>();

function closeProjectWatch(cwd: string): void {
  const e = _projectWatchers.get(cwd);
  if (e) {
    try { e.watcher.close(); } catch { /* ignore */ }
    _projectWatchers.delete(cwd);
  }
}

// Arm (or re-arm) the watcher for one project cwd. Watches the deepest path
// that currently exists along cwd → .claude → skills. On ancestor events it
// re-arms toward `skills` once the tree gets deeper, and only emits a change
// when the skills dir itself is implicated — so unrelated file churn in a busy
// project root doesn't trigger dashboard refetches.
function armProjectWatcher(cwd: string): void {
  const skillsDir = join(cwd, ".claude", "skills");
  const dotClaude = join(cwd, ".claude");
  const existing = _projectWatchers.get(cwd);

  if (existsSync(skillsDir)) {
    if (existing?.watching === skillsDir) return; // already watching the target
    closeProjectWatch(cwd);
    try {
      const w = watchSafe(skillsDir, { recursive: true }, () => emitSkillsChangeDebounced());
      _projectWatchers.set(cwd, { watcher: w, watching: skillsDir });
    } catch { /* recursive unsupported / transient */ }
    return;
  }

  // skills dir not present yet — watch the nearest existing ancestor to detect
  // it appearing, then re-arm. Ancestor watches are NON-recursive: a recursive
  // watch on a whole project root would fire on every unrelated file.
  const ancestor = existsSync(dotClaude) ? dotClaude : (existsSync(cwd) ? cwd : null);
  if (!ancestor) return;                       // cwd doesn't exist; nothing to arm
  if (existing?.watching === ancestor) return; // already armed on this ancestor
  closeProjectWatch(cwd);
  try {
    const w = watchSafe(ancestor, { recursive: false }, () => {
      // React only when the tree advanced toward the skills dir.
      const deeper = existsSync(skillsDir) || (ancestor === cwd && existsSync(dotClaude));
      if (deeper) { armProjectWatcher(cwd); emitSkillsChangeDebounced(); }
    });
    _projectWatchers.set(cwd, { watcher: w, watching: ancestor });
  } catch { /* transient */ }
}

/**
 * Reconcile the per-cwd project-skill watchers to `cwds` (plus the workspace,
 * always). Arms watchers for newly-seen cwds and closes watchers for cwds no
 * longer present. Cheap to call frequently (a set diff); the fs.watch handles
 * are only opened/closed on actual set changes, and arming an already-correct
 * watcher is a no-op.
 */
export function syncProjectSkillWatchers(cwds: Iterable<string>): void {
  const desired = new Set<string>([WORKSPACE_DIR]);
  for (const c of cwds) if (c) desired.add(c);
  for (const cwd of [..._projectWatchers.keys()]) {
    if (!desired.has(cwd)) closeProjectWatch(cwd);
  }
  for (const cwd of desired) armProjectWatcher(cwd);
}

/**
 * Watch the skill source trees and emit a (debounced) `skillsBus` "change" on
 * any mutation. Idempotent — safe to call from multiple entry points.
 *
 * RECURSIVE is required: skills are nested as `<root>/<name>/SKILL.md`, so a
 * non-recursive watch on the root would see the `<name>/` dir appear but miss
 * the SKILL.md write inside it (and a fresh skill wouldn't list until some
 * later refetch). Node's recursive fs.watch on Linux landed in 20.13; the
 * sandbox image is node:24, so it's available here. If a watch throws
 * (recursive unsupported, transient error), we skip that root — the list still
 * refreshes on the existing fetch triggers (session/cwd change, page reload).
 *
 * Watches the global `~/.claude/skills` statically (created if absent so its
 * watch is always armed) and seeds the per-cwd project registry with the
 * default workspace. server.ts keeps the registry in sync with live/dormant
 * session cwds via `syncProjectSkillWatchers`.
 */
export function startSkillsWatcher(): void {
  if (_skillsWatchStarted) return;
  _skillsWatchStarted = true;

  try { mkdirSync(CLAUDE_SKILLS_DIR, { recursive: true }); } catch { /* ignore */ }
  try {
    _skillsWatchers.push(watchSafe(CLAUDE_SKILLS_DIR, { recursive: true }, () => emitSkillsChangeDebounced()));
  } catch {
    // recursive unsupported on this platform/version, or a transient error.
  }

  // Seed the project registry (always includes the workspace cwd).
  syncProjectSkillWatchers([]);
}

export function stopSkillsWatcher(): void {
  for (const w of _skillsWatchers) {
    try { w.close(); } catch { /* ignore */ }
  }
  _skillsWatchers = [];
  for (const cwd of [..._projectWatchers.keys()]) closeProjectWatch(cwd);
  _skillsWatchStarted = false;
  if (_skillsEmitTimer) { clearTimeout(_skillsEmitTimer); _skillsEmitTimer = null; }
}
