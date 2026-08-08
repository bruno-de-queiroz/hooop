/**
 * Edge-safe auth helpers. No node: imports — middleware (which Next 14 runs
 * on the edge runtime) imports from this file. The node-only `lib/auth.ts`
 * re-exports these and adds the file-backed `dashboardToken()`.
 */

export const TOKEN_COOKIE = "hooop_token";
export const TOKEN_HEADER = "x-dashboard-token";

const DEFAULT_ALLOWED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "host.docker.internal",
]);

/**
 * Constant-time equality for two strings. Pure JS so it runs on edge. Length
 * mismatch returns false immediately (and that timing leak is fine — the
 * attacker would know the length anyway from the header's transport).
 */
export function constantTimeEqualsJs(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Compare a request-provided token to the expected dashboard token. Pass the
 * expected token in explicitly so this function stays edge-safe (no file IO).
 */
export function tokenMatchesExpected(provided: string | null | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  return constantTimeEqualsJs(provided, expected);
}

export function readTokenFromCookieHeader(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === TOKEN_COOKIE) return rest.join("=");
  }
  return null;
}

function extractHostname(hostHeader: string): string {
  if (hostHeader.startsWith("[")) {
    const close = hostHeader.indexOf("]");
    if (close === -1) return hostHeader;
    return hostHeader.slice(0, close + 1);
  }
  const colon = hostHeader.indexOf(":");
  return colon === -1 ? hostHeader : hostHeader.slice(0, colon);
}

/**
 * DNS-rebinding defence. See lib/auth.ts for the full rationale; this is the
 * edge-safe copy without the node: comment cross-references.
 */
export function isAllowedHost(hostHeader: string | null): boolean {
  if (!hostHeader || hostHeader.trim() === "") return false;

  const hostname = extractHostname(hostHeader);

  const isDefaultAllowed =
    DEFAULT_ALLOWED_HOSTNAMES.has(hostname) ||
    DEFAULT_ALLOWED_HOSTNAMES.has(hostHeader);
  if (isDefaultAllowed) return true;

  const extra = process.env.HOOOP_TRUSTED_HOSTS;
  if (!extra) return false;

  for (const entry of extra.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (trimmed.includes(":") && !trimmed.startsWith("[")) {
      if (trimmed === hostHeader) return true;
    } else {
      if (trimmed === hostname) return true;
    }
  }

  return false;
}

/**
 * Cross-origin check. See lib/auth.ts for full rationale.
 */
export function isSameOrigin(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const u = new URL(origin);
      return u.host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const referer = req.headers.get("referer");
  if (referer) {
    try {
      const u = new URL(referer);
      return u.host === host;
    } catch {
      return false;
    }
  }
  return process.env.HOOOP_NETWORK_HARDENING !== "1";
}

/**
 * Read the dashboard token from the environment. Middleware uses this — the
 * launcher (or compose env) is responsible for setting HOOOP_DASHBOARD_TOKEN
 * before the dashboard container starts. Returns null if the env var is
 * missing, in which case middleware should reject all requests.
 */
export function dashboardTokenFromEnv(): string | null {
  const t = process.env.HOOOP_DASHBOARD_TOKEN;
  return t && t.trim().length >= 16 ? t.trim() : null;
}
