import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import {
  installMockEventSource,
  clearEventSources,
} from "./__test-utils__/mock-event-source";
import { installMockFetch, type FetchScript } from "./__test-utils__/mock-fetch";
import { installMockNavigation, setMockUrl } from "./__test-utils__/mock-navigation";

let SelectedSessionProvider: typeof import("./SelectedSessionProvider").SelectedSessionProvider;
let SessionsProvider: typeof import("./SessionsProvider").SessionsProvider;
let CommandsProvider: typeof import("./CommandsProvider").CommandsProvider;
let useCommands: typeof import("./CommandsProvider").useCommands;

async function loadModules() {
  vi.resetModules();
  const sel = await import("./SelectedSessionProvider");
  const sess = await import("./SessionsProvider");
  const cmd = await import("./CommandsProvider");
  SelectedSessionProvider = sel.SelectedSessionProvider;
  SessionsProvider = sess.SessionsProvider;
  CommandsProvider = cmd.CommandsProvider;
  useCommands = cmd.useCommands;
}

let fetchScript: FetchScript;

beforeEach(async () => {
  installMockEventSource();
  installMockNavigation();
  setMockUrl("http://localhost/");
  await loadModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearEventSources();
});

// Many plugin-namespaced commands that sort ahead of the built-ins
// alphabetically — reproduces the workspace shape that hid `/plan` etc.
const CLAUDE_MEM_COMMANDS = [
  "babysit", "cloud-sync", "design-is", "do", "how-it-works", "knowledge-agent",
  "learn-codebase", "make-plan", "mem-search", "oh-my-issues", "pathfinder",
  "smart-explore", "standup", "timeline-report", "version-bump",
  "weekly-digests", "what-the", "wowerpoint",
].map((base) => ({
  name: `claude-mem:${base}`,
  description: null,
  plugin: "claude-mem@marketplace",
  kind: "command" as const,
}));

// The real dashboard built-in set: /clear and /init were removed (they don't
// belong on hooop's persistent sessions), leaving five.
const BUILTINS = [
  { name: "compact", description: "Compact the conversation", plugin: "built-in", kind: "builtin" as const },
  { name: "cost", description: "Show usage info", plugin: "built-in", kind: "builtin" as const },
  { name: "plan", description: "Propose a plan for approval", plugin: "built-in", kind: "builtin" as const },
  { name: "stop", description: "Interrupt the current turn", plugin: "built-in", kind: "builtin" as const },
  { name: "model", description: "Switch the model", plugin: "built-in", kind: "builtin" as const },
];

describe("CommandsProvider", () => {
  it("ranks builtins ahead of a large plugin namespace, so /plan /model /stop survive a top-N slice", async () => {
    fetchScript = installMockFetch({
      routes: [
        (url) =>
          url.startsWith("/api/commands") ? { json: [...CLAUDE_MEM_COMMANDS, ...BUILTINS] } : null,
        (url) => (url.startsWith("/api/skills") ? { json: [] } : null),
      ],
      fallback: { status: 200, json: {} },
    });

    let captured: ReturnType<typeof useCommands> | null = null;
    function Capture() {
      const c = useCommands();
      useEffect(() => {
        captured = c;
      });
      return null;
    }

    render(
      <SelectedSessionProvider>
        <SessionsProvider>
          <CommandsProvider>
            <Capture />
          </CommandsProvider>
        </SessionsProvider>
      </SelectedSessionProvider>,
    );

    await waitFor(() => expect(captured?.loading).toBe(false));

    const entries = captured!.entries;
    // The leading entries (the composer's top-N slice for a bare "/") must be
    // exactly the built-ins, alphabetical among themselves — so /plan /model
    // /stop can't be pushed off the slice by the big claude-mem namespace.
    const firstBuiltins = entries.slice(0, BUILTINS.length).map((e) => e.label);
    expect(firstBuiltins).toEqual(["compact", "cost", "model", "plan", "stop"]);
    expect(entries.slice(0, BUILTINS.length).every((e) => e.kind === "builtin")).toBe(true);

    // The claude-mem commands still follow, alphabetically, after the builtins.
    expect(entries[BUILTINS.length].label).toBe("claude-mem:babysit");
  });
});
