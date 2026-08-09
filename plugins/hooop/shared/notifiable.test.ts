import { describe, it, expect } from "vitest";
import { classifyEvent, countsAsUnseen, UNSEEN_CATEGORIES } from "./notifiable";
import { AGENT_DIRECTIVE_KIND, TASK_NOTIFICATION_KIND } from "./turn-kinds";

const base = { session_id: "s1", hook_type: "UserPromptSubmit", text: "hello", author: "Bruno" };

describe("classifyEvent — structural filters", () => {
  it("rejects an event with no session or no hook (nothing to open)", () => {
    expect(classifyEvent({ ...base, session_id: null })).toBeNull();
    expect(classifyEvent({ ...base, hook_type: null })).toBeNull();
  });

  it("rejects a sub-agent's own activity", () => {
    expect(classifyEvent({ ...base, agent_id: "sub-1" })).toBeNull();
  });

  it("rejects turns the transcript deliberately hides", () => {
    // Notifying here would point the viewer at content the UI never renders.
    expect(classifyEvent({ ...base, kind: AGENT_DIRECTIVE_KIND })).toBeNull();
    expect(classifyEvent({ ...base, kind: TASK_NOTIFICATION_KIND })).toBeNull();
  });

  it("rejects an unrecognised hook", () => {
    expect(classifyEvent({ ...base, hook_type: "PostToolUse" })).toBeNull();
    expect(classifyEvent({ ...base, hook_type: "PermissionResponse" })).toBeNull();
  });
});

describe("classifyEvent — categories", () => {
  it("classifies a human message as chat and names the author", () => {
    const c = classifyEvent(base);
    expect(c?.category).toBe("chat");
    expect(c?.title).toContain("Bruno");
    expect(c?.body).toBe("hello");
  });

  it("falls back to a generic chat title when the author is unknown", () => {
    expect(classifyEvent({ ...base, author: null })?.title).toBe("New message");
  });

  it("classifies Stop as turn-complete, with or without text", () => {
    expect(classifyEvent({ session_id: "s1", hook_type: "Stop", text: "done" })).toMatchObject({
      category: "turn-complete",
      body: "done",
    });
    expect(classifyEvent({ session_id: "s1", hook_type: "Stop", text: "" })).toMatchObject({
      category: "turn-complete",
      body: "",
    });
  });

  it("classifies a preview coming up, reading the message from ctx", () => {
    const c = classifyEvent({
      session_id: "s1",
      hook_type: "PreviewStarted",
      // What the ingestor stores in `text`: a debugging envelope, not prose.
      text: '[PreviewStarted] | message=Preview "web" is running',
      payload: { ctx: { message: 'Preview "web" is running' } },
    });
    expect(c?.category).toBe("preview");
    expect(c?.title).toBe("Preview is live");
    expect(c?.body).toBe('Preview "web" is running');
    expect(c?.body).not.toContain("message=");
  });

  it("classifies a preview that failed, keeping the reason", () => {
    const c = classifyEvent({
      session_id: "s1",
      hook_type: "PreviewFailed",
      text: "",
      payload: { ctx: { message: 'Preview "web" failed: npm ci exited 1' } },
    });
    expect(c?.category).toBe("preview");
    expect(c?.title).toBe("Preview failed to start");
    expect(c?.body).toContain("npm ci exited 1");
  });

  it("falls back to plain copy when there is no message", () => {
    expect(classifyEvent({ session_id: "s1", hook_type: "PreviewStarted", text: "" })?.body)
      .toBe("The app is running.");
  });

  it("shows what a human typed, not the prompt envelope", () => {
    const c = classifyEvent({
      session_id: "s1", hook_type: "UserPromptSubmit", author: "Ana",
      text: "[UserPromptSubmit] | prompt=can you look at the parser",
      payload: { ctx: { prompt: "can you look at the parser" } },
    });
    expect(c?.body).toBe("can you look at the parser");
  });

  it("shows the assistant's reply for a finished turn", () => {
    const c = classifyEvent({
      session_id: "s1", hook_type: "Stop",
      text: "[Stop] | last_assistant_message=All three tests pass now.",
      payload: { ctx: { last_assistant_message: "All three tests pass now." } },
    });
    expect(c?.body).toBe("All three tests pass now.");
  });

  it("recovers prose from the envelope when ctx is missing entirely", () => {
    // Degrades to imperfect prose rather than to internals — no `key=`, no
    // `[Hook]` tag — for any consumer or legacy row that lacks the payload.
    const c = classifyEvent({
      session_id: "s1", hook_type: "Stop",
      text: "[Stop] | last_assistant_message=done here",
    });
    expect(c?.body).toBe("done here");
    expect(c?.body).not.toContain("[Stop]");
    expect(c?.body).not.toContain("=");
  });

  it.each(["PreviewShared", "PreviewStopped", "PreviewRebuilt"])(
    "does not notify for %s — a consequence of something just done in the UI",
    (hook) => {
      expect(classifyEvent({ session_id: "s1", hook_type: hook, text: "x" })).toBeNull();
    },
  );

  it("classifies a peer join request", () => {
    const c = classifyEvent({
      session_id: "s1",
      hook_type: "PeerJoinRequest",
      text: "message=Ana asked to join",
    });
    expect(c?.category).toBe("join-request");
    expect(c?.body).toContain("Ana");
  });
});

describe("classifyEvent — attention, the blocking cases", () => {
  it("distinguishes a plan review from a question from a plain permission ask", () => {
    // A plan review is filed under ExitPlanMode by createPermissionRequest, so
    // the copy must not read as a literal tool call.
    const plan = classifyEvent({ session_id: "s1", hook_type: "PermissionRequest", tool_name: "ExitPlanMode", text: "" });
    expect(plan).toMatchObject({ category: "attention" });
    expect(plan?.title).toMatch(/plan/i);

    const ask = classifyEvent({ session_id: "s1", hook_type: "PermissionRequest", tool_name: "AskUserQuestion", text: "" });
    expect(ask?.title).toMatch(/question/i);

    const perm = classifyEvent({ session_id: "s1", hook_type: "PermissionRequest", tool_name: "Write", text: "" });
    expect(perm?.title).toMatch(/permission/i);
    expect(perm?.body).toContain("Write");
  });

  it("shows the question itself, not the event envelope", () => {
    // Reported from a real notification: `[PermissionRequest] |
    // tool=AskUserQuestion | tool_input={"questions":[…` — the debugging
    // envelope on a lock screen. The ctx alongside it holds the actual question.
    const c = classifyEvent({
      session_id: "s1",
      hook_type: "PermissionRequest",
      tool_name: "AskUserQuestion",
      text: '[PermissionRequest] | tool=AskUserQuestion | tool_input={"questions":[{"question":"Tea or coffee?"}]}',
      payload: { ctx: { tool_input: '{"questions":[{"question":"Tea or coffee?","header":"Drink"}]}' } },
    });
    expect(c?.body).toBe("Tea or coffee?");
    expect(c?.body).not.toContain("tool_input");
    expect(c?.body).not.toContain("[PermissionRequest]");
  });

  it("counts the extra questions rather than dropping them silently", () => {
    const c = classifyEvent({
      session_id: "s1", hook_type: "PermissionRequest", tool_name: "AskUserQuestion", text: "",
      payload: { ctx: { tool_input: { questions: [{ question: "First?" }, { question: "Second?" }] } } },
    });
    expect(c?.body).toBe("First? (+1 more)");
  });

  it("shows a plan's title line, not the whole document", () => {
    const c = classifyEvent({
      session_id: "s1", hook_type: "PermissionRequest", tool_name: "ExitPlanMode", text: "",
      payload: { ctx: { tool_input: { plan: "## Rework the tunnel\n\n1. first step\n2. second step" } } },
    });
    expect(c?.body).toBe("Rework the tunnel");
  });

  it("never puts a tool's raw input in the body", () => {
    // A Write's input is a whole file and a Bash's may carry a secret. The tool
    // name is the summary; the detail belongs in the permission card.
    const c = classifyEvent({
      session_id: "s1", hook_type: "PermissionRequest", tool_name: "Bash", text: "",
      payload: { ctx: { tool_input: { command: "aws s3 cp secret.env s3://bucket" } } },
    });
    expect(c?.body).toBe("Bash needs your approval.");
    expect(c?.body).not.toContain("secret.env");
  });

  it("never returns an empty body for an attention event", () => {
    // These are the notifications that matter most; an empty body would render
    // as a bare title with no indication of what is being asked.
    for (const tool of ["ExitPlanMode", "AskUserQuestion", "Write", null]) {
      const c = classifyEvent({ session_id: "s1", hook_type: "PermissionRequest", tool_name: tool, text: "" });
      expect(c?.body).not.toBe("");
    }
  });
});

describe("countsAsUnseen — preserves the dot's original behaviour", () => {
  it("flags a human message and an assistant message with text", () => {
    expect(countsAsUnseen(base)).toBe(true);
    expect(countsAsUnseen({ session_id: "s1", hook_type: "Stop", text: "answer" })).toBe(true);
  });

  it("does NOT flag a contentless Stop — there'd be nothing to read", () => {
    expect(countsAsUnseen({ session_id: "s1", hook_type: "Stop", text: "" })).toBe(false);
    expect(countsAsUnseen({ session_id: "s1", hook_type: "Stop", text: "   " })).toBe(false);
  });

  it("does NOT flag attention or join-request — they have their own UI", () => {
    // Folding these into the dot would double-report the permission card and
    // the admit toast.
    expect(countsAsUnseen({ session_id: "s1", hook_type: "PermissionRequest", tool_name: "Write" })).toBe(false);
    expect(countsAsUnseen({ session_id: "s1", hook_type: "PeerJoinRequest", text: "x" })).toBe(false);
    expect(UNSEEN_CATEGORIES.has("attention")).toBe(false);
  });

  it("does NOT flag a preview — the Browser rail has its own cue", () => {
    // Worse than double-reporting here: preview rows are suppressed from the
    // transcript, so the dot would promise something to read and deliver nothing.
    expect(countsAsUnseen({
      session_id: "s1", hook_type: "PreviewStarted", text: "message=up",
    })).toBe(false);
    expect(UNSEEN_CATEGORIES.has("preview")).toBe(false);
  });

  it("does NOT flag hidden kinds or sub-agent activity", () => {
    expect(countsAsUnseen({ ...base, kind: AGENT_DIRECTIVE_KIND })).toBe(false);
    expect(countsAsUnseen({ ...base, agent_id: "sub-1" })).toBe(false);
  });
});

describe("body shaping", () => {
  it("collapses whitespace and truncates long text", () => {
    const c = classifyEvent({ ...base, text: "a\n\n  b" });
    expect(c?.body).toBe("a b");

    const long = classifyEvent({ ...base, text: "x".repeat(500) });
    expect(long!.body.length).toBeLessThanOrEqual(140);
    expect(long!.body.endsWith("…")).toBe(true);
  });
});

describe("classifyEvent — mentions", () => {
  it("carries the handles a human message names, still as a chat", () => {
    // Stays "chat" here on purpose: classification sees one event, not an
    // audience, so it cannot know whether anyone present is actually named.
    // Promotion to "mention" is the delivery layer's call, per recipient.
    const c = classifyEvent({
      session_id: "s1",
      hook_type: "UserPromptSubmit",
      author: "Bruno",
      text: "hey @sam can you look at this",
    });
    expect(c?.category).toBe("chat");
    expect(c?.mentions).toEqual(["sam"]);
  });

  it("carries no mentions for a message that names nobody", () => {
    const c = classifyEvent({ session_id: "s1", hook_type: "UserPromptSubmit", text: "no names here" });
    expect(c?.mentions).toEqual([]);
  });

  it("carries no mentions on non-message events", () => {
    const c = classifyEvent({ session_id: "s1", hook_type: "Stop", text: "done @sam" });
    expect(c?.category).toBe("turn-complete");
    expect(c?.mentions).toEqual([]);
  });
});
