/**
 * Re-enter the model's uid from the server's.
 *
 * The sandbox server runs as `hooopd`; the model runs as `agent`. Work that must
 * BELONG to the model — the claude process, `git clone`, the dashboard's `!bash`
 * fast lane — has to be launched as `agent`, or the workspace fills with files
 * the model cannot write and every `git` invocation in it trips "dubious
 * ownership". Signals need the same treatment for a less obvious reason:
 * kill(2) permission is not inherited from the parent/child relationship, so
 * once claude runs as `agent` the server cannot signal its own child (EPERM),
 * which would silently break session interrupt, the idle sweeper, /model, the
 * clone timeout and shutdown.
 *
 * Everything here degrades to running inline when HOOOP_AS_AGENT is unset: a
 * local checkout has no setuid binary, and the test suite must not need one.
 * That is safe because outside the container there is no split to preserve —
 * server and model are the same uid there, which is the pre-split status quo.
 *
 * See landlock/hooop-as-agent.c for the helper's own contract and fail-closed
 * behaviour (exit 125 when the setuid bit is not effective, or when the control
 * group survived into the credentials it was about to hand the model).
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { AS_AGENT } from "./paths";
import { log } from "@shared/logger";

/**
 * Signals the helper accepts, by number. Kept in step with the allow-list in
 * hooop-as-agent.c — passing a name the helper rejects would turn a working kill
 * into a silent no-op, so the mapping lives in one place and anything outside it
 * falls back to the direct call.
 */
const SIGNAL_NUMBERS: Record<string, number> = {
  SIGTERM: 15,
  SIGKILL: 9,
  SIGINT: 2,
};

/** True when the server can hand work to the model's uid. */
export function canRunAsAgent(): boolean {
  return AS_AGENT.length > 0;
}

/**
 * Refuse to boot a SPLIT server that cannot get back to the model's uid.
 *
 * Without this the failure is a security fail-open, not an outage. Measured on a
 * real container with HOOOP_AS_AGENT emptied: the server comes up as hooopd and
 * spawnAsAgent() degrades to spawning inline, so claude inherits
 * `uid=1101(hooopd) gid=1101(hooopctl)` — i.e. the model runs WITH control-plane
 * group membership and can read sandbox.token and connect the control socket.
 * That is precisely the escalation the uid split exists to close, reintroduced
 * by one empty environment variable. The entrypoint fail-closes too; this is the
 * lock that survives someone bypassing the entrypoint.
 *
 * "Split in effect" is detected by comparing our uid against the OWNER of HOME,
 * rather than by looking for a `hooopd` account: that keeps a plain local
 * checkout (server and profile are the same user) and the test suite working
 * with no helper at all, which is the pre-split status quo and safe by
 * definition.
 */
export function assertAsAgentAvailable(): void {
  const me = process.getuid?.();
  if (me === undefined) return; // non-POSIX: no uids to split

  let homeOwner: number;
  try {
    homeOwner = statSync(homedir()).uid;
  } catch (err) {
    // Cannot tell. Don't brick boot over it — the entrypoint already verified
    // the helper before handing over — but say so, because this is the check
    // that would otherwise catch a silent fail-open.
    log.warn("as-agent", "could not stat HOME; skipping the split-integrity check", {
      home: homedir(),
      err: String(err),
    });
    return;
  }

  if (me === homeOwner) return; // not split: we ARE the model's uid

  if (!canRunAsAgent() || !existsSync(AS_AGENT)) {
    log.fatal(
      "as-agent",
      "refusing to start: this server runs as a different uid than the profile owner, " +
        "but the helper that re-enters the model's uid is missing. Sessions would be " +
        "spawned as the SERVER's user, handing the model control-plane access.",
      { serverUid: me, profileOwnerUid: homeOwner, HOOOP_AS_AGENT: AS_AGENT || null },
    );
    process.exit(1);
  }
}

/**
 * Spawn `file` as the model's uid. Signature-compatible with child_process
 * spawn() so call sites only change which function they call.
 *
 * The helper exec()s the target in place, so the returned ChildProcess wraps the
 * real target: `child.pid` is claude's pid, stdio pipes pass straight through,
 * and exit codes are the target's (except 125/126, which are the helper
 * reporting that it refused to run or could not exec).
 */
export function spawnAsAgent(
  file: string,
  args: string[],
  opts: SpawnOptionsWithoutStdio,
): ChildProcessWithoutNullStreams;
export function spawnAsAgent(file: string, args: string[], opts: SpawnOptions): ChildProcess;
export function spawnAsAgent(file: string, args: string[], opts: SpawnOptions): ChildProcess {
  if (!AS_AGENT) return spawn(file, args, opts);
  return spawn(AS_AGENT, [file, ...args], opts);
}

/**
 * Signal a process running as the model's uid.
 *
 * Synchronous on purpose: every caller replaced a synchronous child.kill(), and
 * the shutdown path in particular cannot await. One fork+exec per signal is a
 * few milliseconds and these are all rare, human-scale events (interrupt, idle
 * sweep, model switch, shutdown).
 *
 * Returns false when the signal could not be delivered — including the common,
 * boring case that the process already exited.
 */
export function killAsAgent(pid: number | undefined, signal: NodeJS.Signals): boolean {
  if (!pid || pid <= 1) return false;

  const signum = SIGNAL_NUMBERS[signal];
  if (!AS_AGENT || signum === undefined) {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false;
    }
  }

  const r = spawnSync(AS_AGENT, ["--signal", String(signum), String(pid)], { encoding: "utf-8" });
  if (r.status === 0) return true;


  // 125 means the helper refused to run at all (setuid bit stripped, control
  // group leaked). That is a misconfigured image rather than a dead process, and
  // it makes every signal a no-op, so say so loudly instead of once per pid.
  if (r.status === 125) {
    log.error("as-agent", "helper refused to run; signals to the model's uid will not be delivered", {
      pid,
      signal,
      stderr: (r.stderr || "").trim(),
    });
  }
  return false;
}

/** Convenience wrapper for the common `child.kill(sig)` replacement. */
export function killChildAsAgent(child: ChildProcess | null | undefined, signal: NodeJS.Signals): boolean {
  if (!child) return false;
  if (!AS_AGENT) {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  const sent = killAsAgent(child.pid, signal);

  // Preserve the invariant the callers actually depend on. Node sets
  // `child.killed` inside ChildProcess.kill(), which we no longer call — and
  // nine sites in active-sessions.ts read it as "we already asked this to die":
  // the idle sweeper's retry guard, isSessionAlive(), the /stop early-return, and
  // the needsRevive decision. Left false forever, a killed-but-not-yet-exited
  // session keeps reading as alive, `/stop` re-sends and re-emits its transcript
  // event, and revive logic can hand work to a dying child.
  //
  // It is a plain own property (verified assignable on this Node), not a getter.
  if (sent) (child as unknown as { killed: boolean }).killed = true;
  return sent;
}

/**
 * Create a directory the model can write into.
 *
 * Session workdirs are created by the server but owned, populated and
 * git-managed by the model, so they are group-writable with the setgid bit set:
 * group `hooop` is shared by both uids, and setgid keeps it on everything the
 * model creates underneath — which is in turn what lets the server delete the
 * whole tree again when the session is removed.
 *
 * mkdir(2) masks the mode through the umask and drops setgid on some
 * filesystems, so the mode is re-applied explicitly rather than trusted to the
 * recursive create.
 */
export function mkdirShared(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o2770 });
  // Unconditionally, and NOT gated on the helper being present: mkdir(2) masks
  // its mode through the caller's umask, so the create alone yields 0750 under a
  // default 022 and the group loses write. Re-applying is the only way the mode
  // is the one asked for rather than the one the ambient umask allowed.
  try {
    chmodSync(dir, 0o2770);
  } catch (err) {
    // Non-fatal, and the interesting failure is the setgid bit rather than the
    // permission bits: chmod(2) may drop S_ISGID — silently, or with EPERM — when
    // the caller is not a member of the directory's group. Losing it only costs
    // group inheritance for children created later, and on the macOS bind mount it
    // costs nothing at all, since virtiofs does not enforce DAC there.
    log.debug("as-agent", "could not set shared mode on workdir", { dir, err: String(err) });
  }
}
