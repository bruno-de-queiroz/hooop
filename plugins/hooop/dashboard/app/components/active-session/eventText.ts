import type { EventRow } from "@/lib/sandbox-client";

/**
 * The sandbox's ingestor builds a structured log line for every event:
 *   `[HookType] | tool=Foo | tool_input={"…"} | prompt=… | message=… | …`
 *
 * That's the right shape for search + grep, but the wrong shape for a
 * dialog transcript. These helpers pull the human-meaningful field out
 * of that envelope per row variant.
 *
 * Each helper falls back to the raw text when the expected field isn't
 * present — that covers:
 *   - Optimistic UserPromptSubmit rows (carry the bare prompt directly).
 *   - Synthetic Stop frames the sandbox builds for `<synthetic>` model
 *     replies (text is just the assistant body, no wrapper).
 *   - Legacy rows from older sandbox builds.
 *
 * Empty strings collapse to "" so callers can render placeholders.
 */

// The set of keys the sandbox's deriveText can emit, in the order it
// emits them. We compile this into the separator-detection regex so a
// value containing a stray `foo=bar` substring can't be mistaken for a
// real field boundary.
const KNOWN_FIELDS = [
  "tool",
  "tool_input",
  "tool_response",
  "tool_result",
  "prompt",
  "message",
  "transcript",
  "last_assistant_message",
  "kind",
] as const;

// ` | <known_field>=` — the only valid separator inside the wrapper.
// Uses literal ` | ` (the source emitter writes a single space, pipe,
// single space; `\s` would be too generous and would falsely match
// `\n|\n` inside a value).
const FIELD_SEPARATOR_RE = new RegExp(
  ` \\| (?:${KNOWN_FIELDS.join("|")})=`,
);

/** Strip the `[Hook] | field1=… | field2=…` wrapper and pull one field. */
export function extractEventField(text: string | null, key: string): string | null {
  if (!text) return null;
  const idx = text.indexOf(`${key}=`);
  if (idx < 0) return null;
  const start = idx + key.length + 1;
  const tail = text.slice(start);
  const sepMatch = FIELD_SEPARATOR_RE.exec(tail);
  const value = sepMatch ? tail.slice(0, sepMatch.index) : tail;
  const trimmed = value.trim();
  return trimmed || null;
}

/** Does the text look like a structured sandbox log line? */
function isStructured(text: string | null): boolean {
  if (!text) return false;
  return /^\[[A-Z][A-Za-z]+\]/.test(text);
}

/** UserPromptSubmit body: the user's typed message. */
export function userPromptText(row: EventRow): string {
  if (!row.text) return "";
  // Optimistic rows (negative id) hold the bare prompt with no wrapper.
  // Pulling `prompt=` from a literal user input that happens to contain
  // "prompt=foo" would extract "foo" by accident — guard by id sign AND
  // by checking the wrapper shape.
  if (row.id < 0 || !isStructured(row.text)) return row.text;
  // A structured row with no `prompt=` field carries no user text — an
  // image-only turn, whose empty prompt was dropped by the sandbox's
  // deriveText, leaving just the bare `[UserPromptSubmit]`/`[Chat]` wrapper.
  // Return "" (not the raw wrapper) so it renders as an image-only message.
  return extractEventField(row.text, "prompt") ?? "";
}

/**
 * Stop/SubagentStop assistant body.
 *
 * The fallback chain is intentionally narrow: `last_assistant_message`
 * first (claude's canonical post-turn assistant text), `message`
 * second (synthetic frames + Notification-style payloads). We do NOT
 * fall back to the `transcript` field — that key carries a JSONL file
 * path in the upstream ingestor, not assistant content, and rendering
 * it would surface `/home/agent/.claude/projects/.../session.jsonl`
 * as the model's reply. If neither real field is present we return
 * the raw text and let the dialog read the wrapper as-is rather than
 * lie about content.
 */
export function assistantText(row: EventRow): string {
  if (!row.text) return "";
  if (!isStructured(row.text)) return row.text;
  return (
    extractEventField(row.text, "last_assistant_message") ??
    extractEventField(row.text, "message") ??
    row.text
  );
}

/** PreToolUse args: the tool's input arguments. */
export function toolArgsText(row: EventRow): string {
  if (!row.text) return "";
  if (!isStructured(row.text)) return row.text;
  return extractEventField(row.text, "tool_input") ?? "";
}

/** PostToolUse result body. */
export function toolResultText(row: EventRow): string {
  if (!row.text) return "";
  if (!isStructured(row.text)) return row.text;
  return (
    extractEventField(row.text, "tool_response") ??
    extractEventField(row.text, "tool_result") ??
    extractEventField(row.text, "message") ??
    ""
  );
}

export interface BashShortcutData {
  command: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  // Streaming: `runId` groups the start/progress/done snapshots of one command
  // into a single card; `status` is "running" until the final snapshot lands.
  // Both are null for legacy (pre-streaming) single-shot BashShortcut events.
  runId: string | null;
  status: "running" | "done" | null;
}

/**
 * Parse the BashShortcut event payload. The sandbox encodes the command in
 * `tool_input=` and the structured result in `tool_response={...}`. We
 * extract both and unmarshal the response as JSON. Returns null when the
 * row doesn't look like a BashShortcut frame (defensive — the renderer
 * will fall back to a placeholder rather than crash).
 */
export function bashShortcutData(row: EventRow): BashShortcutData | null {
  if (!row.text) return null;
  const command = extractEventField(row.text, "tool_input") ?? "";
  const rawResponse = extractEventField(row.text, "tool_response");
  if (!rawResponse) {
    return {
      command,
      exitCode: null,
      signal: null,
      durationMs: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      runId: null,
      status: null,
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const v = JSON.parse(rawResponse);
    if (v && typeof v === "object") parsed = v as Record<string, unknown>;
  } catch {
    /* malformed — fall through to defaults */
  }
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const nullableNum = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const nullableStr = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const status = parsed?.status === "running" || parsed?.status === "done" ? parsed.status : null;
  return {
    command,
    exitCode: nullableNum(parsed?.exit_code),
    signal: nullableStr(parsed?.signal),
    durationMs: num(parsed?.duration_ms),
    timedOut: parsed?.timed_out === true,
    stdout: str(parsed?.stdout),
    stderr: str(parsed?.stderr),
    runId: nullableStr(parsed?.run_id),
    status,
  };
}

/** Notification / PreCompact / other system rows. */
export function systemText(row: EventRow): string {
  if (!row.text) return "";
  if (!isStructured(row.text)) return row.text;
  return (
    extractEventField(row.text, "message") ??
    extractEventField(row.text, "kind") ??
    row.text
  );
}
