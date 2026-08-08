import type { StatusDotProps } from "../../ui/StatusDot";

/**
 * A preview's state as one of the shell's four status cues.
 *
 * Shared rather than local to the rail because the cue now appears in three
 * places — the collapsed rail's globe, the section tabs, and the phone's ⋯ menu
 * — and three copies of this mapping is three chances for the same app to look
 * running in one of them and idle in another.
 */
export function previewCue(state: string): StatusDotProps["state"] {
  if (state === "failed") return "fail";
  // "wrap" is the settled-and-fine cue. Deliberately not "live", which pulses
  // for work in progress: a running app is a steady state, not an event.
  if (state === "running" || state === "shared") return "wrap";
  if (state === "starting") return "live";
  return "idle";
}
