# Bug: image-only messages render the raw event wrapper as message text

## Summary
When a user (host or peer) sends a message that contains an image but no
typed text, the dashboard chat bubble shows a stray fragment of the
internal event envelope — `[UserPromptSubmit]` or `[Chat]` — as the message
body, instead of just the image with no text at all.

Reported by a peer collaborator ("tired woman") while testing the mobile
dashboard view over a Cloudflare tunnel.

## Root cause

Two pieces combine to produce this:

**1. `deriveText()`** — `plugins/hooop/sandbox/lib/ingestor.ts:197-209`

Builds the structured log line stored as `EventRow.text`:

```js
export function deriveText(event: any): string {
  const ctx = event?.ctx ?? {};
  const parts: string[] = [];
  if (event?.hook) parts.push(`[${event.hook}]`);
  if (ctx.tool_name) parts.push(`tool=${ctx.tool_name}`);
  for (const key of [..., "prompt", ...]) {
    const v = ctx[key];
    if (v == null) continue;
    const s = typeof v === "string" ? v : safeStringify(v);
    if (s) parts.push(`${key}=${s}`);   // <-- falsy (empty) values are dropped
  }
  return parts.join(" | ");
}
```

When a `UserPromptSubmit`/`Chat` turn has an image but no text, `ctx.prompt`
is `""`. The `if (s)` check drops it, so **no `prompt=` field is ever
emitted**. The stored `text` collapses to just `"[UserPromptSubmit]"` (or
`"[Chat]"`) — still non-empty, still matches the "structured" shape.

**2. `userPromptText()`** — `plugins/hooop/dashboard/app/components/active-session/eventText.ts:65-73`

```js
export function userPromptText(row: EventRow): string {
  if (!row.text) return "";
  if (row.id < 0 || !isStructured(row.text)) return row.text;
  return extractEventField(row.text, "prompt") ?? row.text;   // <-- bug
}
```

`row.text` is `"[UserPromptSubmit]"` — truthy, and `isStructured()` matches
it (`/^\[[A-Z][A-Za-z]+\]/`). `extractEventField(row.text, "prompt")` finds
no `prompt=` substring and returns `null`. The `?? row.text` fallback then
returns the *entire raw wrapper* (`"[UserPromptSubmit]"`) as if it were the
prompt text.

`HostBubble` (`plugins/hooop/dashboard/app/components/shell/ShellTranscript.tsx:106-107`)
renders whatever `userPromptText()` returns as the text block above the
image — so the wrapper leaks into the UI as visible message content.

The `?? row.text` fallback exists to handle *unstructured* legacy/optimistic
rows (see the "falls back to raw text when the row isn't structured" test
in `eventText.test.ts:77-80`) — but it also fires for genuinely-structured
rows where the field is simply absent because it was empty, which is the
case this bug hits. There's no existing test for a structured row with zero
fields (e.g. `"[UserPromptSubmit]"` alone), which is why this slipped
through.

## Steps to reproduce
1. Open a hooop session in the dashboard (reproduces on mobile and desktop).
2. Send a message with an attached image and no typed text.
3. Observe the chat bubble: it shows `[UserPromptSubmit]` (or `[Chat]` for
   a `>` chat-only message) as text above/alongside the image.

## Expected behavior
Image-only messages should render with no text block — just the image,
matching how `HostBubble` already handles a genuinely-empty `text` (see
the `{text && (...)}` guard at `ShellTranscript.tsx:137`).

## Fix (implemented — dashboard-only)
In `userPromptText()`, only fall back to `row.text` when the row is
*unstructured*. For a structured row where `prompt=` is genuinely absent,
return `""` instead of the raw wrapper:

```js
export function userPromptText(row: EventRow): string {
  if (!row.text) return "";
  if (row.id < 0 || !isStructured(row.text)) return row.text;
  return extractEventField(row.text, "prompt") ?? "";   // was: ?? row.text
}
```

This one change fixes the bug for **both existing and new** sessions, because
it acts at render time on whatever `text` is served. It covers both
`[UserPromptSubmit]` and `[Chat]` (both flow through `HostBubble`), and also
cleans the ↑-history in `ShellComposer.tsx:96`, which uses the same helper.

### Why no sandbox / DB change
The sandbox's `deriveText` (`plugins/hooop/sandbox/lib/ingestor.ts:197`) runs
only at ingest time and freezes its output into the `events.text` column. The
read path (`listEvents` / `getEvent` in
`plugins/hooop/sandbox/lib/events-query.ts`) returns that column **verbatim** and
never re-derives from `payload`. So changing `deriveText` would fix new rows
only and leave every already-stored image-only turn broken — whereas the
renderer fix corrects all rows. No `deriveText` change and no DB backfill were
made (deliberate scope decision).

## Tests (added)
- `eventText.test.ts`: `userPromptText` returns `""` for a bare
  `"[UserPromptSubmit]"` and a bare `"[Chat]"` structured row.
- `ShellTranscript.test.tsx`: a stored image-only turn
  (`text: "[UserPromptSubmit]"`, with an image) renders the thumbnail and does
  **not** surface the literal `[UserPromptSubmit]`.

Verified: `npx vitest run app/components/active-session/eventText.test.ts
app/components/shell/ShellTranscript.test.tsx` → 2 files, 42 tests passing.
