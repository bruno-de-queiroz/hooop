export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Display form of a tool name: strip the noisy `mcp__<server>__` prefix so the
 * actual tool (the signal) survives truncation on narrow screens. E.g.
 * `mcp__plugin_hooop_tools__enter_plan_mode` → `enter_plan_mode`,
 * `mcp__playwright__browser_navigate` → `browser_navigate`. Non-MCP names
 * (`Bash`, `Read`) pass through unchanged. Keep the full name for a title/tooltip. */
export function prettyToolName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return m ? m[1] : name;
}

/** Human label for a two-letter country code from the peer-join edge lookup.
 * Real ISO codes render as a flag emoji + code (e.g. "🇺🇸 US"); Cloudflare's
 * "T1" (Tor) is spelled out as a distinct signal; anything else is dropped. */
export function countryLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  const c = code.toUpperCase();
  if (c === "T1") return "Tor";
  if (!/^[A-Z]{2}$/.test(c)) return null;
  const flag = String.fromCodePoint(
    ...[...c].map((ch) => 0x1f1e6 + (ch.charCodeAt(0) - 65)),
  );
  return `${flag} ${c}`;
}

export function textOf(v: unknown): string {
  if (v == null) return "(empty)";
  if (typeof v === "string") return v;
  if (typeof v !== "object") return String(v);
  const obj = v as Record<string, unknown>;
  // Bash style: stdout / stderr combined.
  if (typeof obj.stdout === "string" || typeof obj.stderr === "string") {
    const parts: string[] = [];
    if (typeof obj.stdout === "string" && obj.stdout) parts.push(obj.stdout);
    if (typeof obj.stderr === "string" && obj.stderr) parts.push(`[stderr]\n${obj.stderr}`);
    return parts.join("\n").trimEnd();
  }
  if (typeof obj.content === "string") return obj.content;
  if (typeof obj.output === "string") return obj.output;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.message === "string") return obj.message;
  if (Array.isArray(obj.content)) {
    const texts = (obj.content as any[])
      .map((c) => typeof c === "string" ? c : (c?.text ?? c?.content ?? ""))
      .filter((s) => typeof s === "string" && s.length > 0);
    if (texts.length) return texts.join("\n");
  }
  // Fall back to pretty JSON.
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function extractField(text: string | null, key: string): string | null {
  if (!text) return null;
  const re = new RegExp(`${key}=([^|]+)`);
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

export function extractObj(text: string | null, key: string): any {
  const raw = extractField(text, key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

export function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  const dt = Date.now() - t;
  if (dt < 60_000) return "now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h`;
  return `${Math.floor(dt / 86_400_000)}d`;
}

/**
 * Human-friendly slug for short labels (sidebar rows, badges).
 * Lowercases, collapses any run of non-alphanumeric chars to a single dash,
 * trims leading/trailing dashes, then slices to `max` chars. Returns "" for
 * empty input; the caller decides how to fall back.
 *
 * The trailing slice may leave a half-word at the boundary — that's fine for
 * a sidebar where vertical room matters more than perfect word breaks.
 */
export function slugifyName(raw: string, max = 32): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max);
}

/**
 * Slug a session displayName for sidebar rendering. Returns null when the
 * input is null/empty/whitespace OR slugs to nothing (e.g. an emoji-only
 * prompt) so the caller can fall back to skill/cwd/short-id.
 */
export function formatSessionLabel(raw?: string | null, max = 32): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const slug = slugifyName(trimmed, max);
  return slug || null;
}

/** Last path segment of a cwd ("/home/agent/workspace" → "workspace"). */
export function cwdBasename(cwd: string | undefined | null): string {
  if (!cwd) return "";
  const parts = cwd.split("/").filter(Boolean);
  return parts.at(-1) ?? "/";
}

/**
 * Canonical display label for a session, shared by the sidebar row and the
 * active-session header so the two surfaces never disagree (especially
 * mid-wake, where a transient registry gap would otherwise let them render
 * different fallbacks). Fallback chain: displayName slug → skill → cwd
 * basename → short session id.
 *
 * Accepts a minimal structural shape rather than importing SessionInfo so
 * this stays a pure formatter with no type coupling to the providers.
 */
export function sessionDisplayLabel(s: {
  displayName?: string | null;
  skill?: string;
  cwd?: string;
  sessionId?: string;
  id?: string;
}): string {
  const slug = formatSessionLabel(s.displayName);
  if (slug) return slug;
  if (s.skill) return s.skill;
  return cwdBasename(s.cwd) || s.sessionId?.slice(0, 8) || s.id?.slice(0, 8) || "session";
}

/**
 * Compact token counts for the stats strip. Returns:
 *   < 1_000      → exact integer ("842")
 *   < 1_000_000  → 1 decimal of k ("8.4k", "84.2k")
 *   otherwise    → 1 decimal of m ("1.2m")
 *
 * Negatives and NaN return "0"; we never show them. The strip is
 * informational, not an error surface — a junk usage payload should not
 * become a UI bug.
 */
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "0";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/**
 * Wall-clock duration formatter for the stats strip. Compact, terminal-feel:
 *   < 60s       → "12s"
 *   < 1h        → "12m 04s"
 *   otherwise   → "2h 12m"
 *
 * Negatives and NaN return "0s" for the same UI-safety reason as
 * formatTokens.
 */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "0s";
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  return `${hours}h ${String(remMin).padStart(2, "0")}m`;
}

/** A short, human label for a model id, e.g. "claude-opus-4-8" → "Opus 4.8". */
export function prettyModel(m: string | null): string | null {
  if (!m) return null;
  const match = m.match(/claude-(opus|sonnet|haiku)-(\d+)(?:-(\d+))?/i);
  if (match) {
    const family = match[1][0].toUpperCase() + match[1].slice(1).toLowerCase();
    const major = match[2];
    const minor = match[3];
    return minor ? `${family} ${major}.${minor}` : `${family} ${major}`;
  }
  return m;
}
