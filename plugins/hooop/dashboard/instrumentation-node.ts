/**
 * Node-only instrumentation. Loaded by Next at boot under the nodejs runtime.
 * Loads ~/.claude/hooop/hooop.env (key=value lines), then primes the
 * sandbox client (opens its long-lived SSE channel to /events/stream) and
 * registers a SIGTERM/SIGINT drainer that closes the client cleanly.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { client } from "./lib/sandbox-client";
import { log } from "@shared/logger";
import { registerShutdown } from "@shared/shutdown";

try {
  const envFile = join(homedir(), ".claude", "hooop", "hooop.env");
  if (existsSync(envFile)) {
    const text = readFileSync(envFile, "utf-8");
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (!(key in process.env)) process.env[key] = value;
    }
  }
} catch (err) {
  log.warn("instrumentation", "could not load hooop.env", { err });
}

client.boot();

// TODO(prod): assumes Next 15 standalone runtime where Next owns the HTTP
// server's SIGTERM close. If wrapped in a custom server.js or pm2, Next's
// handler may not run; the force-exit timer below is the safety net
// (default 5000ms, overridable via HOOOP_DASHBOARD_FORCE_EXIT_MS).
const FORCE_EXIT_MS = Number(process.env.HOOOP_DASHBOARD_FORCE_EXIT_MS) || 5_000;

registerShutdown({
  drainer: async () => { client.shutdown(); },
  graceMs: FORCE_EXIT_MS,
  logger: log,
});
