"use client";
import { useCallback, useState } from "react";
import { ShieldAlert, Copy, Check, X } from "lucide-react";
import { useSSE } from "./useSSE";

/**
 * Sticky banner at the top of the dashboard when the sandbox claude has
 * returned an auth failure (stderr matched `401|unauthorized|invalid
 * auth|claude login`). The user runs `hooop login`, which re-authenticates the
 * sandbox's OWN Claude account (paste-code flow inside the container); the next
 * successful turn (`sessions` SSE refresh or any normal `event` SSE) clears the
 * banner. The host's Claude credentials are never involved.
 *
 * Why a banner instead of an inline error: auth failure spans every
 * future turn, not just the one that emitted it. Putting the message
 * adjacent to the next prompt textarea would hide it the moment a new
 * session is selected; a top-level banner stays visible until resolved.
 *
 * Detection precision is good enough: the sandbox-side regex skips
 * "refresh succeeded" lines so a token rotation mid-turn doesn't fire a
 * false positive.
 */
export function AuthBanner() {
  const [shown, setShown] = useState(false);
  const [copied, setCopied] = useState(false);

  const dismiss = useCallback(() => setShown(false), []);
  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText("hooop login");
      setCopied(true);
      // Brief visual confirmation, then revert so the icon stays clickable
      // if the user copies again (e.g. they pasted in the wrong window).
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Older browsers / non-secure contexts may reject Clipboard API. The
      // command text is visible inline anyway so this is a degraded-but-
      // usable path.
    }
  }, []);

  useSSE({
    "session-error": (raw: unknown) => {
      const p = raw as { kind?: string };
      if (p?.kind === "auth") setShown(true);
    },
    // Any successful turn clears the banner. `event` fires on every hook
    // emit (PreToolUse, UserPromptSubmit, Stop…), so the first non-auth
    // event after a re-seed is our signal that we're back in business.
    event: () => setShown((s) => (s ? false : s)),
  });

  if (!shown) return null;

  return (
    <div
      role="alert"
      data-testid="auth-banner"
      className="flex items-center gap-3 px-4 py-2 border border-fail/40 bg-fail/10 rounded-control text-ink text-sm"
    >
      <ShieldAlert size={16} className="shrink-0 text-fail" />
      <div className="flex-1 min-w-0">
        <div className="font-sans font-semibold">Sandbox lost authentication.</div>
        <div className="text-xs text-ink-mute mt-0.5">
          Run{" "}
          <code className="px-1.5 py-0.5 rounded bg-sunken border border-divider font-mono text-ink">
            hooop login
          </code>{" "}
          in your terminal to re-authenticate the sandbox. It signs in with its own Claude account.
        </div>
      </div>
      <button
        onClick={copy}
        title={copied ? "Copied!" : "Copy `hooop login` to clipboard"}
        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-control border border-fail/40 text-ink-soft hover:bg-fail/15 hover:text-ink text-xs transition-colors"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
        <span>{copied ? "Copied" : "Copy"}</span>
      </button>
      <button
        onClick={dismiss}
        title="Dismiss"
        aria-label="Dismiss auth banner"
        className="shrink-0 p-1 rounded-control text-ink-mute hover:bg-fail/15 hover:text-ink transition-colors"
      >
        <X size={14} />
      </button>
    </div>
  );
}
