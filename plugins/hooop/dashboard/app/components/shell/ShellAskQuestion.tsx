"use client";
import { useState } from "react";
import { Check, Eye, HelpCircle } from "lucide-react";
import type { PendingPermissionRequest } from "@/app/context/hooks/usePendingRequests";
import { usePendingRequests } from "@/app/context/hooks/usePendingRequests";
import { useSelectedSession } from "@/app/context/SelectedSessionProvider";
import { isPeerClient, peerCapability, useMounted } from "../lib/participant";
import { cn } from "../ui/cn";

// Shell AskUserQuestion (Phase 3). Headless claude can't answer AskUserQuestion
// itself, so hooop gates the tool and surfaces the agent's question(s) inline
// above the composer (mockup: live-tinted card, option cards with descriptions,
// an "Other…" freeform, Submit). The picked answer is relayed to the model as
// the tool decision's feedback (a deny carrying the answer text). Single- and
// multi-select supported. A spectator sees it read-only (only host/drivers
// answer); the sandbox re-checks capability on submit regardless.

const liveAvatar = {
  background: "color-mix(in oklab, rgb(var(--live)) 18%, rgb(var(--elevated)))",
  color: "rgb(var(--live))",
};

interface QOption {
  label: string;
  description?: string;
}
interface Question {
  question: string;
  header?: string;
  options: QOption[];
  multiSelect?: boolean;
}

function parseQuestions(input: unknown): Question[] {
  const qs = input && typeof input === "object" ? (input as { questions?: unknown }).questions : null;
  if (!Array.isArray(qs)) return [];
  return qs.filter(
    (q): q is Question =>
      !!q && typeof (q as Question).question === "string" && Array.isArray((q as Question).options),
  );
}

// Exported for unit tests — covers the single-select, multi-select, and
// open-field ("Other") answer cases in isolation from the provider wiring.
export function AskQuestionCard({
  req,
  questions,
  locked,
  busy,
  onAnswer,
}: {
  req: PendingPermissionRequest;
  questions: Question[];
  locked: boolean;
  busy: boolean;
  onAnswer: (answerText: string) => void;
}) {
  // Selected option labels + freeform "Other", keyed by question index.
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [otherOn, setOtherOn] = useState<Record<number, boolean>>({});
  const [otherText, setOtherText] = useState<Record<number, string>>({});

  function pickOption(qi: number, label: string, multi: boolean) {
    setSelected((cur) => {
      const have = cur[qi] ?? [];
      if (multi) {
        const next = have.includes(label) ? have.filter((l) => l !== label) : [...have, label];
        return { ...cur, [qi]: next };
      }
      return { ...cur, [qi]: [label] };
    });
    if (!multi) setOtherOn((cur) => ({ ...cur, [qi]: false }));
  }

  function toggleOther(qi: number, multi: boolean) {
    setOtherOn((cur) => {
      const next = !cur[qi];
      if (next && !multi) setSelected((s) => ({ ...s, [qi]: [] }));
      return { ...cur, [qi]: next };
    });
  }

  function picksFor(qi: number): string[] {
    const picks = [...(selected[qi] ?? [])];
    if (otherOn[qi] && (otherText[qi] ?? "").trim()) picks.push(otherText[qi].trim());
    return picks;
  }

  const answered = questions.every((_, qi) => picksFor(qi).length > 0);

  function submit() {
    const lines = questions.map((q, qi) => `- ${q.question} → ${picksFor(qi).join(", ")}`);
    onAnswer(`The user answered your question(s):\n${lines.join("\n")}`);
  }

  const disabled = busy || locked;

  return (
    <div className="flex items-start gap-2.5">
      <span className="avatar w-7 h-7 shrink-0 mt-0.5" style={liveAvatar}>
        <HelpCircle className="w-3.5 h-3.5" />
      </span>
      <div className="min-w-0 flex-1 max-w-[40rem] rounded-2xl px-3.5 py-3 bg-elevated border border-divider">
        <span className="text-[10px] uppercase tracking-wide font-semibold text-live">
          Claude is asking
          {req.author && req.author !== "host" && (
            <span className="text-ink-faint normal-case tracking-normal"> · via {req.author}</span>
          )}
        </span>

        <div className="flex flex-col gap-4 mt-2">
          {questions.map((q, qi) => {
            const picks = selected[qi] ?? [];
            const other = !!otherOn[qi];
            return (
              <div key={qi}>
                <div className="mb-1 flex items-center gap-1.5">
                  {q.header && (
                    <span className="chip text-[9px] uppercase tracking-wide px-1.5 py-0.5 text-live">
                      {q.header}
                    </span>
                  )}
                  {q.multiSelect && (
                    <span className="font-mono text-[9px] uppercase tracking-wide text-ink-faint">
                      choose any
                    </span>
                  )}
                </div>
                <p className="text-[13px] text-ink font-medium mb-2">{q.question}</p>

                <div className="flex flex-col gap-1.5">
                  {q.options.map((o) => {
                    const on = picks.includes(o.label);
                    return (
                      <button
                        key={o.label}
                        type="button"
                        disabled={disabled}
                        onClick={() => pickOption(qi, o.label, !!q.multiSelect)}
                        className={cn(
                          "text-left rounded-xl px-3 py-2 border transition-colors disabled:opacity-60 disabled:cursor-not-allowed",
                          on
                            ? "bg-sunken border-accent/60 ring-2 ring-accent/15"
                            : "bg-sunken border-divider hover:border-ink-hush",
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className={cn(
                              "w-3.5 h-3.5 shrink-0 flex items-center justify-center",
                              q.multiSelect ? "rounded" : "rounded-full",
                              on ? "bg-accent" : "border-[1.5px] border-ink-hush",
                            )}
                          >
                            {on && <Check className="w-2.5 h-2.5 text-white" />}
                          </span>
                          <span className="text-[12.5px] font-semibold text-ink">{o.label}</span>
                        </div>
                        {o.description && (
                          <p className="text-[11.5px] text-ink-mute mt-1 pl-6">{o.description}</p>
                        )}
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => toggleOther(qi, !!q.multiSelect)}
                    className={cn(
                      "text-left rounded-xl px-3 py-2 border border-dashed transition-colors disabled:opacity-60 disabled:cursor-not-allowed",
                      other ? "bg-sunken border-accent/60" : "bg-sunken border-ink-hush/60 hover:border-ink-hush",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "w-3.5 h-3.5 rounded-full shrink-0 flex items-center justify-center",
                          other ? "bg-accent" : "border-[1.5px] border-ink-hush",
                        )}
                      >
                        {other && <Check className="w-2.5 h-2.5 text-white" />}
                      </span>
                      <span className="text-[12.5px] text-ink-mute">Other…</span>
                    </div>
                  </button>
                  {other && (
                    <input
                      autoFocus
                      disabled={disabled}
                      value={otherText[qi] ?? ""}
                      onChange={(e) => setOtherText((cur) => ({ ...cur, [qi]: e.target.value }))}
                      placeholder="type your answer…"
                      className="field text-[12px] px-3 py-1.5"
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {locked ? (
          <div className="flex items-center gap-1.5 mt-3 text-[11px] text-ink-mute">
            <Eye className="w-3.5 h-3.5" /> Only the host or a driver can answer.
          </div>
        ) : (
          <div className="flex items-center justify-end mt-3">
            <button
              type="button"
              disabled={busy || !answered}
              onClick={submit}
              className="accent-btn text-[11px] px-3.5 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "sending…" : "Submit"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export function ShellAskQuestion() {
  const { selectedId } = useSelectedSession();
  const { pending, decide } = usePendingRequests(selectedId);
  const [answeringId, setAnsweringId] = useState<string | null>(null);

  // Spectators can read the question but not answer (sandbox re-checks too).
  // Mount-gated so hydration matches the server (which always reads as host).
  const mounted = useMounted();
  const locked = mounted && isPeerClient() && peerCapability() === "spectate";

  const cards = pending
    .filter((r) => r.toolName === "AskUserQuestion")
    .map((r) => ({ r, questions: parseQuestions(r.input) }))
    .filter((c) => c.questions.length > 0);

  if (cards.length === 0) return null;

  return (
    <div className="px-5 pt-1 pb-2 shrink-0 flex flex-col gap-3 overflow-y-auto max-h-[55vh]">
      {cards.map(({ r, questions }) => (
        <AskQuestionCard
          key={r.requestId}
          req={r}
          questions={questions}
          locked={locked}
          busy={answeringId === r.requestId}
          onAnswer={async (answerText) => {
            setAnsweringId(r.requestId);
            try {
              await decide(r.requestId, "deny", "once", answerText);
            } finally {
              setAnsweringId(null);
            }
          }}
        />
      ))}
    </div>
  );
}
