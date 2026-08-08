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

export function ShellNewSession({ onCreated }: { onCreated?: (sessionId: string) => void }) {
  const { createSession } = useSessions();
  const [gitRepo, setGitRepo] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState("");
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
      });
      if (!mountedRef.current) return;
      onCreated?.(sessionId);
    } catch (e) {
      if (mountedRef.current) setError((e as { message?: string })?.message ?? "create failed");
    } finally {
      if (mountedRef.current) setSubmitting(false);
    }
  }, [gitRepo, name, model, submitting, createSession, onCreated]);

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

      <label className="block mb-5">
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
