/**
 * Tiny JSON logger. Writes one object per line to stderr (Docker collects
 * this as the container log). Designed to be grep-able and ingestable by
 * structured log shippers without a parser quirk.
 *
 * Levels: debug | info | warn | error | fatal. Default minimum is `info`;
 * override with LOG_LEVEL=debug for verbose dev. Under NODE_ENV=test or
 * Vitest, output is suppressed to avoid stderr noise during test runs.
 *
 * Keep in sync with `dashboard/lib/logger.ts` — same shape, same fields,
 * so the operator sees identical output from both containers. The
 * duplication is intentional: each package is independently buildable, and
 * a shared workspace package isn't justified for ~50 lines of code.
 *
 * Production deploys should configure the host's container log driver with
 * size/age rotation (e.g. Docker's `local` driver with `max-size=10m,
 * max-file=5`). This logger does not rotate.
 *
 * Pattern at call site:
 *   log.info("server", "listening", { socket: "/var/run/..." });
 *   log.error("sse", "disconnected", { err, requestId });   // err is normalized
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 } as const;
type Level = keyof typeof LEVELS;

const minLevel: number = LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? LEVELS.info;
const SUPPRESSED = process.env.NODE_ENV === "test" || process.env.VITEST != null;

// Anything matching one of these patterns is replaced with "[redacted]"
// before serialization. Conservative list: sandbox/dashboard tokens are
// 64-hex; Anthropic API keys start with sk-ant-; bearer headers; JWT.
const REDACT_PATTERNS: RegExp[] = [
  /\b[0-9a-f]{64}\b/g,                 // 64-hex tokens (our sandbox/dashboard tokens, hook tokens)
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,    // Anthropic API keys
  /\bsk-[A-Za-z0-9]{20,}\b/g,          // OpenAI-style keys (legacy + project keys)
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,    // Bearer header values
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, // JWT
];

function redactString(s: string): string {
  let out = s;
  for (const re of REDACT_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
  code?: string;
  cause?: unknown;
}

function serializeError(e: unknown): SerializedError | string {
  if (e instanceof Error) {
    const out: SerializedError = { message: redactString(e.message), name: e.name };
    if (e.stack) out.stack = redactString(e.stack);
    const code = (e as NodeJS.ErrnoException).code;
    if (code) out.code = code;
    const cause = (e as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = serializeError(cause);
    return out;
  }
  return redactString(String(e));
}

const MAX_DEPTH = 5;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function redactValue(v: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (depth > MAX_DEPTH) return "[depth-capped]";
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) {
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const result = v.map((item) => redactValue(item, depth + 1, seen));
    seen.delete(v);
    return result;
  }
  if (isPlainObject(v)) {
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    const result: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      result[k] = redactValue(val, depth + 1, seen);
    }
    seen.delete(v);
    return result;
  }
  // numbers, booleans, null, undefined, Date, RegExp, Error, class instances
  return v;
}

function normalizeCtx(ctx?: LogCtx): Record<string, unknown> | undefined {
  if (!ctx) return undefined;
  const seen = new WeakSet<object>();
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (k === "err" || v instanceof Error) {
      out[k] = serializeError(v);
    } else {
      out[k] = redactValue(v, 1, seen);
    }
  }
  return out;
}

interface LogCtx {
  requestId?: string;
  err?: unknown;
  [k: string]: unknown;
}

function emit(level: Level, module: string, msg: string, ctx?: LogCtx) {
  if (SUPPRESSED) return;
  if (LEVELS[level] < minLevel) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    module,
    msg: redactString(msg),
    ...(normalizeCtx(ctx) ?? {}),
  };
  process.stderr.write(JSON.stringify(line) + "\n");
}

export const log = {
  debug: (mod: string, msg: string, ctx?: LogCtx) => emit("debug", mod, msg, ctx),
  info: (mod: string, msg: string, ctx?: LogCtx) => emit("info", mod, msg, ctx),
  warn: (mod: string, msg: string, ctx?: LogCtx) => emit("warn", mod, msg, ctx),
  error: (mod: string, msg: string, ctx?: LogCtx) => emit("error", mod, msg, ctx),
  fatal: (mod: string, msg: string, ctx?: LogCtx) => emit("fatal", mod, msg, ctx),
};

// Exported for tests; not part of the public surface.
export const __testing__ = { redactString, serializeError, normalizeCtx };
