import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, chownSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { HOOK_TOKEN_FILE, SANDBOX_TOKEN_FILE } from "./lib/paths";
import { log } from "@shared/logger";

const TOKEN_LEN_BYTES = 32;

export const SANDBOX_TOKEN_HEADER = "x-sandbox-token";
export const HOOK_TOKEN_HEADER = "x-hook-token";

/**
 * Group each token file is chowned to. Two audiences, two groups, which is the
 * point of the uid split: `hooopctl` gates the control plane and the model's uid
 * is NOT in it, while `hooop` is shared with the model because the hook scripts
 * run as `agent` and must read the hook token.
 *
 * Env-overridable (and matched to server.ts's socket gids) rather than the
 * hardcoded 1100 this used to carry — a literal here would have silently
 * reinstated the model's read access to the control token.
 */
const CONTROL_GID = parseInt(process.env.HOOOP_CONTROL_SOCKET_GID ?? "", 10) || 1101;
const HOOK_GID = parseInt(process.env.HOOOP_HOOK_SOCKET_GID ?? "", 10) || 1100;

let cachedSandbox: string | null = null;
let cachedHook: string | null = null;

/**
 * Per-install random token for dashboard <-> sandbox auth. Generated on first
 * sandbox start, persisted at a known path the dashboard can read, reused on
 * subsequent boots. The dashboard re-reads the file lazily (on 401 retry) so
 * rotation across a sandbox restart is transparent.
 */
export function sandboxToken(): string {
  if (cachedSandbox) return cachedSandbox;
  try {
    if (existsSync(SANDBOX_TOKEN_FILE)) {
      const t = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim();
      if (t.length >= TOKEN_LEN_BYTES * 2) {
        cachedSandbox = t;
        return t;
      }
    }
  } catch { /* ignore */ }

  const fresh = randomBytes(TOKEN_LEN_BYTES).toString("hex");
  try {
    mkdirSync(dirname(SANDBOX_TOKEN_FILE), { recursive: true });
    // 0640 + group=hooopctl. The dashboard image's `node` user joins that group
    // via `group_add`; the model's `agent` uid is deliberately NOT in it, so
    // this file is unreadable to the model by DAC and not merely by policy.
    // No "world" bit means a third container that mounts the volume by mistake
    // can't read the token unless it joins the group on purpose.
    //
    // Belt and braces only: the directory this lives in is already 0750
    // hooopd:hooopctl, so the model gets EACCES on the path before the file mode
    // is ever consulted. Both layers are cheap and fail independently.
    writeFileSync(SANDBOX_TOKEN_FILE, fresh, { mode: 0o640 });
    chmodSync(SANDBOX_TOKEN_FILE, 0o640);
    try { chownSync(SANDBOX_TOKEN_FILE, -1, CONTROL_GID); } catch { /* group may not exist outside Docker */ }
  } catch (err) {
    log.error("sandbox-auth", "failed to persist sandbox token", { err: String(err) });
  }
  cachedSandbox = fresh;
  return fresh;
}

/**
 * Hook emitter token. Hook scripts run inside the sandbox container, read this
 * from disk, and POST it as X-Hook-Token to /ingest. Separate from the sandbox
 * token: a leaked hook secret only grants append-event-row, never spawn-agent.
 */
export function hookToken(): string {
  if (cachedHook) return cachedHook;
  try {
    if (existsSync(HOOK_TOKEN_FILE)) {
      const t = readFileSync(HOOK_TOKEN_FILE, "utf-8").trim();
      if (t.length >= TOKEN_LEN_BYTES * 2) {
        cachedHook = t;
        return t;
      }
    }
  } catch { /* ignore */ }

  const fresh = randomBytes(TOKEN_LEN_BYTES).toString("hex");
  try {
    mkdirSync(dirname(HOOK_TOKEN_FILE), { recursive: true });
    // 0640 owner hooopd, group `hooop`. The server writes it; the hook scripts
    // read it as `agent`, which is in `hooop` — so this is now a real group
    // grant rather than the same-uid coincidence it used to rely on.
    //
    // The mode only bites because this file moved OFF the bind-mounted profile
    // and next to the hook socket (see lib/paths.ts). On macOS Docker Desktop
    // the profile is virtiofs, which does not enforce DAC at all — a 0600 file
    // there is readable by every uid in the container, measured directly — so
    // the old location made any mode here decorative on the most common dev
    // platform. $HOOK_RUN_DIR is container-local overlayfs, where it holds.
    writeFileSync(HOOK_TOKEN_FILE, fresh, { mode: 0o640 });
    chmodSync(HOOK_TOKEN_FILE, 0o640);
    try { chownSync(HOOK_TOKEN_FILE, -1, HOOK_GID); } catch { /* group may not exist outside Docker */ }
  } catch (err) {
    log.error("sandbox-auth", "failed to persist hook token", { err: String(err) });
  }
  cachedHook = fresh;
  return fresh;
}

function constantTimeEquals(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(provided, "utf-8"), Buffer.from(expected, "utf-8"));
  } catch {
    return false;
  }
}

export function sandboxTokenMatches(provided: string | null | undefined): boolean {
  if (!provided) return false;
  return constantTimeEquals(provided, sandboxToken());
}

export function hookTokenMatches(provided: string | null | undefined): boolean {
  if (!provided) return false;
  return constantTimeEquals(provided, hookToken());
}
