/**
 * The `#path` file-reference mention: one definition, shared by the dashboard
 * (which renders mentions as chips) and the sandbox (which rewrites them on the
 * way to claude) so the two can't drift.
 *
 * WHY A REWRITE EXISTS AT ALL. `@path` is claude's OWN syntax, not hooop's.
 * Verified against the CLI on the exact path we use (`stream-json` stdin, the
 * same pre-formed Messages-API user frame doWrite sends): a turn containing
 * "@marker.txt" is answered from the file's contents even with Read, Glob, Grep
 * and Bash all disallowed, while the same turn saying plain "marker.txt"
 * answers "NOACCESS". The CLI expands the mention into an attachment before the
 * model ever sees the turn. So hooop can show "#" in the composer and the
 * transcript, but whatever reaches claude's stdin has to say "@" or the file is
 * silently never read — no error, just an agent that never looked.
 *
 * Producers of a "#" mention: the composer autocomplete (useFiles.ts) and the
 * Files navigator's click-to-insert (FilesRail.tsx, ShellFilesDock.tsx).
 * Consumers: Markdown.tsx (chips) and active-sessions.ts (toClaudeFileRefs,
 * applied to `modelText` ONLY — the transcript keeps the "#" that was typed).
 */

/**
 * A file mention at a word boundary: "#" plus a path-shaped token. Matches
 * dotfiles ("#.gitignore") and nested paths ("#src/index.ts"), with an optional
 * ":<line>" suffix so "#src/index.ts:42" is one unit rather than dropping the
 * ":42".
 *
 * Two exclusions that "@" never needed, both because "#" is common in prose
 * where "@" was not:
 *   - an all-digit token, so a GitHub-style "#123" stays an issue reference.
 *     The lookahead has to allow for trailing sentence punctuation ("fixes
 *     #123, and...", "see #1.") — checking only for whitespace or end-of-string
 *     let every mid-sentence issue number through.
 *   - the lookbehind, so "issue#4" and a "docs#anchor" URL fragment are left
 *     alone. It also keeps a markdown "# heading" out: a heading has a space
 *     after the "#", and the first character here must be a word char or ".".
 *
 * Only lastIndex-safe methods may be used on this shared instance. `matchAll`
 * and `replace` both are; `test` and `exec` are not.
 */
export const FILE_MENTION = /(?<=^|\s)#(?!\d+\.?(?![\w./-]))[\w.][\w./-]*(?::\d+)?/g;

/**
 * Splits a matched mention token (with or without its leading "#") into the
 * path and an optional line number. Lives here rather than at the call site so
 * the ":<line>" suffix is peeled off by the same module that decided to match
 * it in the first place — the transcript's click-to-open needs the path alone,
 * and re-deriving that with a second regex is how the two drift.
 *
 * A trailing ":<digits>" is only a line number when the path has something in
 * front of it, so "#:12" (not a mention anyway) can't yield an empty path.
 */
export function parseFileMention(token: string): { path: string; line: number | null } {
  const bare = token.startsWith("#") ? token.slice(1) : token;
  const m = /^(.+):(\d+)$/.exec(bare);
  if (!m) return { path: bare, line: null };
  return { path: m[1], line: Number(m[2]) };
}

/** Opens or closes a fenced code block: ``` or ~~~, optionally indented. */
const FENCE = /^[ \t]*(`{3,}|~{3,})/;

/**
 * Rewrites hooop's `#path` mentions to the `@path` claude's CLI resolves.
 *
 * Skips fenced blocks and inline code spans, where "#" is a comment character
 * rather than a mention. This is not hypothetical tidiness: pasting a shell
 * script is a normal thing to do in a session, and every "#comment" line in it
 * would otherwise be handed to claude as a file reference. The old "@" sigil
 * never had this problem, which is exactly why the skip has to arrive with the
 * rename rather than after it.
 */
export function toClaudeFileRefs(text: string): string {
  const out: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1] ?? null;

    if (fence !== null) {
      out.push(line);
      // A fence closes on the same character, repeated at least as many times.
      if (marker !== null && marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }

    if (marker !== null) {
      fence = marker;
      out.push(line);
      continue;
    }

    out.push(rewriteOutsideCodeSpans(line));
  }

  return out.join("\n");
}

/** Rewrites mentions in one line, leaving `inline code` spans untouched. */
function rewriteOutsideCodeSpans(line: string): string {
  // The capture group makes split() keep the spans, so they can be passed
  // through verbatim while the text between them is rewritten.
  return line
    .split(/(`[^`]*`)/)
    .map((segment) => {
      const isSpan = segment.length > 1 && segment.startsWith("`") && segment.endsWith("`");
      if (isSpan) return segment;
      return segment.replace(FILE_MENTION, (m) => `@${m.slice(1)}`);
    })
    .join("");
}
