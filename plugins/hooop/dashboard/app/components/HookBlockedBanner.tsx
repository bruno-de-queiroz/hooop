"use client";
import { useCallback, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { useSSE } from "./useSSE";

/**
 * Banner for when a Claude Code hook (any plugin's — claude-mem's worker
 * going unreachable is the one we've actually seen, but this isn't specific
 * to it) vetoes a prompt before the model ever sees it. Claude Code drops
 * that prompt silently otherwise: no reply, no error, nothing in the
 * transcript — the host just watches their message sit there. The sandbox
 * detects the `system`/`informational` frame with `preventContinuation` and
 * emits a `session-error` with kind "hook-blocked"; this renders it.
 *
 * Unlike AuthBanner, this does NOT self-clear on the next hook event: the
 * block already happened and is over, there's no ongoing bad state to watch
 * for the end of. The user reads it and dismisses it themselves, then
 * resends.
 */
export function HookBlockedBanner() {
  const [message, setMessage] = useState<string | null>(null);

  const dismiss = useCallback(() => setMessage(null), []);

  useSSE({
    "session-error": (raw: unknown) => {
      const p = raw as { kind?: string; message?: string };
      if (p?.kind === "hook-blocked") setMessage(p.message || "A plugin hook blocked your last message.");
    },
  });

  if (!message) return null;

  return (
    <div
      role="alert"
      data-testid="hook-blocked-banner"
      className="flex items-center gap-3 px-4 py-2 border border-fail/40 bg-fail/10 rounded-control text-ink text-sm"
    >
      <AlertTriangle size={16} className="shrink-0 text-fail" />
      <div className="flex-1 min-w-0">
        <div className="font-sans font-semibold">Your last message wasn&apos;t sent to Claude.</div>
        <div className="text-xs text-ink-mute mt-0.5">{message} — try resending it.</div>
      </div>
      <button
        onClick={dismiss}
        title="Dismiss"
        aria-label="Dismiss hook-blocked banner"
        className="shrink-0 p-1 rounded-control text-ink-mute hover:bg-fail/15 hover:text-ink transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
