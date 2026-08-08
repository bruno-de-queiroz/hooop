import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render } from "@testing-library/react";
import {
  installMockEventSource,
  latestEventSource,
  clearEventSources,
} from "./__test-utils__/mock-event-source";
import { installMockNavigation, setMockUrl } from "./__test-utils__/mock-navigation";

// Regression: a background sub-agent's <task-notification> is hidden from the
// transcript (kind: "task-notification", see shared/turn-kinds.ts) — it must
// not raise the sidebar's "unseen" dot either, or switching to that session
// shows nothing despite the flag. Same for an "agent-directive" relay turn.

let SelectedSessionProvider: typeof import("./SelectedSessionProvider").SelectedSessionProvider;
let UnseenProvider: typeof import("./UnseenProvider").UnseenProvider;
let useUnseen: typeof import("./UnseenProvider").useUnseen;

async function loadModules() {
  vi.resetModules();
  const sel = await import("./SelectedSessionProvider");
  const unseen = await import("./UnseenProvider");
  SelectedSessionProvider = sel.SelectedSessionProvider;
  UnseenProvider = unseen.UnseenProvider;
  useUnseen = unseen.useUnseen;
}

beforeEach(async () => {
  installMockEventSource();
  installMockNavigation();
  setMockUrl("http://localhost/"); // no `?session=` — nothing selected
  await loadModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  clearEventSources();
});

function Capture({ onValue }: { onValue: (v: ReturnType<typeof useUnseen>) => void }) {
  onValue(useUnseen());
  return null;
}

async function renderUnseen() {
  let captured!: ReturnType<typeof useUnseen>;
  render(
    <SelectedSessionProvider>
      <UnseenProvider>
        <Capture onValue={(v) => { captured = v; }} />
      </UnseenProvider>
    </SelectedSessionProvider>,
  );
  // Let the mock WebSocket's queued onopen fire.
  await act(async () => {});
  return {
    fire: (data: unknown) => act(() => { latestEventSource()?.fire("event", data); }),
    get: () => captured,
  };
}

describe("UnseenProvider — hidden turn kinds", () => {
  it("does not flag a session for a hidden task-notification turn", async () => {
    const { fire, get } = await renderUnseen();
    fire({
      session_id: "s-hidden",
      hook_type: "UserPromptSubmit",
      author: null,
      kind: "task-notification",
      text: "<task-notification>...</task-notification>",
    });
    expect(get().hasUnseen("s-hidden")).toBe(false);
  });

  it("does not flag a session for a hidden agent-directive turn", async () => {
    const { fire, get } = await renderUnseen();
    fire({
      session_id: "s-hidden-2",
      hook_type: "UserPromptSubmit",
      author: "Ralph",
      kind: "agent-directive",
      text: "The plan is approved — proceed with implementing it.",
    });
    expect(get().hasUnseen("s-hidden-2")).toBe(false);
  });

  it("still flags a session for an ordinary (non-hidden) message from someone else", async () => {
    const { fire, get } = await renderUnseen();
    fire({
      session_id: "s-visible",
      hook_type: "UserPromptSubmit",
      author: "Ralph",
      kind: null,
      text: "hey, can you check this?",
    });
    expect(get().hasUnseen("s-visible")).toBe(true);
  });
});
