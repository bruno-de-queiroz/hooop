/**
 * Did the previous run exit cleanly?
 *
 * The checkpoint restores every session as `status: "dormant"` regardless of how
 * the last run ended, so a crash is indistinguishable from ordinary idling: the
 * sidebar simply shows sessions gone dormant with no explanation. That is the
 * whole reported symptom — "it is going dormant out of nothing" — for a server
 * that had in fact died and restarted 5 times in an afternoon.
 *
 * Nothing recorded the difference, so nothing could report it. This does: the
 * drain drops a marker file immediately before exiting, and boot consumes it. No
 * marker means the previous process died without draining, and boot can say so.
 *
 * A file rather than a checkpoint field on purpose — the checkpoint is rewritten
 * constantly by saveCheckpoint() during normal operation, so a "clean" flag
 * living inside it would be re-persisted by the very activity it is supposed to
 * describe. This marker is written in exactly one place and deleted in exactly
 * one place.
 */
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "./paths";
import { log } from "@shared/logger";

const MARKER = join(STATE_DIR, "clean-shutdown");

/**
 * Record that this process is exiting on purpose. Called at the very end of the
 * drain — after the final backup/checkpoint — so its presence means "the drain
 * ran to completion", not merely "a signal arrived".
 *
 * Best-effort: failing to write it only costs a spurious "restarted uncleanly"
 * notice on the next boot, which is strictly better than crashing the shutdown.
 */
export function markCleanShutdown(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(MARKER, new Date().toISOString(), "utf-8");
  } catch (err) {
    log.warn("shutdown", "could not write clean-shutdown marker", { err: String(err) });
  }
}

/**
 * Read-and-clear. Returns true when the previous run did NOT drain cleanly.
 *
 * Deletes the marker either way, so the answer is only ever available once per
 * boot and a clean run can't be mistaken for a crash on the boot after it.
 *
 * A brand-new install has no marker and no sessions to report on, so callers
 * should gate any user-facing notice on there being restored sessions rather
 * than on this alone.
 */
export function consumeUncleanShutdown(): boolean {
  let clean = false;
  try {
    clean = existsSync(MARKER);
    if (clean) unlinkSync(MARKER);
  } catch (err) {
    // Can't read or can't remove: treat as clean rather than crying wolf on
    // every subsequent boot (an undeletable marker would otherwise invert into
    // a permanent "unclean" verdict once it goes stale).
    log.warn("shutdown", "clean-shutdown marker check failed", { err: String(err) });
    return false;
  }
  return !clean;
}
