import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface McpServer {
  name: string;
  scope: "user" | "project" | "plugin";
  type: string;
  target: string;
  envKeys: string[];
  project?: string;
  plugin?: string;
}

export interface McpsResponse {
  servers: McpServer[];
}

export function listMcps(): McpsResponse {
  const out: McpServer[] = [];

  out.push(...collectPluginMcps());

  const claudeJson = join(homedir(), ".claude.json");
  if (existsSync(claudeJson)) {
    try {
      const body = JSON.parse(readFileSync(claudeJson, "utf-8")) as Record<string, any>;
      for (const [name, conf] of Object.entries(body.mcpServers ?? {})) {
        out.push(normalize(name, conf as any, "user"));
      }
      for (const [proj, projConf] of Object.entries(body.projects ?? {})) {
        for (const [name, conf] of Object.entries((projConf as any)?.mcpServers ?? {})) {
          out.push({ ...normalize(name, conf as any, "project"), project: proj });
        }
      }
    } catch {
      // claude.json present but malformed; plugin MCPs still surface.
    }
  }

  out.sort((a, b) => {
    const rank = (m: McpServer) => (m.scope === "plugin" ? 0 : m.scope === "project" ? 1 : 2);
    return rank(a) - rank(b) || a.name.localeCompare(b.name);
  });
  return { servers: out };
}

function collectPluginMcps(): McpServer[] {
  const out: McpServer[] = [];
  const installed = join(homedir(), ".claude", "plugins", "installed_plugins.json");
  if (!existsSync(installed)) return out;

  let manifest: { plugins?: Record<string, Array<{ installPath?: string; version?: string }>> };
  try {
    manifest = JSON.parse(readFileSync(installed, "utf-8"));
  } catch {
    return out;
  }

  for (const [pluginKey, entries] of Object.entries(manifest.plugins ?? {})) {
    const head = entries?.[0];
    if (!head?.installPath || !isDir(head.installPath)) continue;
    const mcpJson = join(head.installPath, ".mcp.json");
    if (!existsSync(mcpJson)) continue;
    let body: Record<string, any>;
    try {
      body = JSON.parse(readFileSync(mcpJson, "utf-8"));
    } catch {
      continue;
    }
    const pluginName = pluginKey.split("@")[0] || pluginKey;
    for (const [name, conf] of Object.entries(body.mcpServers ?? {})) {
      out.push({ ...normalize(name, conf as any, "plugin"), plugin: pluginName });
    }
  }
  return out;
}

function normalize(name: string, conf: Record<string, unknown>, scope: McpServer["scope"]): McpServer {
  const type = String(conf.type ?? "stdio");
  const env = (conf.env ?? {}) as Record<string, unknown>;
  let target = "";
  if (type === "stdio") {
    const cmd = String(conf.command ?? "");
    const args = Array.isArray(conf.args) ? (conf.args as unknown[]).map(String) : [];
    target = [cmd, ...args].join(" ").trim();
  } else if (type === "http" || type === "sse") {
    target = String(conf.url ?? "");
  } else {
    target = JSON.stringify(conf);
  }
  return { name, scope, type, target, envKeys: Object.keys(env) };
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}
