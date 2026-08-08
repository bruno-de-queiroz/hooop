export function errorResponse(message: string, status = 500): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Run a sandbox-client call and translate failures into a consistent error
 * envelope. Preserves the sandbox's HTTP status (404, 429, 503, ...) so a
 * dashboard proxy route doesn't collapse upstream failures into 500.
 *
 *   export async function GET() {
 *     return proxy(() => client.listSessions());
 *   }
 */
export async function proxy<T>(
  call: () => Promise<T>,
  transform?: (value: T) => unknown,
): Promise<Response> {
  try {
    const value = await call();
    return Response.json(transform ? transform(value) : value);
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    const message = (e as { message?: string })?.message ?? "upstream failure";
    return errorResponse(message, status);
  }
}

const DEFAULT_MAX_BODY_BYTES = 32 * 1024;

export interface ParseJsonBodyOptions {
  maxBytes?: number;
  allowOtherContentTypes?: boolean;
}

export interface ParsedBody<T> {
  body: T;
  error: Response | null;
}

/**
 * Strict JSON body parser:
 *   - Rejects non-`application/json` Content-Type with 415 (defense against
 *     CORS-safelisted text/plain CSRF probes).
 *   - Caps payload size at `maxBytes` (default 32KB). Returns 413 if exceeded
 *     either by Content-Length header or actual body length.
 *   - Returns 400 for malformed JSON.
 *   - On any of the above, `error` is a Response ready to return; `body` is
 *     {} so destructuring stays safe.
 *
 * Callers should:
 *   const { body, error } = await parseJsonBody<MyShape>(req, { maxBytes: ... });
 *   if (error) return error;
 *   // ... use body
 */
export async function parseJsonBody<T = Record<string, unknown>>(
  req: Request,
  options: ParseJsonBodyOptions = {}
): Promise<ParsedBody<T>> {
  const max = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const empty = {} as T;

  if (!options.allowOtherContentTypes) {
    const ct = req.headers.get("content-type");
    if (!ct) {
      return { body: empty, error: errorResponse("missing content-type", 415) };
    }
    if (!ct.toLowerCase().includes("application/json")) {
      return { body: empty, error: errorResponse("Content-Type must be application/json", 415) };
    }
  }

  const declared = req.headers.get("content-length");
  if (declared) {
    const n = parseInt(declared, 10);
    if (Number.isFinite(n) && n > max) {
      return { body: empty, error: errorResponse("request body too large", 413) };
    }
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { body: empty, error: errorResponse("could not read request body", 400) };
  }
  if (text.length > max) {
    return { body: empty, error: errorResponse("request body too large", 413) };
  }
  if (!text) return { body: empty, error: null };

  try {
    return { body: JSON.parse(text) as T, error: null };
  } catch {
    return { body: empty, error: errorResponse("invalid JSON body", 400) };
  }
}

/**
 * Plain-text body reader for endpoints like /api/ingest that legitimately
 * accept newline-delimited JSON over text/plain. Caps size to prevent
 * unbounded audit-log injection.
 */
export async function readTextBody(
  req: Request,
  options: { maxBytes?: number } = {}
): Promise<{ text: string; error: Response | null }> {
  const max = options.maxBytes ?? DEFAULT_MAX_BODY_BYTES;
  const declared = req.headers.get("content-length");
  if (declared) {
    const n = parseInt(declared, 10);
    if (Number.isFinite(n) && n > max) {
      return { text: "", error: errorResponse("request body too large", 413) };
    }
  }
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { text: "", error: errorResponse("could not read request body", 400) };
  }
  if (text.length > max) {
    return { text: "", error: errorResponse("request body too large", 413) };
  }
  return { text, error: null };
}

/**
 * Bounded-string normaliser for fields that flow into FS / DB / process args.
 * Returns null when:
 *   - the input isn't a string,
 *   - the trimmed value is empty,
 *   - the trimmed value exceeds maxLen.
 *
 * Callers translate a null on a required field into a 400 — silent truncation
 * is a footgun (e.g. a too-long cwd would point to a different filesystem
 * location than the user intended), so this rejects instead of slicing.
 */
export function boundedString(v: unknown, maxLen: number): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  if (!trimmed) return null;
  if (trimmed.length > maxLen) return null;
  return trimmed;
}
