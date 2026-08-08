/**
 * fs.watch that cannot take the server down with it.
 *
 * Node's recursive watcher re-scans subtrees as they change, and when a watched
 * directory disappears underneath it the FSWatcher emits an `'error'` event
 * (ENOENT from readdirSync inside its own #watchFolder). An `'error'` event with
 * no listener does not get swallowed — EventEmitter RETHROWS it — so a vanished
 * directory becomes an uncaught exception that kills the process:
 *
 *     Error: ENOENT: no such file or directory, scandir '.../sessions/<id>'
 *         at #watchFolder (node:internal/fs/recursive_watch:122:21)
 *     Emitted 'error' event on FSWatcher instance
 *
 * Observed for real: the sandbox server died and Docker restarted it, taking
 * every live session with it. The try/catch that every call site already wraps
 * `watch()` in does NOT help — it only covers the synchronous setup throw, not an
 * event emitted minutes later.
 *
 * Directories under a session cwd disappear all the time in normal use: a branch
 * switch that drops a folder, `rm -rf node_modules`, a `hooop mount remove` pulling
 * a watched tree out. Losing the watcher for that path is the correct outcome —
 * the reconciler re-arms watchers when sessions change — so the handler closes the
 * watcher and reports it rather than propagating.
 */

import { watch, type FSWatcher, type WatchListener } from "node:fs";
import { log } from "@shared/logger";

/**
 * The subset of fs.WatchOptions the sandbox actually uses. Narrower than
 * WatchOptions on purpose: that type allows `encoding: "buffer"`, which switches
 * fs.watch to a Buffer listener and makes these overloads ambiguous. Every caller
 * here wants filenames as strings.
 */
type SafeWatchOptions = { recursive?: boolean; persistent?: boolean; signal?: AbortSignal };

/**
 * Same call shapes as fs.watch — `watchSafe(dir, cb)` and
 * `watchSafe(dir, opts, cb)` — plus an `'error'` listener.
 *
 * Still throws synchronously if the path cannot be watched at all, because every
 * caller already treats that as "skip this watcher" and the distinction between
 * "never started" and "died later" is worth keeping.
 */
export function watchSafe(
  target: string,
  options: SafeWatchOptions,
  listener: WatchListener<string>,
): FSWatcher;
export function watchSafe(target: string, listener: WatchListener<string>): FSWatcher;
export function watchSafe(
  target: string,
  optionsOrListener: SafeWatchOptions | WatchListener<string>,
  maybeListener?: WatchListener<string>,
): FSWatcher {
  const w = maybeListener
    ? // encoding pinned so this resolves to fs.watch's string-listener overload
      watch(target, { ...(optionsOrListener as SafeWatchOptions), encoding: "utf8" }, maybeListener)
    : watch(target, optionsOrListener as WatchListener<string>);

  w.on("error", (err: NodeJS.ErrnoException) => {
    // ENOENT is the expected case (the directory went away) but still logged at
    // INFO, not debug: this used to be a process-killing crash, and the server
    // runs at the default `info` minimum, so debug would make the fix invisible
    // in the field — exactly what happened when verifying it, where a handled
    // ENOENT looked identical to the error never firing. Bounded noise: the
    // watcher is closed right after, so it is one line per watcher, not per event.
    const level = err?.code === "ENOENT" ? "info" : "warn";
    log[level]("watch", "watcher stopped", { target, code: err?.code, err: String(err?.message ?? err) });
    try {
      w.close();
    } catch {
      /* already closing */
    }
  });

  return w;
}
