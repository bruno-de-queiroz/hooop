import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface InstalledPluginEntry {
  key: string;         // "<plugin>@<marketplace>"
  name: string;        // "<plugin>"
  marketplace: string; // "<marketplace>"
  version: string;
  installPath: string; // the ACTIVE version dir claude loads
}

/**
 * The plugins claude actually has installed, one entry per plugin, read from
 * `installed_plugins.json`. This is the single source of truth for the ACTIVE
 * version — the plugin cache can retain orphaned older versions after an update
 * (claude only GCs them ~7 days later), and walking the cache tree blindly
 * double-lists every skill/command of a plugin that has more than one version
 * on disk (the claude-mem duplication bug). Consumers that enumerate a plugin's
 * skills/commands should iterate these entries, not readdir the cache.
 */
export function readInstalledPluginEntries(): InstalledPluginEntry[] {
  const installed = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(installed)) return [];
  try {
    const body = JSON.parse(readFileSync(installed, "utf-8")) as {
      plugins?: Record<string, Array<{ installPath?: string; version?: string }>>;
    };
    const out: InstalledPluginEntry[] = [];
    for (const [key, entries] of Object.entries(body.plugins ?? {})) {
      const head = entries?.[0];
      if (!head?.installPath) continue;
      const [name, marketplace] = key.split("@");
      out.push({
        key,
        name: name ?? key,
        marketplace: marketplace ?? "",
        version: head.version ?? "?",
        installPath: head.installPath,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Return every plugin directory that claude subprocesses should `--plugin-dir`
 * onto. Two sources:
 *   1. The hooop runtime itself — mounted read-only at
 *      HOOOP_PLUGIN_ROOT inside the sandbox container (default
 *      /opt/hooop, so only root inside the container can reach it).
 *      This contains the hooks that emit events back
 *      to the sandbox, the skills the dashboard surfaces, etc. Without
 *      including it, a freshly-bootstrapped sandbox produces no hook events.
 *   2. Any other plugins the user installed into the sandbox profile via
 *      installed_plugins.json (claude-mem, code-graph backends, …). Installed
 *      via `/hooop:setup`, which runs `claude` inside the sandbox.
 *
 * Cached briefly so spawn isn't re-reading the file each turn.
 */
let _pluginDirsCache: { value: string[]; expiresAt: number } | null = null;
export function discoverInstalledPluginDirs(): string[] {
  const now = Date.now();
  if (_pluginDirsCache && _pluginDirsCache.expiresAt > now) {
    return _pluginDirsCache.value;
  }
  const dirs: string[] = [];

  // (1) The runtime plugin. Look up the canonical location via env (the
  // compose sets HOOOP_PLUGIN_ROOT=/opt/hooop), with a fallback
  // to that same default so the sandbox stays usable even if the env got
  // dropped. The dir is a valid plugin install when it has a
  // .claude-plugin/plugin.json — guard against that.
  const runtime = process.env.HOOOP_PLUGIN_ROOT || "/opt/hooop";
  if (existsSync(join(runtime, ".claude-plugin", "plugin.json"))) {
    dirs.push(runtime);
  }

  // (2) Any user-installed plugins in the sandbox profile.
  for (const { installPath } of readInstalledPluginEntries()) {
    if (existsSync(installPath) && !dirs.includes(installPath)) {
      dirs.push(installPath);
    }
  }
  _pluginDirsCache = { value: dirs, expiresAt: now + 10_000 };
  return dirs;
}
