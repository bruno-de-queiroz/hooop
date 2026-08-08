import { describe, it, expect } from "vitest";
import { classifyComposerInput, resolveAutoMode } from "./ShellComposer";

// The composer routes a composed line to one of five destinations. The two
// control commands (`/stop`, `/model <alias>`) are the important regression:
// they must be intercepted client-side and NEVER fall through to `send` (which
// would forward them to the model as plain text — they'd never stop/switch).
describe("classifyComposerInput", () => {
  it("routes plain text to the model", () => {
    expect(classifyComposerInput("hello there", false)).toEqual({ kind: "send", text: "hello there" });
  });

  it("routes `!cmd` to bash (text-only)", () => {
    expect(classifyComposerInput("!ls -la", false)).toEqual({ kind: "bash", command: "ls -la" });
    // An attachment forces the send path — bash can't carry images.
    expect(classifyComposerInput("!ls", true)).toEqual({ kind: "send", text: "!ls" });
  });

  it("routes `>msg` to participant chat (with or without images)", () => {
    expect(classifyComposerInput(">psst", false)).toEqual({ kind: "chat", text: "psst" });
    expect(classifyComposerInput(">psst", true)).toEqual({ kind: "chat", text: "psst" });
  });

  it("intercepts /stop as a control command, not a message", () => {
    expect(classifyComposerInput("/stop", false)).toEqual({ kind: "stop" });
  });

  it("intercepts /model <alias> and trims the alias", () => {
    expect(classifyComposerInput("/model opus", false)).toEqual({ kind: "model", model: "opus" });
    expect(classifyComposerInput("/model   sonnet-4  ", false)).toEqual({ kind: "model", model: "sonnet-4" });
  });

  it("does not intercept a bare /model (no alias) — falls through to the model", () => {
    expect(classifyComposerInput("/model", false)).toEqual({ kind: "send", text: "/model" });
  });

  // The composer HOLDS attached images back for a slash command (sent bare) and
  // routes it with hasImages=false — so a command paired with images reaches
  // this router as (cmd, false) and is still intercepted. The (cmd, true)
  // combination below is therefore unreachable from the composer; it only
  // documents the raw router's image-gating (the bash/plain path relies on it).
  it("with hasImages=true, does not intercept /stop or /model (router gating)", () => {
    expect(classifyComposerInput("/stop", true)).toEqual({ kind: "send", text: "/stop" });
    expect(classifyComposerInput("/model opus", true)).toEqual({ kind: "send", text: "/model opus" });
  });

  it("intercepts /auto-mode on|off (case-insensitive)", () => {
    expect(classifyComposerInput("/auto-mode on", false)).toEqual({ kind: "auto-mode", on: true });
    expect(classifyComposerInput("/auto-mode off", false)).toEqual({ kind: "auto-mode", on: false });
    expect(classifyComposerInput("/AUTO-MODE ON", false)).toEqual({ kind: "auto-mode", on: true });
    expect(classifyComposerInput("/auto-mode   off  ", false)).toEqual({ kind: "auto-mode", on: false });
  });

  it("treats a bare /auto-mode as a toggle of the current state", () => {
    expect(classifyComposerInput("/auto-mode", false)).toEqual({ kind: "auto-mode", on: "toggle" });
    // The autocomplete splices "/auto-mode " (trailing space) — still a toggle.
    expect(classifyComposerInput("/auto-mode ", false)).toEqual({ kind: "auto-mode", on: "toggle" });
  });

  // The anti-footgun regression: a malformed /auto-mode argument must be caught
  // as an inline error, NOT forwarded to the model as chat (which would silently
  // fail to change a security-relevant setting while looking like it worked).
  it("routes a malformed /auto-mode argument to auto-mode-invalid, not send", () => {
    expect(classifyComposerInput("/auto-mode enable", false)).toEqual({ kind: "auto-mode-invalid" });
    expect(classifyComposerInput("/auto-mode true", false)).toEqual({ kind: "auto-mode-invalid" });
  });

  it("with hasImages=true, does not intercept /auto-mode (router gating)", () => {
    expect(classifyComposerInput("/auto-mode on", true)).toEqual({ kind: "send", text: "/auto-mode on" });
  });

  it("leaves other slash commands (e.g. /plan, /cost) as normal sends to the model", () => {
    expect(classifyComposerInput("/plan add caching", false)).toEqual({ kind: "send", text: "/plan add caching" });
    expect(classifyComposerInput("/cost", false)).toEqual({ kind: "send", text: "/cost" });
    // A message that merely mentions /stop mid-line is not the command.
    expect(classifyComposerInput("please /stop the loop", false)).toEqual({
      kind: "send",
      text: "please /stop the loop",
    });
  });
});

// The `/auto-mode` toggle resolution: explicit on/off passes through; a bare
// `/auto-mode` ("toggle") flips whatever the live state currently is.
describe("resolveAutoMode", () => {
  it("passes an explicit on/off through unchanged", () => {
    expect(resolveAutoMode(true, false)).toBe(true);
    expect(resolveAutoMode(true, true)).toBe(true);
    expect(resolveAutoMode(false, true)).toBe(false);
    expect(resolveAutoMode(false, false)).toBe(false);
  });

  it("flips the current state for a bare /auto-mode (toggle)", () => {
    expect(resolveAutoMode("toggle", false)).toBe(true);
    expect(resolveAutoMode("toggle", true)).toBe(false);
  });
});
