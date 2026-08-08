/**
 * "Is this event worth telling a human about, and what do we say?" — the single
 * definition, shared by the dashboard's unseen dot and the sandbox's web-push
 * sender.
 *
 * Why this lives in `shared/` rather than next to either consumer: the two run
 * in different processes and evaluate the SAME question from opposite ends. The
 * dot is decided in the browser from a WebSocket frame; the notification is
 * decided in the sandbox from the ingest event bus. If they drift, a session
 * pings your phone but shows no dot, or lights a dot for a turn nobody can
 * read. That is exactly the failure `turn-kinds.ts` was extracted to prevent —
 * its header records the dashboard once carrying "two independent, unsynced
 * hardcoded string checks".
 *
 * Split of responsibility, which is what keeps this module usable by both:
 *   - classifyEvent() answers what is INTRINSIC to the event — is it a real
 *     message at all, and what kind. It is pure and viewer-agnostic.
 *   - Viewer-specific filtering (is it mine, am I already looking at it, have I
 *     muted it) stays in the consumer, because the same event is notifiable for
 *     one participant and not another.
 *
 * Must stay dependency-free and environment-agnostic: it is bundled into the
 * sandbox by esbuild (node) and into the dashboard by Next (jsdom + browser).
 */

import { isHiddenTurnKind } from "./turn-kinds";

export type NotifyCategory =
  /** The agent is blocked on a human: a permission ask, a question, a plan review. */
  | "attention"
  /** The agent finished a turn and went idle. */
  | "turn-complete"
  /** A human participant said something. */
  | "chat"
  /** Someone redeemed a share link and is waiting to be admitted. */
  | "join-request"
  /**
   * A session's app finished coming up — or failed trying.
   *
   * Its own category because it is neither a message nor a block on the human:
   * nothing is waiting on an answer, but a preview is precisely the thing you
   * start and then walk away from, and "is it up yet?" is the question you would
   * otherwise keep going back to check.
   */
  | "preview";

/**
 * The subset of the ingest event shape both consumers actually receive. The
 * sandbox emits this on `eventBus` (see ingestor.ts's `emittable`) and the
 * dashboard receives the same fields over the WebSocket, so one interface
 * covers both without either side inventing a mapping.
 */
export interface NotifiableEvent {
  session_id?: string | null;
  hook_type?: string | null;
  tool_name?: string | null;
  author?: string | null;
  text?: string | null;
  agent_id?: string | null;
  kind?: string | null;
  /**
   * The original hook event, whose `ctx` holds the fields a human actually wants
   * to read (`prompt`, `last_assistant_message`, `message`, `tool_input`).
   *
   * `text` is NOT that. It is deriveText's debugging envelope —
   * `[PermissionRequest] | tool=AskUserQuestion | tool_input={"questions":[…`
   * — which is right for the event log and for search, and unreadable on a lock
   * screen. Both the sandbox's event bus and the dashboard's WebSocket frame
   * already carry this field; the notification copy reads from here and only
   * falls back to fixed sentences, never to the envelope.
   */
  payload?: { ctx?: Record<string, unknown> | null } | null;
}

export interface Classification {
  category: NotifyCategory;
  /** Short headline, safe to use as a notification title. */
  title: string;
  /** Human-readable detail; may be empty when the event carries no text. */
  body: string;
}

/**
 * Hooks that represent a conversational message. Lifted verbatim from
 * UnseenProvider so the dot's behaviour is preserved exactly.
 *
 * "Chat" has no producer in the sandbox today (nothing emits `hook: "Chat"`),
 * but it was in the original list and costs nothing to keep — dropping it would
 * be a silent behaviour change for any replayed/legacy event that still carries
 * it.
 */
const MESSAGE_HOOKS: ReadonlySet<string> = new Set([
  "UserPromptSubmit",
  "Chat",
  "Stop",
  "SubagentStop",
]);

/**
 * Categories that count as "unseen activity" for the sidebar dot. Deliberately
 * NOT all of them: `attention` and `join-request` are surfaced by their own
 * dedicated UI (the permission card, the admit toast), and `preview` by the
 * Browser rail's own cue — folding any of them into the dot would double-report
 * them. A preview would in fact report worse than twice: its transcript rows are
 * suppressed, so the dot would promise something to read and deliver nothing.
 * Push wants the wider set; the dot wants this one. Exported so the split is
 * declared here rather than re-derived by the consumer.
 */
export const UNSEEN_CATEGORIES: ReadonlySet<NotifyCategory> = new Set<NotifyCategory>([
  "chat",
  "turn-complete",
]);

/** Longest body we put in a notification before ellipsis. */
const BODY_MAX = 140;

function truncate(s: string, max: number = BODY_MAX): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** The original hook's ctx, or an empty object. */
function ctxOf(e: NotifiableEvent): Record<string, unknown> {
  const c = e.payload?.ctx;
  return c && typeof c === "object" ? c : {};
}

/** A ctx field, if it is a non-empty string. */
function ctxText(e: NotifiableEvent, key: string): string {
  const v = ctxOf(e)[key];
  return typeof v === "string" && v.trim() ? truncate(v) : "";
}

/**
 * A tool's input as an object. The ingest path stores it either as a JSON string
 * or as the object itself, depending on which producer wrote the event.
 */
function toolInput(e: NotifiableEvent): Record<string, unknown> | null {
  const raw = ctxOf(e).tool_input;
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Last resort when an event arrives without its `ctx`: recover prose from the
 * envelope instead of showing the envelope.
 *
 * Drops the `[Hook]` tag and the `key=` labels, keeping the values. Imperfect by
 * nature — that is why it is the fallback and not the source — but it can never
 * put `tool_input={"questions":[…` on a lock screen, which is the whole point.
 */
function stripEnvelope(text: string): string {
  const parts = text
    .split(" | ")
    .filter((p) => !/^\[[A-Za-z]+\]$/.test(p.trim()))   // the [Hook] tag
    .filter((p) => !/^(tool|kind|request_id|tool_use_id)=/.test(p.trim()))
    .map((p) => p.replace(/^[a-z_]+=/, "").trim())
    .filter(Boolean);
  return truncate(parts.join(" — "));
}

/**
 * The first meaningful line, with markdown heading marks and list bullets
 * stripped. A plan's first line is its title, which is the useful thing to show;
 * the rest is a document, not a notification.
 */
function firstLine(s: string): string {
  for (const raw of s.split("\n")) {
    const line = raw.replace(/^\s*[#>*\-•\d.)\s]+/, "").trim();
    if (line) return truncate(line);
  }
  return "";
}

/**
 * Classify an ingest event, or return null when it is not something a human
 * should ever be told about.
 *
 * The null cases are the load-bearing part — each one is a bug that was
 * observed or reasoned about rather than a hypothetical:
 *   - No session/hook: not addressable to a session, so nothing to open.
 *   - `agent_id` set: a sub-agent's internal chatter, not main-thread activity.
 *   - Hidden turn kinds: a plan-decision relay or a `<task-notification>` the
 *     transcript deliberately never renders — notifying would point at content
 *     that does not exist in the UI.
 *   - A contentless Stop/SubagentStop: a turn-complete marker with no message.
 *     Still notifiable as `turn-complete`, but only when the caller asks for
 *     that category — see below.
 */
export function classifyEvent(e: NotifiableEvent): Classification | null {
  const sid = e.session_id;
  const hook = e.hook_type;
  if (!sid || !hook) return null;

  // A sub-agent's own lifecycle is internal activity, never a message to a human.
  if (e.agent_id) return null;

  // System-injected turns hidden from the transcript must not notify either.
  if (isHiddenTurnKind(e.kind)) return null;

  const text = (e.text ?? "").trim();

  if (hook === "PeerJoinRequest") {
    return {
      category: "join-request",
      title: "Someone wants to join",
      body: ctxText(e, "message") || stripEnvelope(text) || "A guest asked to join this session.",
    };
  }

  if (hook === "PermissionRequest") {
    return { category: "attention", ...attentionCopy(e) };
  }

  // A preview reaching a terminal state. Only these two: "starting" is not news,
  // and stopped/rebuilt/shared are all consequences of an action somebody just
  // took in the UI, so telling them about it is telling them what they just did.
  // Started and failed are the two ways the wait ENDS, and the wait is the point
  // — `npm ci` plus a dev server is minutes of nothing to look at.
  // The one preview event that is a request rather than news. The agent is
  // blocked until somebody opens the panel, and it cannot route around it — so
  // this is worth interrupting a person for even though the other lifecycle
  // events are not.
  if (hook === "PreviewNeedsViewer") {
    return {
      category: "preview",
      title: "The agent needs the preview open",
      body: ctxText(e, "message") || stripEnvelope(text)
        || "It is trying to use the app and nobody has the Browser panel open.",
    };
  }

  if (hook === "PreviewStarted" || hook === "PreviewFailed") {
    const failed = hook === "PreviewFailed";
    return {
      category: "preview",
      title: failed ? "Preview failed to start" : "Preview is live",
      body: ctxText(e, "message") || stripEnvelope(text)
        || (failed ? "The app did not come up." : "The app is running."),
    };
  }

  if (!MESSAGE_HOOKS.has(hook)) return null;

  if (hook === "Stop" || hook === "SubagentStop") {
    // A Stop with no text is a bare turn-complete marker. It is still worth a
    // notification ("the agent finished"), but it must NOT count as unseen
    // content — there would be nothing to read on arrival. The category split
    // handles that: UNSEEN_CATEGORIES includes turn-complete only because a
    // Stop WITH text is the assistant's message. Consumers that care about
    // readable content should check `body`.
    //
    // `text` still decides EMPTINESS (callers and countsAsUnseen both key off a
    // contentless Stop), but what we show is the assistant's actual reply.
    return {
      category: "turn-complete",
      title: "Agent finished",
      body: text ? ctxText(e, "last_assistant_message") || stripEnvelope(text) : "",
    };
  }

  // UserPromptSubmit / Chat — a human said something.
  return {
    category: "chat",
    title: e.author ? `${e.author} sent a message` : "New message",
    body: ctxText(e, "prompt") || stripEnvelope(text),
  };
}

/** Title/body for the three things that block the agent on a human. */
function attentionCopy(e: NotifiableEvent): { title: string; body: string } {
  const toolName = e.tool_name;
  const input = toolInput(e);

  // ExitPlanMode is the tool the sandbox surfaces a plan review under (see
  // createPermissionRequest's plan capture, which re-files submit_plan as
  // ExitPlanMode), so this is the plan-review card, not a literal tool call.
  if (toolName === "ExitPlanMode") {
    const plan = typeof input?.plan === "string" ? firstLine(input.plan) : "";
    return { title: "Plan ready for review", body: plan || "The agent submitted a plan." };
  }

  if (toolName === "AskUserQuestion") {
    // Show the question itself — it is short, written for a human, and the
    // whole reason the agent stopped. `questions[]` is the current shape; the
    // singular is accepted too rather than assuming one producer forever.
    const list = Array.isArray(input?.questions) ? input.questions : [];
    const first = list[0] as { question?: unknown } | undefined;
    const q = typeof first?.question === "string"
      ? first.question
      : typeof input?.question === "string" ? input.question : "";
    const more = list.length > 1 ? ` (+${list.length - 1} more)` : "";
    return {
      title: "The agent asked you a question",
      body: q ? truncate(q) + more : "Open the session to answer.",
    };
  }

  // Everything else: the tool name IS the useful summary. Never the raw input —
  // a Write's input is a whole file, and a Bash's is a command that may carry a
  // secret; neither belongs on a lock screen. The command is one tap away in the
  // permission card, which is where the decision gets made anyway.
  return {
    title: "Permission needed",
    body: toolName ? `${toolName} needs your approval.` : "A tool call needs your approval.",
  };
}

/**
 * Convenience wrapper for the unseen dot: true when this event should light a
 * session marker. Keeps the category filter in one place so the dashboard does
 * not re-derive it.
 *
 * Mirrors the pre-extraction rule that a contentless Stop is not content.
 */
export function countsAsUnseen(e: NotifiableEvent): boolean {
  const c = classifyEvent(e);
  if (!c || !UNSEEN_CATEGORIES.has(c.category)) return false;
  if ((c.category === "turn-complete") && !c.body) return false;
  return true;
}
