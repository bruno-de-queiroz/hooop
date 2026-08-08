"use client";
import { useEffect } from "react";
import { NotebookText, RefreshCw } from "lucide-react";
import { useActiveSession } from "@/app/context/ActiveSessionProvider";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { IconButton, SectionTitle } from "../ui";

// Desktop-shell Summary card (Phase 3). Reads the SAME `useSessionSummary`
// instance the provider already owns (`active.summary`) — no extra fetching and
// no changes to the provider. Unlike the legacy collapsed-by-default card, the
// rail gives summary a permanent home, so it loads on mount and presents as the
// mockup's accent-tinted flair card (`.summary-card` in globals.css).

export function SummaryRail() {
  const active = useActiveSession();
  const { selectedId } = useSelectedSession();
  const summary = active.summary;
  const state = summary.state;

  // The rail always shows the card, so load eagerly (the legacy card deferred
  // until the user expanded it).
  //
  // Trigger off `idle` rather than the session id: the hook resets to `idle` in
  // its own `[sessionId]` effect, and child effects run BEFORE parent effects.
  // Firing on the id directly would call ensureLoaded first, then the reset
  // would clear `triggeredRef` and bump the generation — discarding that
  // in-flight fetch and leaving the card stuck empty. Reacting to `idle` runs
  // after the reset lands, so every session (including the first) loads once.
  useEffect(() => {
    if (state.status === "idle") summary.ensureLoaded();
  }, [state.status, summary.ensureLoaded]);

  return (
    <section className="border-b border-divider p-3">
      <div className="flex items-center gap-2 px-1 mb-2">
        <NotebookText className="w-3.5 h-3.5 text-accent" />
        <SectionTitle className="flex-1">Summary</SectionTitle>
        <IconButton
          label="Refresh summary"
          size="sm"
          onClick={() => summary.refetch()}
          disabled={state.status === "loading" || !selectedId}
        >
          <RefreshCw className="w-3 h-3" />
        </IconButton>
      </div>

      <div className="summary-card relative rounded-xl">
        <div className="max-h-[18rem] overflow-y-auto p-3">
          {/* With no session the hook's fetch early-returns and the state stays
            * `idle` forever — so gate on the selection first rather than letting
            * the card sit on a permanent "loading…". */}
          {!selectedId ? (
            <p className="font-mono text-[10px] text-ink-faint">
              Select a session to see its summary.
            </p>
          ) : state.status === "idle" || state.status === "loading" ? (
            <p className="font-mono text-[10px] text-ink-faint">loading…</p>
          ) : state.status === "error" ? (
            <p className="font-mono text-[10px] text-fail">summary lookup failed</p>
          ) : state.summary == null ? (
            <p className="font-mono text-[10px] text-ink-faint">
              claude-mem will summarize after the first completed turn.
            </p>
          ) : (
            <dl className="flex flex-col gap-2.5">
              {state.summary.request && <Field label="Request" value={state.summary.request} />}
              {state.summary.investigated && (
                <Field label="Investigated" value={state.summary.investigated} />
              )}
              {state.summary.learned && <Field label="Learned" value={state.summary.learned} />}
              {state.summary.completed && <Field label="Completed" value={state.summary.completed} />}
              {state.summary.nextSteps && <Field label="Next steps" value={state.summary.nextSteps} />}
            </dl>
          )}
        </div>
        <div className="summary-fade" aria-hidden />
      </div>
    </section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="summary-label">{label}</dt>
      <dd className="text-[12px] text-ink-soft leading-snug whitespace-pre-wrap break-words">
        {value}
      </dd>
    </div>
  );
}
