"use client";
import { useCallback, useRef, useState } from "react";
import { Loader2, Terminal } from "lucide-react";
import { useSessions } from "@/app/context/SessionsProvider";
import { SectionTitle } from "@/app/components/ui";

// Shell-native "Start a session" form (mockup empty state). Accent avatar +
// title, section-title labels over field inputs, a full-width accent Create
// button. Reuses useSessions().createSession (which selects the new row).
// Sessions run in the sandbox workspace; an optional git repo is cloned there
// on start (skipped if a folder of the same name already exists).

const MODEL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "default" },
  { value: "opus", label: "opus" },
  { value: "sonnet", label: "sonnet" },
  { value: "haiku", label: "haiku" },
];

// "goes dormant after" — set once at creation (no slash command edits it
// later). Empty value means "use the install-wide default"; "never" is a
// real, distinct choice (0ms), not the absence of one — see DORMANCY_MS.
const DORMANCY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "default" },
  { value: "5m", label: "5 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "2h", label: "2 hours" },
  { value: "never", label: "never" },
];

// idleTtlMs semantics (matches SessionInfo/createSession everywhere): undefined
// = install default, 0 = never go dormant, positive = that window in ms. "" MUST
// map to undefined, not 0 — sending 0 by default would silently disable dormancy
// for every session created without touching this select.
const DORMANCY_MS: Record<string, number | undefined> = {
  "": undefined,
  "5m": 300_000,
  "30m": 1_800_000,
  "2h": 7_200_000,
  never: 0,
};

// The burn-after-use helper copy has to list only the triggers that can
// actually fire for the selected dormancy. An idle-window trigger isn't real
// once dormancy is "never" (idleTtlMs: 0), so stating it there and then
// walking it back in a second sentence just leaves a reader who stops at the
// first sentence misinformed. Composing one accurate sentence per dormancy
// instead means there's never a claim left to retract.
function burnHelperCopy(dormancy: string): string {
  const trigger =
    dormancy === "never"
      ? "when you end it or if the sandbox restarts"
      : "when its idle window is up, when you end it, or if the sandbox restarts";
  return `This session deletes its transcript, workspace, events, and share links ${trigger}, instead of going dormant.`;
}

export function ShellNewSession({ onCreated }: { onCreated?: (sessionId: string) => void }) {
  const { createSession } = useSessions();
  const [gitRepo, setGitRepo] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
  const [dormancy, setDormancy] = useState("");
  const [burnAfterUse, setBurnAfterUse] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const canSubmit = !submitting;

  const submit = useCallback(async () => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { sessionId } = await createSession({
        name: name.trim() || undefined,
        model: model || undefined,
        gitRepo: gitRepo.trim() || undefined,
        idleTtlMs: DORMANCY_MS[dormancy],
        burnAfterUse,
      });
      if (!mountedRef.current) return;
      onCreated?.(sessionId);
    } catch (e) {
      if (mountedRef.current) setError((e as { message?: string })?.message ?? "create failed");
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [gitRepo, name, model, dormancy, burnAfterUse, submitting, createSession, onCreated]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className="w-full max-w-md">
      <div className="flex items-center gap-2.5 mb-1">
        <span
          className="avatar w-9 h-9 shrink-0"
          style={{
            background: "color-mix(in oklab, rgb(var(--accent)) 16%, rgb(var(--elevated)))",
            color: "rgb(var(--accent))",
          }}
        >
          <Terminal className="w-4 h-4" />
        </span>
        <h2 className="text-[17px] font-semibold text-ink">Start a session</h2>
      </div>
      <p className="text-[12px] text-ink-faint mb-5 pl-0.5">
        Pick a session on the left, or start a new one.
      </p>

      <label className="block mb-3">
        <SectionTitle>
          git repo <span className="normal-case tracking-normal text-ink-hush">(optional)</span>
        </SectionTitle>
        <input
          type="text"
          value={gitRepo}
          onChange={(e) => setGitRepo(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="https://github.com/owner/repo.git — cloned into the workspace"
          className="field font-mono w-full text-[12px] px-3 py-2 mt-1.5"
        />
      </label>

      <label className="block mb-3">
        <SectionTitle>
          name <span className="normal-case tracking-normal text-ink-hush">(optional)</span>
        </SectionTitle>
        <input
          type="text"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="random haiku name if blank"
          className="field w-full text-[12px] px-3 py-2 mt-1.5"
        />
      </label>

      <label className="block mb-3">
        <SectionTitle>model</SectionTitle>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          className="field w-full text-[12px] px-3 py-2 mt-1.5"
        >
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="block mb-3">
        <SectionTitle>goes dormant after</SectionTitle>
        <select
          value={dormancy}
          onChange={(e) => setDormancy(e.target.value)}
          onKeyDown={onKeyDown}
          className="field w-full text-[12px] px-3 py-2 mt-1.5"
        >
          {DORMANCY_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      {/* Deliberately a plain checkbox with no onKeyDown: the surrounding
        * fields wire Enter to submit, but Enter-to-submit on a checkbox row
        * is a footgun (easy to fire the checkbox and the form together).
        * Space toggles it normally since we don't touch that either. */}
      <label className="flex items-start gap-2 mb-5 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={burnAfterUse}
          onChange={(e) => setBurnAfterUse(e.target.checked)}
          className="mt-1 shrink-0"
        />
        <span className="min-w-0">
          <span className="block text-[12px] text-ink">burn after use</span>
          {/* The restart trigger has to be in this copy no matter what
            * dormancy window is picked: a routine sandbox restart can wipe
            * the session mid-conversation even on "default" or a timed
            * window. The idle-window trigger, though, only belongs here when
            * dormancy isn't "never" — see burnHelperCopy. */}
          <span className="block text-[11px] text-ink-faint mt-0.5">{burnHelperCopy(dormancy)}</span>
        </span>
      </label>

      {error && <p className="mb-3 text-[11px] text-fail">{error}</p>}

      <button
        type="button"
        disabled={!canSubmit}
        onClick={() => void submit()}
        className="accent-btn w-full py-2.5 text-[12px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed"
      >
        {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {submitting ? "Creating…" : "Create session"}
      </button>
    </div>
  );
}
