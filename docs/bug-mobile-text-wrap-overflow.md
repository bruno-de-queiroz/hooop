# Bug: text wrap fails on mobile, creating horizontal scrollbars

## Summary
On narrow (mobile) viewports some message content doesn't wrap, so it pushes
wider than the viewport and produces a horizontal scrollbar ("horizontal bars")
inside the chat transcript.

## What already wrapped correctly (unchanged)
- Markdown paragraphs: `p` uses `break-words [overflow-wrap:anywhere]` (`Markdown.tsx`).
- Fenced code blocks: `<pre>` uses `overflow-x-auto whitespace-pre` inside an
  `overflow-hidden` wrapper (`Markdown.tsx`, `CodeBlock.tsx`) — scroll locally.
- Tables wrapped in `overflow-x-auto`; message bubbles capped at
  `max-width: min(82%,40rem)`; images `max-w-full`.

## Root cause (the gaps that were fixed)
1. **Bash `!cmd` output** — `ShellTranscript.tsx` (`BashCard` stdout/stderr).
   Rendered with `whitespace-pre-wrap` only, which wraps at spaces/newlines but
   does **not** break a long unbroken run (base64 blob, long path/URL, minified
   line), so it forced the `.msg-wide` card wider than the viewport.
2. **Markdown list items** — `Markdown.tsx` `li`. Had no wrap handling; in GFM
   "tight" lists the text sits directly in `<li>` (not a `<p>`), so a long token /
   bare URL / inline `code` in a bullet escaped the `p` rule and overflowed.
3. **Transcript scroll container** — `ShellTranscript.tsx`. Was `overflow-y-auto`
   with no x-axis control, so any residual child overflow surfaced as a
   horizontal scrollbar on the transcript itself.

## Fix (implemented)
1. `BashCard` stdout/stderr divs: added `[overflow-wrap:anywhere]` alongside
   `whitespace-pre-wrap` so long unbroken runs break instead of overflowing.
   (`overflow-wrap:anywhere`, not `break-all`, so normal words stay intact and
   only over-long runs break.)
2. `Markdown.tsx` `li`: now `className="break-words [overflow-wrap:anywhere]"` to
   cover tight-list content (long links, inline code, unbroken tokens).
3. Transcript scroll container: added `overflow-x-hidden` as a backstop. This does
   not affect code blocks (they keep their own inner `overflow-x-auto` scroll); it
   only prevents a transcript-level horizontal bar from anything not individually
   caught.

No change to `.bubble` / `.msg-wide` widths or `AppShell` — those are already
viewport-capped (`.msg-wide`'s `width:48rem` is bounded by its `max-width:100%`).

## Tests (added)
`ShellTranscript.test.tsx` (describe "horizontal overflow (mobile wrap)"):
- the transcript container carries `overflow-x-hidden`;
- a `BashShortcut` with a long unbroken stdout token renders the output element
  with `[overflow-wrap:anywhere]`.

Note: jsdom has no layout engine, so these assert the wrap/clip classes are
applied (intent), not pixel-level wrapping — mirroring the existing class-based
assertions in this suite.

Verified: full dashboard suite green (`npx vitest run` → 53 files / 458 tests) and
`npx tsc --noEmit` clean.

## Verification (manual, recommended)
On a mobile viewport (real device or the tunnel URL via Playwright at ~390px),
send a message with a very long unbroken token, a bare long URL in a bullet list,
and run a `!` command with long output; confirm no horizontal scrollbar appears
and content wraps within the bubble/card.
