/**
 * Node-only auth helpers: file-backed dashboard token storage. Routes import
 * from here. Middleware (edge runtime in Next 14) imports from `./auth-edge`
 * which is the node-free subset.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { dirname } from "node:path";
import { log } from "@shared/logger";

// Re-export the edge-safe surface so route code can keep a single import.
export {
  TOKEN_COOKIE,
  TOKEN_HEADER,
  readTokenFromCookieHeader,
  isSameOrigin,
  isAllowedHost,
  dashboardTokenFromEnv,
  tokenMatchesExpected,
  constantTimeEqualsJs,
} from "./auth-edge";

const TOKEN_FILE = process.env.HOOOP_DASHBOARD_TOKEN_FILE
  || "/var/lib/hooop/dashboard/dashboard.token";
const TOKEN_LEN_BYTES = 32;

let cached: string | null = null;

/**
 * The dashboard authenticates requests with a per-install random token.
 *
 * Lookup order:
 *   1. process.env.HOOOP_DASHBOARD_TOKEN (preferred; set by the launcher)
 *   2. TOKEN_FILE (legacy / dev fallback, persisted across restarts)
 *   3. Freshly generated random 32-byte hex (last resort; lost on container
 *      restart unless TOKEN_FILE is writable).
 *
 * In production the launcher generates the token on the host and passes it
 * via compose env, so the container never touches the filesystem for it.
 */
export function dashboardToken(): string {
  if (cached) return cached;

  const fromEnv = process.env.HOOOP_DASHBOARD_TOKEN;
  if (fromEnv && fromEnv.trim().length >= TOKEN_LEN_BYTES * 2) {
    cached = fromEnv.trim();
    return cached;
  }

  try {
    if (existsSync(TOKEN_FILE)) {
      const t = readFileSync(TOKEN_FILE, "utf-8").trim();
      if (t.length >= TOKEN_LEN_BYTES * 2) {
        cached = t;
        return t;
      }
    }
  } catch { /* ignore */ }

  const fresh = randomBytes(TOKEN_LEN_BYTES).toString("hex");
  try {
    mkdirSync(dirname(TOKEN_FILE), { recursive: true });
    writeFileSync(TOKEN_FILE, fresh, { mode: 0o600 });
    chmodSync(TOKEN_FILE, 0o600);
  } catch (err) {
    log.error("auth", "failed to persist token (will regenerate next start)", { err });
  }
  cached = fresh;
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

export function tokenMatches(provided: string | null | undefined): boolean {
  if (!provided) return false;
  return constantTimeEquals(provided, dashboardToken());
}
