import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface InstalledPlugin {
  key: string;
  name: string;
  marketplace: string;
  version: string;
  installedAt: string;
}

export interface StackResponse {
  plugins: InstalledPlugin[];
  memory: { plugin: string; version: string } | null;
  installLog: { exists: boolean; lines: number; summary: Record<string, string> };
}

export function getStack(): StackResponse {
  const plugins = readInstalledPlugins();
  const memory = pickMemoryPlugin(plugins);
  const installLog = readInstallLog();
  return { plugins, memory, installLog };
}

function readInstalledPlugins(): InstalledPlugin[] {
  const path = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(path)) return [];
  try {
    const body = JSON.parse(readFileSync(path, "utf-8")) as {
      plugins?: Record<string, Array<{ version?: string; installedAt?: string }>>;
    };
    const out: InstalledPlugin[] = [];
    for (const [key, entries] of Object.entries(body.plugins ?? {})) {
      const [name, marketplace] = key.split("@");
      const head = entries?.[0];
      if (!head) continue;
      out.push({
        key,
        name: name ?? key,
        marketplace: marketplace ?? "",
        version: head.version ?? "?",
        installedAt: head.installedAt ?? "",
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

// claude-mem is hooop's only supported memory backend (the sole store the
// dashboard Summary rail reads), so detection targets it specifically.
function pickMemoryPlugin(plugins: InstalledPlugin[]) {
  const hit = plugins.find((p) => p.name.toLowerCase() === "claude-mem");
  return hit ? { plugin: hit.name, version: hit.version } : null;
}

function readInstallLog(): StackResponse["installLog"] {
  const path = join(homedir(), ".claude", "hooop", "install-log.md");
  if (!existsSync(path)) {
    return { exists: false, lines: 0, summary: {} };
  }
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { exists: false, lines: 0, summary: {} };
  }
  const lines = text.split("\n");
  const summary: Record<string, string> = {};
  let currentLayer: string | null = null;
  for (const raw of lines) {
    const line = raw.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      currentLayer = heading[1].trim();
      continue;
    }
    const picked = line.match(/^[-*]\s*(?:Picked|Choice|Selected):\s*(.+)$/i);
    if (picked && currentLayer) {
      summary[currentLayer] = picked[1].trim();
    }
  }
  return { exists: true, lines: lines.length, summary };
}
