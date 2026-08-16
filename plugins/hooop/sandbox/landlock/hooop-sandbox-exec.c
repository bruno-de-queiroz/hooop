/*
 * hooop-sandbox-exec — apply a Landlock filesystem ruleset to THIS process,
 * then exec the requested command.
 *
 * Why: the hooop sandbox container already runs as an unprivileged user, but
 * that user can still read/write anywhere its uid can reach (the whole
 * bind-mounted profile, /tmp, etc). Landlock (Linux LSM, upstream since
 * 5.13, ABI v3 lets us also gate ftruncate()) lets an UNPRIVILEGED process
 * restrict itself (and every descendant it execs) to an explicit path
 * allow-list — no namespaces, no capabilities, no setuid bit needed on this
 * binary. Once landlock_restrict_self() succeeds, any open()/exec()/etc.
 * outside the allow-list returns EACCES for the rest of this process tree,
 * even for a compromised child (a landlock ruleset can only be narrowed by
 * a child, never widened — that's the whole point of the LSM).
 *
 * This is a small, dependency-free (libc + linux headers only) exec wrapper:
 * it does NOT use libseccomp or any other sandboxing library. It talks to
 * the three landlock syscalls directly via syscall(2) because glibc does not
 * (as of writing) ship wrappers for them.
 *
 * Usage:
 *   hooop-sandbox-exec <cmd> [args...]
 *
 * Env vars consulted:
 *   HOOOP_LANDLOCK_RW    colon-separated absolute paths granted full
 *                       read/write/exec/create/delete access (subject to
 *                       what the running kernel's Landlock ABI supports).
 *   HOOOP_LANDLOCK_RO    colon-separated absolute paths granted read +
 *                       execute + directory-listing access only.
 *
 *                       Both lists are colon-separated, so a path CONTAINING
 *                       a colon cannot be expressed here. The caller
 *                       (lib/landlock-policy.ts) rejects such paths rather
 *                       than passing them through — silently splitting one
 *                       into two would grant a DIFFERENT directory. Entries
 *                       must be absolute; relative ones are skipped (see
 *                       add_rules_for_list).
 *   HOOOP_LANDLOCK_MODE  "enforce" (default) or "permissive".
 *                         enforce:    any failure to build/apply the
 *                                     ruleset is FATAL (fail-closed) —
 *                                     we refuse to exec unsandboxed.
 *                         permissive: best-effort; if Landlock is
 *                                     unavailable on this kernel we just
 *                                     skip straight to exec (useful for
 *                                     local dev on older kernels / non-Linux
 *                                     CI containers running under emulation).
 *
 * Either env var may be empty or absent (an all-or-nothing allow-list of
 * zero paths is legal — it just means nothing is reachable in that class).
 *
 * Exit codes:
 *   2   usage error (argc < 2)
 *   126 Landlock could not be applied while in enforce mode
 *   127 execvp() of the target command failed
 */

#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/prctl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

/* Pull in the real header when the build environment has a recent enough
 * <linux/landlock.h>. It's fine if it's old or missing entirely — every
 * type/constant we need is re-declared below under #ifndef guards, so this
 * file compiles against any glibc/kernel-headers combination. */
#if __has_include(<linux/landlock.h>)
#include <linux/landlock.h>
#else
#include <linux/types.h> /* __u64 / __s32, normally pulled in by landlock.h */
#endif

/* --------------------------------------------------------------------- *
 * Landlock syscall numbers.
 *
 * glibc does not wrap these (as of the versions shipped by common
 * distros), so we invoke them via raw syscall(2). The numbers are
 * architecture-independent across the two targets this image runs on
 * (x86_64 and aarch64) — Landlock's syscalls were added to the generic
 * syscall table at the same numbers for every architecture that has them.
 * --------------------------------------------------------------------- */
#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef SYS_landlock_add_rule
#define SYS_landlock_add_rule 445
#endif
#ifndef SYS_landlock_restrict_self
#define SYS_landlock_restrict_self 446
#endif

/* --------------------------------------------------------------------- *
 * Fallback type/constant definitions.
 *
 * `<linux/landlock.h>` has shipped the ruleset/path-beneath structs and the
 * enum landlock_rule_type together since the very first (ABI v1) revision
 * of the header, always alongside LANDLOCK_CREATE_RULESET_VERSION. That
 * makes LANDLOCK_CREATE_RULESET_VERSION a reliable "is the header present
 * at all" signal: if it's undefined, the header is missing entirely (or
 * predates Landlock outright) and we must declare the full v1 struct/const
 * set ourselves below. If it IS defined, the structs already exist — we
 * must NOT redeclare them (that's a hard compile error, not just a
 * shadowing warning) — but the header may still predate later ABI
 * revisions, so the v2 (REFER) and v3 (TRUNCATE) rights are backfilled
 * independently afterward, each under its own #ifndef. This split matters
 * in practice: Debian bookworm's kernel-headers package ships a header with
 * structs + v1 + v2 (REFER) rights, but not yet v3's TRUNCATE.
 * --------------------------------------------------------------------- */

#ifndef LANDLOCK_CREATE_RULESET_VERSION
/* <linux/landlock.h> is missing or predates Landlock entirely: provide the
 * complete ABI v1 struct + constant set from scratch. */
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#define LANDLOCK_RULE_PATH_BENEATH 1

#define LANDLOCK_ACCESS_FS_EXECUTE     (1ULL << 0)
#define LANDLOCK_ACCESS_FS_WRITE_FILE  (1ULL << 1)
#define LANDLOCK_ACCESS_FS_READ_FILE   (1ULL << 2)
#define LANDLOCK_ACCESS_FS_READ_DIR    (1ULL << 3)
#define LANDLOCK_ACCESS_FS_REMOVE_DIR  (1ULL << 4)
#define LANDLOCK_ACCESS_FS_REMOVE_FILE (1ULL << 5)
#define LANDLOCK_ACCESS_FS_MAKE_CHAR   (1ULL << 6)
#define LANDLOCK_ACCESS_FS_MAKE_DIR    (1ULL << 7)
#define LANDLOCK_ACCESS_FS_MAKE_REG    (1ULL << 8)
#define LANDLOCK_ACCESS_FS_MAKE_SOCK   (1ULL << 9)
#define LANDLOCK_ACCESS_FS_MAKE_FIFO   (1ULL << 10)
#define LANDLOCK_ACCESS_FS_MAKE_BLOCK  (1ULL << 11)
#define LANDLOCK_ACCESS_FS_MAKE_SYM    (1ULL << 12)

struct landlock_ruleset_attr {
	__u64 handled_access_fs;
};

struct landlock_path_beneath_attr {
	__u64 allowed_access;
	__s32 parent_fd;
} __attribute__((packed));
#endif /* !LANDLOCK_CREATE_RULESET_VERSION */

/* ABI v2: reparenting right, added to upstream headers alongside kernel
 * 5.19. Backfilled independently of the block above since a header can
 * ship the v1 struct/consts without it yet. */
#ifndef LANDLOCK_ACCESS_FS_REFER
#define LANDLOCK_ACCESS_FS_REFER (1ULL << 13)
#endif

/* ABI v3: truncate right, added to upstream headers alongside kernel 6.2.
 * This is the one most likely to be missing on current-stable distro
 * kernel-headers packages (e.g. Debian bookworm), hence the independent
 * guard. */
#ifndef LANDLOCK_ACCESS_FS_TRUNCATE
#define LANDLOCK_ACCESS_FS_TRUNCATE (1ULL << 14)
#endif

/* --------------------------------------------------------------------- *
 * Small helpers
 * --------------------------------------------------------------------- */

/* True when HOOOP_LANDLOCK_MODE requests best-effort (non-fatal) behavior.
 * Any value other than the literal string "permissive" is treated as
 * "enforce" — fail-closed by default. */
static int is_permissive(void) {
	const char *mode = getenv("HOOOP_LANDLOCK_MODE");
	return mode != NULL && strcmp(mode, "permissive") == 0;
}

/* Fatal-or-not exit helper for the enforce/permissive split: in enforce
 * mode we print `msg` and exit 126 (fail-closed — refuse to run the target
 * command unsandboxed); in permissive mode we print a warning and return so
 * the caller can fall through to a plain execvp(). */
static void landlock_fail(int permissive, const char *msg) {
	if (permissive) {
		fprintf(stderr, "hooop-sandbox-exec: warning: %s (permissive mode, continuing unsandboxed)\n", msg);
		return;
	}
	fprintf(stderr, "hooop-sandbox-exec: fatal: %s\n", msg);
	exit(126);
}

/* Rights that Landlock permits on a NON-directory. The kernel rejects a rule
 * carrying any directory-only right when the fd isn't a directory:
 *   security/landlock/syscalls.c:
 *     if (!d_is_dir(dentry) && (allowed | ACCESS_FILE) != ACCESS_FILE)
 *             return -EINVAL;
 * so a file-granular grant (e.g. /dev/null, ~/.gitconfig) MUST be masked down
 * to this set or the whole rule is silently rejected. */
#define HOOOP_LANDLOCK_ACCESS_FILE ( \
	LANDLOCK_ACCESS_FS_EXECUTE | \
	LANDLOCK_ACCESS_FS_WRITE_FILE | \
	LANDLOCK_ACCESS_FS_READ_FILE | \
	LANDLOCK_ACCESS_FS_TRUNCATE)

/*
 * Open every colon-separated path in `list` (a mutable copy is made
 * internally via strtok_r) and landlock_add_rule() it into `ruleset_fd`
 * with `allowed_access`.
 *
 * Missing paths are skipped with a warning rather than treated as fatal —
 * the RW/RO lists are computed in TypeScript from a broad, static superset
 * (e.g. "/opt/hooop", "~/.claude") that may not exist on every profile, and
 * refusing to sandbox at all over an optional path would defeat the purpose.
 * A path that EXISTS but whose rule can't be installed is a different story:
 * that's fatal in enforce mode, because silently continuing would build a
 * ruleset that grants less than the caller asked for (or, for an RW root,
 * nothing at all) while still reporting success.
 *
 * Three properties this function enforces, each of which was a real escape
 * or a real breakage before:
 *
 *   1. ABSOLUTE PATHS ONLY. A relative entry resolves against the wrapper's
 *      cwd, which is the session workdir — so a stray "inner" token would
 *      grant <cwd>/inner instead of failing. The header promises absolute
 *      paths; enforce it rather than trusting the caller.
 *
 *   2. O_NOFOLLOW. Landlock attaches a rule to the inode behind the fd, so
 *      opening a symlink grants its TARGET. With the session workdir
 *      writable by the model's own (unconfined) process, `rmdir <cwd> &&
 *      ln -s / <cwd>` would turn the next spawn's RW grant into "/". The
 *      caller canonicalizes before building the list; refusing to follow
 *      here is the defense-in-depth check that catches a swap inside the
 *      TOCTOU window between that canonicalization and this open().
 *
 *      Skipping a symlink is always fail-CLOSED (no rule added means no
 *      access granted), so `symlink_fatal` is not about safety — it's about
 *      diagnosability. For RW it's on: the one entry that matters is the
 *      session workdir, and losing it would otherwise surface as a cascade
 *      of confusing EACCES instead of one clear error. For RO it's off,
 *      because on a merged-/usr distro (Debian, and so this image) /bin,
 *      /sbin, /lib and /lib64 are all symlinks into /usr — skipping them is
 *      harmless precisely because Landlock evaluates the RESOLVED path, and
 *      /usr is granted in its own right.
 *
 *   3. NON-DIRECTORY MASKING. See HOOOP_LANDLOCK_ACCESS_FILE above.
 */
static void add_rules_for_list(int ruleset_fd, const char *list, __u64 allowed_access, int permissive, int symlink_fatal) {
	if (list == NULL || list[0] == '\0') return;

	char *copy = strdup(list);
	if (copy == NULL) {
		landlock_fail(permissive, "strdup failed while parsing path list");
		return;
	}

	char *saveptr = NULL;
	for (char *path = strtok_r(copy, ":", &saveptr); path != NULL; path = strtok_r(NULL, ":", &saveptr)) {
		if (path[0] == '\0') continue;

		if (path[0] != '/') {
			fprintf(stderr, "hooop-sandbox-exec: warning: skipping non-absolute path entry %s\n", path);
			continue;
		}

		/* NOTE: O_PATH|O_NOFOLLOW does NOT fail on a symlink — per open(2),
		 * that exact combination returns an fd referring to the SYMLINK
		 * ITSELF rather than ELOOP. That's what we want (it means we never
		 * accidentally resolve to the target), but it does mean the symlink
		 * check has to be an explicit S_ISLNK test below, not an errno
		 * check. Without O_NOFOLLOW the open would silently follow to the
		 * target and hand Landlock the target's inode. */
		int fd = open(path, O_PATH | O_NOFOLLOW | O_CLOEXEC);
		if (fd < 0) {
			fprintf(stderr, "hooop-sandbox-exec: warning: skipping unreachable path %s: %s\n", path, strerror(errno));
			continue;
		}

		/* fstat works on an O_PATH fd (Linux 3.6+). */
		struct stat st;
		if (fstat(fd, &st) != 0) {
			fprintf(stderr, "hooop-sandbox-exec: warning: fstat failed for %s: %s\n", path, strerror(errno));
			close(fd);
			continue;
		}

		/* A symlink here is the escape described in #2. Never grant through
		 * it; whether that's fatal or merely loud depends on the list (see
		 * #2 — RW yes, RO no). */
		if (S_ISLNK(st.st_mode)) {
			int fatal = symlink_fatal && !permissive;
			fprintf(stderr, "hooop-sandbox-exec: %s: allow-list entry %s is a symlink; refusing to grant access through it\n",
				fatal ? "fatal" : "warning", path);
			close(fd);
			if (fatal) {
				free(copy);
				exit(126);
			}
			continue;
		}

		/* A non-directory can only carry the file-granular rights (see #3). */
		__u64 access = allowed_access;
		if (!S_ISDIR(st.st_mode)) access &= (__u64)HOOOP_LANDLOCK_ACCESS_FILE;

		struct landlock_path_beneath_attr attr;
		memset(&attr, 0, sizeof(attr));
		attr.allowed_access = access;
		attr.parent_fd = fd;

		if (syscall(SYS_landlock_add_rule, ruleset_fd, LANDLOCK_RULE_PATH_BENEATH, &attr, 0) != 0) {
			fprintf(stderr, "hooop-sandbox-exec: %s: landlock_add_rule failed for %s: %s\n",
				permissive ? "warning" : "fatal", path, strerror(errno));
			if (!permissive) {
				close(fd);
				free(copy);
				exit(126);
			}
		}
		close(fd);
	}

	free(copy);
}

int main(int argc, char **argv) {
	if (argc < 2) {
		fprintf(stderr, "usage: hooop-sandbox-exec <cmd> [args...]\n");
		return 2;
	}

	const int permissive = is_permissive();

	/* Restore TMPDIR from TMP when it is missing.
	 *
	 * TMPDIR is on glibc's unsecvars list, so exec'ing the setuid hooop-as-agent
	 * helper strips it from the environment while TMP and TEMP (not on that list)
	 * survive. The server sets all three to the session's own ./tmp, so without
	 * this the only one that mattered to coreutils is the one that never arrives:
	 * `mktemp` honours TMPDIR alone and would drop its files in the /tmp every
	 * session shares, which is exactly what pointing the vars somewhere private
	 * was for. Verified on a live session: TMP and TEMP present, TMPDIR absent.
	 *
	 * Safe here rather than in the setuid helper: this binary is not setuid and
	 * runs as the model's uid already, so nothing privileged reads the value. Only
	 * ever fills a gap, never overrides a TMPDIR the caller set deliberately. */
	if (getenv("TMPDIR") == NULL) {
		const char *tmp = getenv("TMP");
		if (tmp != NULL && *tmp != '\0') setenv("TMPDIR", tmp, 1);
	}

	/* --- Step 1: query the kernel's supported Landlock ABI version. ---
	 * Per the landlock(7) man page, calling landlock_create_ruleset with a
	 * NULL attr pointer and LANDLOCK_CREATE_RULESET_VERSION as the flags
	 * returns the highest ABI version the running kernel supports (a
	 * positive integer), or -1/errno on kernels with no Landlock support
	 * at all (ENOSYS) or where it's compiled out / disabled (EOPNOTSUPP). */
	int abi = (int)syscall(SYS_landlock_create_ruleset, NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
	/* abi < 1 covers both "no Landlock at all" (errno ENOSYS, pre-5.13
	 * kernel) and "Landlock compiled out / disabled" (errno EOPNOTSUPP,
	 * e.g. locked down by CONFIG_SECURITY_LANDLOCK=n or a restrictive LSM
	 * stack) — either way there's no ruleset to build. */
	if (abi < 1) {
		if (permissive) {
			fprintf(stderr, "hooop-sandbox-exec: warning: Landlock unavailable on this kernel (abi=%d, errno=%s); permissive mode, executing unsandboxed\n", abi, strerror(errno));
			execvp(argv[1], &argv[1]);
			perror("execvp");
			return 127;
		}
		fprintf(stderr, "hooop-sandbox-exec: fatal: Landlock unavailable on this kernel (abi=%d, errno=%s); refusing to run unsandboxed (enforce mode)\n", abi, strerror(errno));
		return 126;
	}

	/* --- Step 2: build the handled-access mask for the ABI we actually
	 * have. Landlock requires handled_access_fs to be a subset of what the
	 * running kernel supports; requesting a right the kernel doesn't know
	 * about makes landlock_create_ruleset fail with EINVAL. We start from
	 * the full v3 rights set and mask off newer rights when the kernel's
	 * ABI predates them. */
	__u64 handled = LANDLOCK_ACCESS_FS_EXECUTE
		| LANDLOCK_ACCESS_FS_WRITE_FILE
		| LANDLOCK_ACCESS_FS_READ_FILE
		| LANDLOCK_ACCESS_FS_READ_DIR
		| LANDLOCK_ACCESS_FS_REMOVE_DIR
		| LANDLOCK_ACCESS_FS_REMOVE_FILE
		| LANDLOCK_ACCESS_FS_MAKE_CHAR
		| LANDLOCK_ACCESS_FS_MAKE_DIR
		| LANDLOCK_ACCESS_FS_MAKE_REG
		| LANDLOCK_ACCESS_FS_MAKE_SOCK
		| LANDLOCK_ACCESS_FS_MAKE_FIFO
		| LANDLOCK_ACCESS_FS_MAKE_BLOCK
		| LANDLOCK_ACCESS_FS_MAKE_SYM
		| LANDLOCK_ACCESS_FS_REFER
		| LANDLOCK_ACCESS_FS_TRUNCATE;

	/* CAREFUL: every right above needs a matching mask-off line here for the
	 * ABI that introduced it. Miss one and landlock_create_ruleset returns
	 * EINVAL on every kernel older than that ABI — which, in enforce mode,
	 * bricks every spawn with exit 126. If this list grows much further,
	 * replace it with a {bit, min_abi} table so the pairing can't be
	 * forgotten.
	 *
	 * Deliberately NOT handled: LANDLOCK_ACCESS_FS_IOCTL_DEV (bit 15, ABI v5
	 * / kernel 6.10). Unhandled rights are always ALLOWED, so ioctl() on a
	 * device file the process can already open is ungated. Acceptable here:
	 * the only device paths in any profile are the /dev character devices
	 * (null/zero/urandom/tty), and the image has no block devices. */
	if (abi < 2) handled &= ~(__u64)LANDLOCK_ACCESS_FS_REFER;
	if (abi < 3) handled &= ~(__u64)LANDLOCK_ACCESS_FS_TRUNCATE;

	struct landlock_ruleset_attr ruleset_attr;
	memset(&ruleset_attr, 0, sizeof(ruleset_attr));
	ruleset_attr.handled_access_fs = handled;
	/* No handled_access_net field: that's an ABI v4+ addition for network
	 * rules, out of scope here (filesystem confinement only, through v3),
	 * and older kernel-headers' struct layout doesn't have the member. */

	int ruleset_fd = (int)syscall(SYS_landlock_create_ruleset, &ruleset_attr, sizeof(ruleset_attr), 0);
	if (ruleset_fd < 0) {
		landlock_fail(permissive, "landlock_create_ruleset failed");
		if (!permissive) return 126; /* unreachable (landlock_fail exits), kept for clarity */
	} else {
		/* --- Step 3: add rules from the RW then RO env allow-lists. ---
		 * RW gets the full handled mask (every right the kernel supports,
		 * intersected with what we asked the ruleset to handle). RO is
		 * restricted to read + execute + directory-listing, so a path like
		 * /usr can be traversed and its binaries exec'd but never written
		 * to, created in, or deleted from. */
		__u64 rw_access = handled;
		__u64 ro_access = handled & (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_DIR);

		add_rules_for_list(ruleset_fd, getenv("HOOOP_LANDLOCK_RW"), rw_access, permissive, /* symlink_fatal */ 1);
		add_rules_for_list(ruleset_fd, getenv("HOOOP_LANDLOCK_RO"), ro_access, permissive, /* symlink_fatal */ 0);

		/* --- Step 4: no-new-privs is a mandatory precondition for an
		 * unprivileged process to call landlock_restrict_self(2). --- */
		if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) {
			landlock_fail(permissive, "prctl(PR_SET_NO_NEW_PRIVS) failed");
		} else if (syscall(SYS_landlock_restrict_self, ruleset_fd, 0) != 0) {
			landlock_fail(permissive, "landlock_restrict_self failed");
		}

		close(ruleset_fd);
	}

	/* --- Step 5: exec the real target. From this point on, argv[1] and
	 * everything it (recursively) execs is confined to the allow-lists
	 * above — Landlock rules survive execve() and can only be narrowed by
	 * descendants, never widened. --- */
	execvp(argv[1], &argv[1]);
	perror("execvp");
	return 127;
}
