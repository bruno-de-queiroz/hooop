/**
 * Tests for the bridge back to the model's uid.
 *
 * The real privilege drop needs a setuid binary and two accounts, so it cannot
 * be exercised here — that lives in sandbox/verify-isolation.sh against a built
 * image. What IS testable, and what these pin, is the argv/env contract between
 * the server and the helper. Every failure mode on that seam is silent:
 *
 *   - Argument order. `hooop-as-agent <cmd> [args]` means a reversed prefix would
 *     exec the first ARGUMENT as the command. With a real helper that surfaces as
 *     "exec claude: No such file", after the session has already been registered.
 *   - Signal mapping. The helper takes a NUMBER and rejects anything outside its
 *     allow-list, so a name it doesn't understand turns every kill into a no-op
 *     and sessions stop responding to /stop with nothing logged.
 *   - The unset case. A local checkout and the test suite have no helper at all;
 *     if that degraded to "don't run the command" instead of "run it inline",
 *     nothing would spawn outside the container.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIGINAL_ENV = { ...process.env };
let tmpRoot = "";
let argvLog = "";

/**
 * A stand-in for hooop-as-agent that records the argv it was handed and then
 * behaves like the real one: exec the rest of the command line. Lets us assert
 * on the seam without needing setuid or a second uid.
 */
function fakeHelper(): string {
  const path = join(tmpRoot, "fake-as-agent");
  writeFileSync(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" > "${argvLog}"
[ "$1" = "--signal" ] && exit 0
exec "$@"
`,
  );
  chmodSync(path, 0o755);
  return path;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "as-agent-test-"));
  argvLog = join(tmpRoot, "argv");
  delete process.env.HOOOP_AS_AGENT;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  process.env = { ...ORIGINAL_ENV };
});

/** Fresh import: AS_AGENT is read from env at module load in lib/paths. */
async function load() {
  const { resetModules } = await import("vitest").then((v) => ({ resetModules: v.vi.resetModules }));
  resetModules();
  return import("./as-agent");
}

function collect(child: import("node:child_process").ChildProcess): Promise<string> {
  return new Promise((resolve) => {
    let out = "";
    child.stdout?.on("data", (c: Buffer) => { out += c.toString(); });
    child.once("close", () => resolve(out));
  });
}

describe("canRunAsAgent", () => {
  it("is false without a helper and true with one", async () => {
    expect((await load()).canRunAsAgent()).toBe(false);
    process.env.HOOOP_AS_AGENT = fakeHelper();
    expect((await load()).canRunAsAgent()).toBe(true);
  });
});

describe("spawnAsAgent", () => {
  it("runs the command inline when no helper is configured", async () => {
    const { spawnAsAgent } = await load();
    const out = await collect(spawnAsAgent("echo", ["inline"], {}));
    expect(out.trim()).toBe("inline");
  });

  it("routes through the helper with the command FIRST, then its args", async () => {
    process.env.HOOOP_AS_AGENT = fakeHelper();
    const { spawnAsAgent } = await load();

    const out = await collect(spawnAsAgent("echo", ["hello", "world"], {}));

    // The helper exec'd the real command, so its output still arrives...
    expect(out.trim()).toBe("hello world");
    // ...and it was invoked as `<helper> echo hello world`, not `<helper> hello echo`.
    expect(readFileSync(argvLog, "utf-8").trim()).toBe("echo hello world");
  });

  it("still reports the child's own exit code through the helper", async () => {
    process.env.HOOOP_AS_AGENT = fakeHelper();
    const { spawnAsAgent } = await load();
    const child = spawnAsAgent("sh", ["-c", "exit 3"], {});
    const code = await new Promise<number | null>((r) => child.once("close", (c) => r(c)));
    expect(code).toBe(3);
  });
});

describe("killAsAgent", () => {
  it("passes the signal to the helper as a NUMBER it accepts", async () => {
    process.env.HOOOP_AS_AGENT = fakeHelper();
    const { killAsAgent } = await load();

    expect(killAsAgent(4242, "SIGTERM")).toBe(true);
    expect(readFileSync(argvLog, "utf-8").trim()).toBe("--signal 15 4242");

    expect(killAsAgent(4242, "SIGKILL")).toBe(true);
    expect(readFileSync(argvLog, "utf-8").trim()).toBe("--signal 9 4242");

    expect(killAsAgent(4242, "SIGINT")).toBe(true);
    expect(readFileSync(argvLog, "utf-8").trim()).toBe("--signal 2 4242");
  });

  it("refuses pids that could never be a session", async () => {
    process.env.HOOOP_AS_AGENT = fakeHelper();
    const { killAsAgent } = await load();
    // 1 is the container's init; 0 and negatives are process GROUPS, which would
    // signal far more than the intended session.
    expect(killAsAgent(1, "SIGTERM")).toBe(false);
    expect(killAsAgent(0, "SIGTERM")).toBe(false);
    expect(killAsAgent(-1, "SIGTERM")).toBe(false);
    expect(killAsAgent(undefined, "SIGTERM")).toBe(false);
    expect(existsSync(argvLog)).toBe(false); // never reached the helper
  });

  it("falls back to a direct signal for names the helper has no number for", async () => {
    process.env.HOOOP_AS_AGENT = fakeHelper();
    const { killAsAgent } = await load();

    // A disposable child, NOT process.pid — this runs inside a vitest worker and
    // signalling that takes the whole suite down with it.
    const { spawn } = await import("node:child_process");
    const victim = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((r) => victim.once("close", (_c, s) => r(s)));

    // SIGHUP is not in the helper's allow-list. Handing the helper a number it
    // rejects would fail silently, so this must go direct instead.
    expect(killAsAgent(victim.pid, "SIGHUP" as NodeJS.Signals)).toBe(true);
    expect(await exited).toBe("SIGHUP");
    expect(existsSync(argvLog)).toBe(false);
  });
});

describe("killChildAsAgent", () => {
  it("marks the child killed, as ChildProcess.kill() would have", async () => {
    // Nine sites in active-sessions.ts read child.killed as "we already asked
    // this to die" — the idle sweeper's retry guard, isSessionAlive(), the /stop
    // early-return, needsRevive. Routing kills through the helper skips Node's
    // own bookkeeping, so a killed-but-not-yet-exited session would keep reading
    // as alive and /stop would re-send and re-emit its transcript event.
    process.env.HOOOP_AS_AGENT = fakeHelper();
    const { killChildAsAgent } = await load();
    const { spawn } = await import("node:child_process");

    const child = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
    expect(child.killed).toBe(false);
    expect(killChildAsAgent(child, "SIGTERM")).toBe(true);
    expect(child.killed).toBe(true);

    child.kill("SIGKILL"); // the fake helper only records; really end it
    await new Promise<void>((r) => child.once("close", () => r()));
  });

  it("does not claim a kill it could not deliver", async () => {
    process.env.HOOOP_AS_AGENT = join(tmpRoot, "does-not-exist");
    const { killChildAsAgent } = await load();
    const { spawn } = await import("node:child_process");

    const child = spawn("sh", ["-c", "sleep 30"], { stdio: "ignore" });
    expect(killChildAsAgent(child, "SIGTERM")).toBe(false);
    expect(child.killed).toBe(false);

    child.kill("SIGKILL");
    await new Promise<void>((r) => child.once("close", () => r()));
  });
});

describe("assertAsAgentAvailable", () => {
  it("permits an unsplit server with no helper (local checkout, tests)", async () => {
    // HOME is owned by the user running this, so there is no split to protect.
    const { assertAsAgentAvailable } = await load();
    expect(() => assertAsAgentAvailable()).not.toThrow();
  });
});

describe("mkdirShared", () => {
  it("creates a group-writable setgid dir so both uids can use it", async () => {
    const { mkdirShared } = await load();
    const dir = join(tmpRoot, "nested", "workdir");
    mkdirShared(dir);

    const st = statSync(dir);
    expect(st.mode & 0o770).toBe(0o770); // owner+group rwx
    expect(st.mode & 0o007).toBe(0); // nothing for "other"

    // setgid is what keeps group `hooop` on everything the model creates inside,
    // which is in turn what lets the server delete the tree again.
    //
    // chmod(2) is allowed to drop S_ISGID silently when the caller is not a member
    // of the file's group, and that is easy to trip into on BSD/macOS because new
    // directories inherit their PARENT's group rather than the process's gid. So
    // assert the precondition first: a bare setgid failure would otherwise look
    // like a filesystem that cannot express it, which is not what happens.
    // Measured settable in both real environments — os.tmpdir() on macOS is
    // per-user with the user's own group, and Linux gives new dirs the process gid.
    const myGroups = [process.getgid?.(), ...(process.getgroups?.() ?? [])];
    expect(myGroups).toContain(st.gid);
    expect(st.mode & 0o2000).toBe(0o2000);
  });

  it("is idempotent on an existing dir", async () => {
    const { mkdirShared } = await load();
    const dir = join(tmpRoot, "twice");
    mkdirShared(dir);
    expect(() => mkdirShared(dir)).not.toThrow();
  });
});
