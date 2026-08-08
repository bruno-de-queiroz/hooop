/**
 * `kind` tags for a UserPromptSubmit turn the model receives but that must
 * never render as a chat bubble — or count as "unseen activity" — in any
 * transcript UI. Producer: sandbox/lib/active-sessions.ts (writeUserTurn) and
 * sandbox/server.ts (the /ingest route, for a harness-injected turn nobody
 * called writeUserTurn for) stamp these on turns hooop or the harness injects
 * itself, never typed by a host or peer. Consumers: the dashboard's
 * ShellTranscript.tsx (hides the raw turn from the chat thread) and
 * UnseenProvider.tsx (must not flag a session for a turn nobody will ever
 * see). Centralized here — a package already shared by both the sandbox and
 * dashboard builds via each package's `@shared/*` path alias — so a kind
 * added on the producer side can't silently drift from a consumer side that
 * forgot to skip it (which is exactly how the dashboard ended up with two
 * independent, unsynced hardcoded string checks before this file existed).
 */

// The host's plan-review decision (proceed/revise) or an answered
// AskUserQuestion, relayed to the model as a real turn — but its user-facing
// lifecycle notice is a SEPARATE, deterministically-ingested event (see
// ingestLifecycleNotice in active-sessions.ts), so the raw relay turn itself
// must stay invisible.
export const AGENT_DIRECTIVE_KIND = "agent-directive";

// A background Task/Agent tool call's real result, injected directly by the
// Claude Code harness as a `<task-notification>` block once the async
// sub-agent finishes. Nobody sent this turn — see server.ts's /ingest route,
// which detects it from content rather than attributing it to a participant.
export const TASK_NOTIFICATION_KIND = "task-notification";

const HIDDEN_TURN_KINDS: ReadonlySet<string> = new Set([AGENT_DIRECTIVE_KIND, TASK_NOTIFICATION_KIND]);

/** Should a UserPromptSubmit with this `kind` be hidden from chat rendering
 * and excluded from unseen-activity accounting? */
export function isHiddenTurnKind(kind: string | null | undefined): boolean {
  return kind != null && HIDDEN_TURN_KINDS.has(kind);
}
