/*
 * hooop-as-agent — drop from the server's uid (hooopd) to the model's uid
 * (agent), then exec the requested command or deliver a signal.
 *
 * Why this exists: the sandbox server and the claude process it spawns used to
 * be the SAME uid. That meant no DAC boundary at all between the trusted
 * control plane and the model — verified on a live container, the model's uid
 * could read the server's /proc/<pid>/environ and fd/, and PTRACE_ATTACH to
 * the server succeeded outright. Any un-gated read or exec primitive the model
 * gained (a new MCP server, a plugin, a future tool) was therefore a full
 * compromise of the host-privileged control socket, no matter how the token
 * file was permissioned. Landlock and the PreToolUse path gate are both
 * allow-list shaped and tool-specific; only separate uids make the boundary
 * tool-agnostic.
 *
 * So the server now runs as `hooopd` and everything that must belong to the
 * model — the claude process, `git clone`, the dashboard's `!bash` fast lane,
 * the session workdir — is launched through this helper instead.
 *
 * WHY SETUID-TO-AGENT AND NOT cap_setuid: this binary is setuid to `agent`,
 * not to root, so its ceiling is precisely the privilege the model already
 * has. A cap_setuid helper could become ANY uid, which makes a bug in it
 * root-equivalent; CAP_SETUID on the long-lived Node process would be worse
 * still, since that process parses attacker-influenced JSON all day.
 *
 * HOW THE CONTROL GROUP IS DROPPED (the subtle part): a setuid-to-agent
 * process holds NO capabilities, so setgroups(2) fails with EPERM and we
 * cannot clear the inherited supplementary group list. The split therefore
 * relies on hooopctl — the group that gates /var/run/hooop — being the server's
 * PRIMARY gid and never a supplementary one (see entrypoint.sh, which starts
 * the server with `setpriv --regid hooopctl --groups <hooop gid>`). Replacing
 * the primary gid here consequently drops hooopctl outright. Because that is
 * load-bearing and easy to break from the launch side, we do not assume it:
 * verify_control_gid_dropped() re-reads the live credentials after the switch
 * and refuses to exec if hooopctl survived anywhere. Fail-closed, because the
 * failure mode is silent — the model's own process tree would keep read access
 * to sandbox.token.
 *
 * Usage:
 *   hooop-as-agent <cmd> [args...]        become agent, then execvp(cmd)
 *   hooop-as-agent --signal <sig> <pid>   become agent, then kill(pid, sig)
 *
 * The signal mode exists because kill(2) permission is not inherited from the
 * parent/child relationship: once claude runs as `agent`, the hooopd server can
 * no longer signal its own child (EPERM), which would break session
 * interrupt, the idle sweeper, /model, the clone timeout and shutdown.
 *
 * Env: none consulted. The environment is passed through to the child
 * untouched, because claude needs it. That is safe here — the only callers
 * able to exec this file are hooopd (the trusted server) and agent itself, for
 * whom becoming agent is a no-op.
 *
 * Exit codes:
 *   125  refusing to run — setuid/setgid bit not effective, agent user
 *        missing, credential switch failed, or hooopctl survived the switch
 *   126  exec failed
 *   1    bad usage / signal delivery failed
 */

#define _GNU_SOURCE

#include <errno.h>
#include <grp.h>
#include <pwd.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

/* Group that gates the control plane (/var/run/hooop, sandbox.sock,
 * sandbox.token). Resolved by name so the gid stays a single fact in the
 * Dockerfile; absent (non-container dev) means there is nothing to drop. */
#define CONTROL_GROUP "hooopctl"

/* The model's account. Resolved by name rather than a baked uid because
 * entrypoint.sh runs `usermod -u $HOOOP_HOST_UID agent` so the host user owns
 * its own bind-mounted profile. */
#define AGENT_USER "agent"

/* Files this process tree creates must stay group-writable: the state dir is
 * setgid `hooop` and has two writers (the hooopd server, and emit-event.sh
 * running as agent), and the server needs to be able to delete a session
 * workdir full of agent-created directories. Both uids are in `hooop` and both
 * already have full run of each other's workspace content; the control plane
 * is protected by uid + hooopctl, never by these bits. */
#define AGENT_UMASK 0002

static void die(const char *msg) {
	fprintf(stderr, "hooop-as-agent: %s\n", msg);
	exit(125);
}

static void die_errno(const char *what) {
	fprintf(stderr, "hooop-as-agent: %s: %s\n", what, strerror(errno));
	exit(125);
}

/*
 * Refuse to continue if the control group is still reachable by the
 * credentials we are about to hand to the model. Checks the primary gid and
 * the whole supplementary list, so a launch-side regression (someone adding
 * hooopctl to hooopd's --groups, or dropping the --regid) is fatal here rather
 * than silently granting the model read access to sandbox.token.
 */
static void verify_control_gid_dropped(void) {
	struct group *ctl = getgrnam(CONTROL_GROUP);
	if (!ctl) return; /* not a hooop container — nothing gates the control plane */

	if (getgid() == ctl->gr_gid || getegid() == ctl->gr_gid)
		die("refusing to exec: " CONTROL_GROUP " is still the primary group after the switch");

	int n = getgroups(0, NULL);
	if (n < 0) die_errno("getgroups");
	if (n == 0) return;

	gid_t *list = calloc((size_t)n, sizeof(gid_t));
	if (!list) die("out of memory");
	if (getgroups(n, list) < 0) die_errno("getgroups");

	for (int i = 0; i < n; i++) {
		if (list[i] == ctl->gr_gid) {
			free(list);
			die("refusing to exec: " CONTROL_GROUP
			    " survived as a supplementary group; it must be the server's primary gid only");
		}
	}
	free(list);
}

/*
 * Become `agent` irrevocably: real, effective and saved ids all switched, so
 * the child cannot seteuid back to hooopd.
 */
static void become_agent(void) {
	struct passwd *pw = getpwnam(AGENT_USER);
	if (!pw) die("no `" AGENT_USER "` user in this image");

	/* The setuid/setgid bits are the entire mechanism. If the image was built
	 * without them, or the container runs with no-new-privileges / a stripped
	 * cap set that neuters them, we must fail LOUDLY: silently continuing
	 * would run claude as the server's own uid and quietly undo the split. */
	if (geteuid() != pw->pw_uid) {
		fprintf(stderr,
		        "hooop-as-agent: setuid bit not effective (euid=%u, expected agent=%u). "
		        "Check the mode on this binary (want 6750 agent:hooop) and that the container "
		        "does not set no-new-privileges.\n",
		        (unsigned)geteuid(), (unsigned)pw->pw_uid);
		exit(125);
	}
	if (getegid() != pw->pw_gid) {
		fprintf(stderr,
		        "hooop-as-agent: setgid bit not effective (egid=%u, expected agent's group=%u). "
		        "Check the mode on this binary (want 6750 agent:hooop).\n",
		        (unsigned)getegid(), (unsigned)pw->pw_gid);
		exit(125);
	}

	/* gid first, while the saved-set still allows it. Both calls are permitted
	 * without capabilities only because the target equals our effective id —
	 * which is exactly what the setuid/setgid bits arranged. */
	if (setresgid(pw->pw_gid, pw->pw_gid, pw->pw_gid) != 0) die_errno("setresgid");
	if (setresuid(pw->pw_uid, pw->pw_uid, pw->pw_uid) != 0) die_errno("setresuid");

	/* Deliberately NO setgroups(2) here.
	 *
	 * The obvious move is setgroups(0, NULL) to clear the inherited supplementary
	 * list, and it is wrong twice over. It cannot work — this process holds no
	 * capabilities, so it fails EPERM — and if it ever DID work (someone grants
	 * the file CAP_SETGID, say) it would drop group `hooop` along with everything
	 * else, and the hook scripts need `hooop` to read hook.token: the permission
	 * gate would start failing on every tool call. So the code would be relying on
	 * one of its own calls to fail, which is a trap for the next reader.
	 *
	 * The inherited groups are safe to keep by construction: they are `hooop` —
	 * which is agent's OWN primary group — and the host's gid, which on every
	 * platform is a group the model's uid naturally belongs to. The one group that
	 * must not survive is the control group, and the primary-gid swap above is what
	 * sheds it. verify_control_gid_dropped() enforces that rather than assuming it. */

	if (getuid() != pw->pw_uid || geteuid() != pw->pw_uid)
		die("uid switch did not stick");
	if (getgid() != pw->pw_gid || getegid() != pw->pw_gid)
		die("gid switch did not stick");

	verify_control_gid_dropped();
	umask(AGENT_UMASK);
}

/*
 * Signal mode. Deliberately a tiny allow-list: these are the only signals the
 * server sends (SIGTERM/SIGKILL for sweeps and shutdown, SIGINT for /stop,
 * 0 for the liveness probe in lib/sessions.ts).
 */
static int do_signal(int argc, char **argv) {
	if (argc != 4) {
		fprintf(stderr, "hooop-as-agent: usage: --signal <sig> <pid>\n");
		return 1;
	}

	char *end = NULL;
	errno = 0;
	long sig = strtol(argv[2], &end, 10);
	if (errno != 0 || !end || *end != '\0') {
		fprintf(stderr, "hooop-as-agent: bad signal `%s`\n", argv[2]);
		return 1;
	}
	if (sig != 0 && sig != SIGTERM && sig != SIGKILL && sig != SIGINT) {
		fprintf(stderr, "hooop-as-agent: signal %ld not permitted\n", sig);
		return 1;
	}

	end = NULL;
	errno = 0;
	long pid = strtol(argv[3], &end, 10);
	if (errno != 0 || !end || *end != '\0' || pid <= 1) {
		fprintf(stderr, "hooop-as-agent: bad pid `%s`\n", argv[3]);
		return 1;
	}

	if (kill((pid_t)pid, (int)sig) != 0) {
		/* ESRCH is the common, boring case: the session already exited. Report
		 * it on stderr and let the caller decide — it is not a helper fault. */
		fprintf(stderr, "hooop-as-agent: kill(%ld, %ld): %s\n", pid, sig, strerror(errno));
		return 1;
	}
	return 0;
}

int main(int argc, char **argv) {
	if (argc < 2) {
		fprintf(stderr,
		        "hooop-as-agent: usage: hooop-as-agent <cmd> [args...]\n"
		        "                      hooop-as-agent --signal <sig> <pid>\n");
		return 1;
	}

	become_agent();

	if (strcmp(argv[1], "--signal") == 0) return do_signal(argc, argv);

	execvp(argv[1], &argv[1]);
	fprintf(stderr, "hooop-as-agent: exec %s: %s\n", argv[1], strerror(errno));
	return 126;
}
