#!/usr/bin/env bash
# verify-isolation.sh — acceptance gate for the server/model uid split.
#
# Runs against a LIVE container, because nothing here can be unit tested: the
# property under test is "two uids, and the kernel refuses to let one reach the
# other's socket", which needs a real image, real accounts and a real setuid bit.
# CI runs neither (ubuntu-latest, no docker step), so this is the gate a human
# runs after `hooop rebuild` — and the thing to re-run before trusting any change
# to entrypoint.sh, the Dockerfile, or the compose file's group_add.
#
# What it proves, in the order that matters:
#
#   1. The server and the model really are different uids.
#   2. The model cannot traverse the control-plane directory, cannot read
#      sandbox.token, and cannot connect() the control socket. That last one is
#      the whole point: Landlock (ABI 3) gates open(), NOT AF_UNIX connect(), so
#      a confined shell can always reach a socket it can traverse to. DAC is the
#      only thing that stops it.
#   3. The exact escalation this split exists to close — read the token, then
#      curl the control socket as `host` and self-approve — fails end to end.
#   4. The model can still reach the HOOK plane, or the permission gate breaks
#      and every tool call starts denying.
#   5. The helper is setuid, is exec'able only by the server (and by agent, for
#      whom it is a no-op), and sheds the control group when it drops.
#   6. The model can no longer PTRACE_ATTACH the server. Before the split this
#      succeeded, which made every other lock decorative.
#
# Scope note: the profile's own permissions are deliberately NOT asserted here.
# On macOS Docker Desktop the profile is a virtiofs bind mount that does not
# enforce DAC at all — a 0600 file there is readable by every uid in the
# container — so any such assertion would pass on Linux and be meaningless on the
# platform most of this is developed on. Everything below lives on a named volume
# or container overlayfs, where the modes are enforced identically on both.
#
# Usage:
#   plugins/hooop/sandbox/verify-isolation.sh [-q|--quiet] [container] [dashboard-container]
#
#   -q, --quiet   Print only failures, then one `SUMMARY <passed> <total>` line.
#                 This is what `hooop doctor` consumes, so that doctor reports the
#                 real checks rather than carrying its own drifting copy of them.
#
# Exit: 0 when every check passes, 1 otherwise.

set -uo pipefail

QUIET=0
SANDBOX="hooop-agent-sandbox-1"
DASHBOARD="hooop-dashboard-1"

# Positional parsing without arrays: this also runs from `hooop doctor` on a macOS
# host, i.e. bash 3.2, where `${arr[0]}` on an empty array trips `set -u`.
_argn=0
for _a in "$@"; do
	case "$_a" in
		-q|--quiet) QUIET=1 ;;
		-h|--help) sed -n '2,40p' "$0"; exit 0 ;;
		*)
			_argn=$((_argn + 1))
			[ "$_argn" = 1 ] && SANDBOX="$_a"
			[ "$_argn" = 2 ] && DASHBOARD="$_a"
			;;
	esac
done

# Kept in step with entrypoint.sh — the gate asserts the split those names define.
SERVER_USER_NAME="hooopd"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
	_GR=$'\033[32m'; _RD=$'\033[31m'; _YL=$'\033[33m'; _DIM=$'\033[2m'; _B=$'\033[1m'; _RST=$'\033[0m'
else
	_GR=""; _RD=""; _YL=""; _DIM=""; _B=""; _RST=""
fi

FAILED=0
PASSED=0
SKIPPED=0

# In quiet mode only failures reach the caller, so a passing run is silent apart
# from the SUMMARY line. Failures go to STDOUT there (not stderr) because doctor
# captures them to re-print in its own idiom.
_head() { [ "$QUIET" = 1 ] || printf "\n${_B}%s${_RST}\n" "$*"; }
_pass() { PASSED=$((PASSED + 1)); [ "$QUIET" = 1 ] || printf "  ${_GR}✔${_RST}  %s\n" "$*"; }
_skip() { SKIPPED=$((SKIPPED + 1)); [ "$QUIET" = 1 ] || printf "  ${_YL}-${_RST}  %s ${_DIM}(skipped)${_RST}\n" "$*"; }
_note() { [ "$QUIET" = 1 ] || printf "     ${_DIM}%s${_RST}\n" "$*"; }
_fail() {
	FAILED=$((FAILED + 1))
	if [ "$QUIET" = 1 ]; then printf "%s\n" "$*"
	else printf "  ${_RD}✘${_RST}  %s\n" "$*" >&2; fi
}

# Abort a run that cannot produce meaningful answers. Goes through _fail so quiet
# mode still emits the reason, and still prints the SUMMARY line the caller parses
# — an early exit without one reads to doctor as "no output", i.e. a pass.
_bail() {
	_fail "$*"
	[ "$QUIET" = 1 ] && printf "SUMMARY %d %d\n" "$PASSED" "$((PASSED + FAILED))"
	exit 1
}

# Run a command in the sandbox as a given user. Never inherits a TTY, so this
# behaves the same interactively and from a script.
_as() { local u="$1"; shift; docker exec -u "$u" "$SANDBOX" "$@" 2>&1; }

# Assert a command SUCCEEDS / FAILS as a given user.
_expect_ok() {
	local label="$1" u="$2"; shift 2
	local out; out="$(_as "$u" "$@")"
	if [ $? -eq 0 ]; then _pass "$label"; else _fail "$label"; _note "${out:-(no output)}"; fi
}
_expect_denied() {
	local label="$1" u="$2"; shift 2
	local out; out="$(_as "$u" "$@")"
	if [ $? -ne 0 ]; then _pass "$label"; else _fail "$label — SUCCEEDED, it must not"; _note "${out:-(no output)}"; fi
}

if ! docker inspect "$SANDBOX" >/dev/null 2>&1; then
	_bail "container '$SANDBOX' is not running. Start it with: hooop start"
fi

[ "$QUIET" = 1 ] || printf "${_B}sandbox isolation${_RST} ${_DIM}(%s)${_RST}\n" "$SANDBOX"

# Wait for the server to be up before asserting anything.
#
# This is not politeness, it is correctness: almost every check below is of the
# form "the model CANNOT reach X", and a socket that does not exist yet is
# unreachable for entirely the wrong reason. Running this mid-boot produces a
# screen of green ticks that prove nothing — and the entrypoint's root phase also
# hasn't re-stamped the helper's ownership yet, so the helper checks report a
# stale owner. Both were observed before this guard existed.
_wait_ready() {
	local deadline=$((SECONDS + 90)) health
	while [ "$SECONDS" -lt "$deadline" ]; do
		health="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$SANDBOX" 2>/dev/null)"
		case "$health" in
			healthy) return 0 ;;
			none)
				# No healthcheck defined: fall back to the socket being live.
				docker exec "$SANDBOX" test -S /var/run/hooop/sandbox.sock 2>/dev/null && return 0
				;;
		esac
		sleep 2
	done
	return 1
}

if _wait_ready; then
	_pass "sandbox is up (server listening)"
else
	_note "docker logs $SANDBOX"
	_bail "sandbox never became healthy — every 'cannot reach' check below would pass vacuously"
fi

# Belt and braces on the same trap: assert the sockets EXIST (as root, which DAC
# does not apply to) before asserting the model cannot reach them.
for s in /var/run/hooop/sandbox.sock /var/run/hooop/sandbox.token /run/hooop-hooks/hook.sock; do
	if ! _as root test -e "$s" >/dev/null; then
		_bail "$s does not exist — the checks below cannot distinguish 'denied' from 'absent'"
	fi
done

# --- Identities ---------------------------------------------------------------
_head "identities"

# Preflight, so a pre-split image produces ONE actionable line instead of twenty
# confusing ones. Numeric-only capture: `id -u` prints a diagnostic to stdout
# when the user is missing, and that string would otherwise be compared as a uid.
_num() { local v; v="$(_as root "$@" | tr -cd '0-9')"; echo "$v"; }

AGENT_UID="$(_num id -u agent)"
HOOOPD_UID="$(_num id -u hooopd)"
CTL_GID="$(_as root sh -c 'getent group hooopctl | cut -d: -f3' | tr -cd '0-9')"
HOOOP_GID="$(_as root sh -c 'getent group hooop | cut -d: -f3' | tr -cd '0-9')"

if [ -z "$HOOOPD_UID" ] || [ -z "$CTL_GID" ]; then
	_missing="no 'hooopctl' group"; [ -z "$HOOOPD_UID" ] && _missing="no 'hooopd' user"
	_note "rebuild the image, then re-run this gate:  hooop rebuild"
	_bail "this container predates the uid split ($_missing); run: hooop rebuild"
fi

if [ -n "$AGENT_UID" ] && [ "$AGENT_UID" != "$HOOOPD_UID" ]; then
	_pass "agent ($AGENT_UID) and hooopd ($HOOOPD_UID) are distinct uids"
else
	_fail "expected two distinct uids, got agent='$AGENT_UID' hooopd='$HOOOPD_UID'"
fi
_pass "control group hooopctl = gid $CTL_GID"

# The server process itself, found by cmdline so we never guess a pid.
# Match on the cmdline's FIRST field being `node`, not on the whole string: the
# scanning shell's own cmdline contains "dist/server.mjs" (it is in this very
# command), so a substring match finds that transient process, which has exited
# by the time we read its status.
#
# /proc/PID/exe would be the obvious discriminator and does NOT work here: the
# server changed credentials via setpriv, which clears its `dumpable` flag, and
# reading exe/fd/environ of a non-dumpable process needs CAP_SYS_PTRACE — which
# Docker's default capability set omits, so even root in this container is
# refused. cmdline stays readable.
SRV_PID="$(_as root sh -c 'for p in /proc/[0-9]*; do
  pid=${p#/proc/}; [ "$pid" = 1 ] && continue
  first=$(tr "\0" "\n" < "$p/cmdline" 2>/dev/null | head -1)
  case "${first##*/}" in node) ;; *) continue ;; esac
  tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "dist/server.mjs" && { echo "$pid"; break; }
done' | tr -d '\r')"

if [ -z "$SRV_PID" ]; then
	_fail "could not find the server process — is the sandbox healthy?"
else
	SRV_UID="$(_as root sh -c "awk '/^Uid:/{print \$2}' /proc/$SRV_PID/status" | tr -d '\r')"
	SRV_GID="$(_as root sh -c "awk '/^Gid:/{print \$2}' /proc/$SRV_PID/status" | tr -d '\r')"
	SRV_GROUPS="$(_as root sh -c "awk '/^Groups:/{\$1=\"\"; print}' /proc/$SRV_PID/status" | tr -d '\r')"

	if [ "$SRV_UID" = "$HOOOPD_UID" ]; then
		_pass "server runs as hooopd (uid $SRV_UID), not as the model"
	else
		_fail "server runs as uid $SRV_UID; expected hooopd ($HOOOPD_UID)"
	fi

	if [ "$SRV_GID" = "$CTL_GID" ]; then
		_pass "server's PRIMARY gid is hooopctl ($CTL_GID)"
	else
		_fail "server's primary gid is $SRV_GID; expected hooopctl ($CTL_GID)"
	fi

	# The load-bearing invariant: hooopctl must not be supplementary, or the
	# helper cannot shed it (no capabilities => no setgroups) and the model's
	# process tree inherits control-plane access.
	if echo " $SRV_GROUPS " | grep -q " $CTL_GID "; then
		_fail "hooopctl ($CTL_GID) is a SUPPLEMENTARY group of the server"
		_note "the helper cannot drop it; claude would inherit control-plane access"
		_note "groups: $SRV_GROUPS"
	else
		_pass "hooopctl is not a supplementary group (helper can shed it)"
	fi
fi

# --- The lock -----------------------------------------------------------------
_head "control plane is unreachable by the model"

# Ownership of the two artefacts, not just reachability. A token left over from a
# pre-split install keeps group `hooop` — which the MODEL is in — and the server
# cannot re-chown a file it does not own, so this only converges if the entrypoint
# fixes it. Caught exactly this on the first upgrade.
DIR_OWN="$(_as root stat -c '%U:%G %a' /var/run/hooop | tr -d '\r')"
TOK_OWN="$(_as root stat -c '%U:%G %a' /var/run/hooop/sandbox.token | tr -d '\r')"
[ "$DIR_OWN" = "hooopd:hooopctl 750" ] \
	&& _pass "/var/run/hooop is hooopd:hooopctl 750" \
	|| _fail "/var/run/hooop is '$DIR_OWN'; expected 'hooopd:hooopctl 750'"
[ "$TOK_OWN" = "hooopd:hooopctl 640" ] \
	&& _pass "sandbox.token is hooopd:hooopctl 640" \
	|| _fail "sandbox.token is '$TOK_OWN'; expected 'hooopd:hooopctl 640' (stale pre-split token?)"

_expect_denied "agent cannot list /var/run/hooop"        agent ls /var/run/hooop
_expect_denied "agent cannot read sandbox.token"        agent cat /var/run/hooop/sandbox.token
_expect_denied "agent cannot stat the control socket"   agent stat /var/run/hooop/sandbox.sock

# connect(), specifically. This is the one Landlock cannot stop, so if the
# directory mode ever regresses this is the check that catches it.
_expect_denied "agent cannot connect() the control socket" \
	agent curl -fsS --max-time 3 --unix-socket /var/run/hooop/sandbox.sock http://sandbox/health

_expect_ok "hooopd CAN connect() the control socket" \
	hooopd curl -fsS --max-time 3 --unix-socket /var/run/hooop/sandbox.sock http://sandbox/health

# procfs is a second namespace for the same inodes, so the directory mode has to
# hold through it too. /proc/<server>/root/... is a real bypass class: it sidesteps
# the path entirely. It is refused here because changing credentials cleared the
# server's `dumpable` flag and Docker's default capability set omits
# CAP_SYS_PTRACE — belt and braces with the directory mode, and worth pinning
# because a container run with --cap-add=SYS_PTRACE would silently reopen it.
if [ -n "${SRV_PID:-}" ]; then
	_expect_denied "agent cannot reach the socket via /proc/<server>/root" \
		agent curl -fsS --max-time 3 --unix-socket "/proc/$SRV_PID/root/var/run/hooop/sandbox.sock" http://sandbox/health
	_expect_denied "agent cannot read the token via /proc/<server>/root" \
		agent cat "/proc/$SRV_PID/root/var/run/hooop/sandbox.token"
fi

# --- The original escalation, end to end --------------------------------------
_head "the original escape is dead"

# Verbatim shape of the escape this work exists to close: steal the token, then
# authenticate to the control plane as `host` and drive a host-only route.
ESCAPE='tok=$(cat /var/run/hooop/sandbox.token 2>/dev/null); \
        curl -fsS --max-time 3 --unix-socket /var/run/hooop/sandbox.sock \
             -H "x-sandbox-token: $tok" -H "x-hooop-participant: host" \
             http://sandbox/sessions'
_expect_denied "agent cannot read the token AND drive /sessions as host" agent sh -c "$ESCAPE"

# Same request, but with the token handed to it for free — proves reachability is
# gone rather than just the secret. If this ever succeeds, DAC has regressed and
# the token is the only thing standing in the way again.
# Must look like a real token, not a docker/cat diagnostic — otherwise the check
# below "passes" simply because we sent garbage, which is a false negative for the
# exact regression it exists to catch.
TOK="$(_as hooopd cat /var/run/hooop/sandbox.token | tr -cd '0-9a-f')"
if printf '%s' "$TOK" | grep -Eq '^[0-9a-f]{64}$'; then
	_expect_denied "agent cannot use a LEAKED token against the control socket" \
		agent curl -fsS --max-time 3 --unix-socket /var/run/hooop/sandbox.sock \
			-H "x-sandbox-token: $TOK" -H "x-hooop-participant: host" http://sandbox/sessions
else
	_fail "could not read a well-formed token as hooopd — the server may not have minted it"
	_note "got: ${TOK:-(empty)}"
fi

# --- Hook plane still works ---------------------------------------------------
_head "hook plane still reachable by the model"

_expect_ok "agent can read hook.token"                 agent test -r /run/hooop-hooks/hook.token

# Read, but never write. If the model could replace hook.token or plant a socket
# here it would control what the permission gate talks to — the hook plane has to
# be readable to the model without being writable by it.
_expect_denied "agent cannot create files in the hook dir" \
	agent touch /run/hooop-hooks/planted
_expect_denied "agent cannot overwrite hook.token" \
	agent sh -c "cp /dev/null /run/hooop-hooks/hook.token"
_expect_ok "agent can connect() the hook socket" \
	agent curl -fsS --max-time 3 --unix-socket /run/hooop-hooks/hook.sock http://sandbox/health
# The hook token must NOT be a control-plane credential.
HOOK_TOK="$(_as agent cat /run/hooop-hooks/hook.token | tr -cd '0-9a-f')"
if printf '%s' "$HOOK_TOK" | grep -Eq '^[0-9a-f]{64}$'; then
	_expect_denied "the hook token does not open the control socket" \
		hooopd curl -fsS --max-time 3 --unix-socket /var/run/hooop/sandbox.sock \
			-H "x-sandbox-token: $HOOK_TOK" -H "x-hooop-participant: host" http://sandbox/sessions
else
	_fail "agent could not read hook.token — the permission gate will deny every tool call"
fi

# --- The helper ---------------------------------------------------------------
_head "hooop-as-agent"

HELPER=/usr/local/bin/hooop-as-agent
MODE="$(_as root stat -c '%a %U %G' "$HELPER" | tr -d '\r')"
if [ "$MODE" = "6750 agent hooop" ]; then
	_pass "helper is $MODE (setuid+setgid, agent:hooop)"
else
	_fail "helper is '$MODE'; expected '6750 agent hooop'"
	_note "a stale owner makes it fail closed (exit 125) after a HOOOP_HOST_UID remap"
fi

# Invoke it the way the SERVER does, via setpriv with hooopctl as the primary gid
# and `hooop` supplementary — not via `docker exec -u hooopd`, which calls
# initgroups() and so hands the process hooopctl as a SUPPLEMENTARY group too.
# The helper correctly refuses that credential set (asserted below), so testing
# through it would measure the wrong thing.
_as_server() { _as root setpriv --reuid "$SERVER_USER_NAME" --regid "$CTL_GID" --groups "$HOOOP_GID" "$@"; }

# It must actually land on the model's uid...
LANDED="$(_as_server "$HELPER" id -u | tr -d '\r')"
if [ "$LANDED" = "$AGENT_UID" ]; then
	_pass "server credentials -> helper lands on agent (uid $LANDED)"
else
	_fail "server credentials -> helper landed on '$LANDED'; expected $AGENT_UID"
fi

# Fail-closed, positively asserted: given hooopctl as a supplementary group the
# helper must REFUSE, because it cannot shed it (no capabilities => no
# setgroups) and exec-ing anyway would hand the model control-plane access.
if _as hooopd "$HELPER" id -u >/dev/null 2>&1; then
	_fail "helper ran with hooopctl supplementary — its fail-closed check is not working"
else
	_pass "helper refuses to exec when hooopctl is supplementary (fail-closed)"
fi

# ...and must NOT carry hooopctl through the drop.
LANDED_GROUPS="$(_as_server "$HELPER" id -G | tr -d '\r')"
if echo " $LANDED_GROUPS " | grep -q " $CTL_GID "; then
	_fail "helper's child still holds hooopctl ($CTL_GID): $LANDED_GROUPS"
else
	_pass "helper's child does not hold hooopctl (groups: $LANDED_GROUPS)"
fi

# The child of the helper must be as locked out as plain agent is.
if _as_server "$HELPER" cat /var/run/hooop/sandbox.token >/dev/null 2>&1; then
	_fail "helper's child CAN read sandbox.token — the drop is not shedding control-plane access"
else
	_pass "helper's child cannot read sandbox.token"
fi

# Nobody else may exec it. Note the `sh -c`: the exec MUST be performed by an
# already-unprivileged process. `docker exec -u nobody <helper>` would succeed
# regardless of the mode, because runc performs that first execve while still
# holding CAP_DAC_OVERRIDE and only reduces capabilities afterwards — measured
# directly, including on a root-owned 0700 binary. Wrapping in a shell moves the
# execve into a process with CapEff=0, where the mode is actually enforced.
_expect_denied "an unrelated uid cannot exec the helper" nobody sh -c "$HELPER id -u"

# --- ptrace -------------------------------------------------------------------
_head "process isolation"

if [ -n "${SRV_PID:-}" ]; then
	_expect_denied "agent cannot read the server's environ" \
		agent sh -c "cat /proc/$SRV_PID/environ >/dev/null"

	# Before the split this returned 0 and the model could inject into the
	# server outright, which made the socket and token modes irrelevant.
	PTRACE=$(cat <<'PY'
import ctypes, ctypes.util, os, sys
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
pid = int(os.environ["SRV"])
if libc.ptrace(16, pid, 0, 0) == 0:
    libc.ptrace(17, pid, 0, 0)
    sys.exit(0)      # attached — BAD
sys.exit(1)          # refused — good
PY
)
	if docker exec -u agent -e SRV="$SRV_PID" "$SANDBOX" python3 -c "$PTRACE" >/dev/null 2>&1; then
		_fail "agent can PTRACE_ATTACH the server — it can inject into the control plane"
	else
		_pass "agent cannot PTRACE_ATTACH the server"
	fi
else
	_skip "ptrace checks (no server pid)"
fi

# --- Session isolation --------------------------------------------------------
# Load-bearing product property, not a nice-to-have: one session must not be able
# to read another session's file tree. It is NOT enforced by DAC and cannot be —
# every session runs as the same `agent` uid, so at the permission level they are
# one identity. Landlock is what separates them (each Bash tool gets a ruleset
# scoped to its own cwd), with the PreToolUse path gate covering the in-process
# Read/Write/Edit tools that no LSM can reach.
#
# That means the uid split must not have widened anything here, and this section
# exists to prove it directly rather than by reading the policy code.
_head "session isolation (one session cannot read another's tree)"

SESSIONS_ROOT=/home/agent/workspace/sessions
SID_A=verify-iso-a
SID_B=verify-iso-b

# Note the chown of SESSIONS_ROOT itself: this runs as root, so if the fixture
# is what first creates that directory it would otherwise be left root-owned and
# `agent` could no longer create real session workdirs under it — a test that
# breaks the thing it is checking.
_as root sh -c "
  rm -rf $SESSIONS_ROOT/$SID_A $SESSIONS_ROOT/$SID_B
  mkdir -p $SESSIONS_ROOT/$SID_A $SESSIONS_ROOT/$SID_B
  echo A-OWN-SECRET  > $SESSIONS_ROOT/$SID_A/mine.txt
  echo B-PEER-SECRET > $SESSIONS_ROOT/$SID_B/theirs.txt
  chown agent:hooop $SESSIONS_ROOT 2>/dev/null || true
  chmod 2770 $SESSIONS_ROOT 2>/dev/null || true
  chown -R agent:hooop $SESSIONS_ROOT/$SID_A $SESSIONS_ROOT/$SID_B
" >/dev/null 2>&1

# Exactly how lib/landlock-policy.ts invokes the wrapper for a session's Bash
# tool: RW its own cwd, RO the base OS dirs. Peer session dirs appear in NEITHER
# list, which is the entire mechanism.
_confined() {
	local cwd="$1"; shift
	docker exec -u agent -w "$cwd" \
		-e HOOOP_LANDLOCK_RW="$cwd:/dev" \
		-e HOOOP_LANDLOCK_RO="/usr:/bin:/sbin:/lib:/etc" \
		-e HOOOP_LANDLOCK_MODE=enforce \
		"$SANDBOX" /usr/local/bin/hooop-sandbox-exec /bin/sh -c "$*" 2>&1
}

OWN="$(_confined "$SESSIONS_ROOT/$SID_A" "cat $SESSIONS_ROOT/$SID_A/mine.txt")"
if printf '%s' "$OWN" | grep -q "A-OWN-SECRET"; then
	_pass "a confined session CAN read its own workdir"
else
	_fail "a confined session cannot read its OWN workdir — confinement is too tight"
	_note "${OWN:-(no output)}"
fi

PEER="$(_confined "$SESSIONS_ROOT/$SID_A" "cat $SESSIONS_ROOT/$SID_B/theirs.txt")"
if printf '%s' "$PEER" | grep -q "B-PEER-SECRET"; then
	_fail "session A READ session B's file — session isolation is broken"
	_note "${PEER}"
else
	_pass "session A cannot read session B's file"
fi

PEER_LS="$(_confined "$SESSIONS_ROOT/$SID_A" "ls $SESSIONS_ROOT/$SID_B")"
if printf '%s' "$PEER_LS" | grep -q "theirs.txt"; then
	_fail "session A can LIST session B's tree — the filetree leaks even if contents don't"
	_note "${PEER_LS}"
else
	_pass "session A cannot list session B's tree"
fi

# The sessions root itself must not be enumerable either: the directory NAMES are
# session ids, and leaking those is what lets one tenant discover another.
PEER_ROOT="$(_confined "$SESSIONS_ROOT/$SID_A" "ls $SESSIONS_ROOT")"
if printf '%s' "$PEER_ROOT" | grep -q "$SID_B"; then
	_fail "session A can enumerate the sessions root and discover peer session ids"
	_note "${PEER_ROOT}"
else
	_pass "session A cannot enumerate peer session ids"
fi

# Same uid, so this is DAC-visible and MUST be denied by Landlock rather than by
# permissions. Stated explicitly because a reader may otherwise assume ownership
# is doing the work here.
UNCONFINED="$(_as agent cat "$SESSIONS_ROOT/$SID_B/theirs.txt")"
if printf '%s' "$UNCONFINED" | grep -q "B-PEER-SECRET"; then
	_pass "unconfined agent CAN read it — confirming Landlock, not DAC, is the separator"
else
	_note "unconfined read was also denied; peer separation here is stronger than expected"
fi

_as root sh -c "rm -rf $SESSIONS_ROOT/$SID_A $SESSIONS_ROOT/$SID_B" >/dev/null 2>&1

# --- Dashboard ----------------------------------------------------------------
_head "dashboard still has access"

if docker inspect "$DASHBOARD" >/dev/null 2>&1; then
	if docker exec "$DASHBOARD" test -r /var/run/hooop/sandbox.token 2>/dev/null; then
		_pass "dashboard can read sandbox.token"
	else
		_fail "dashboard CANNOT read sandbox.token — check group_add: 1101 in docker-compose.yml"
	fi
	if docker exec "$DASHBOARD" curl -fsS --max-time 3 --unix-socket /var/run/hooop/sandbox.sock \
			http://sandbox/health >/dev/null 2>&1; then
		_pass "dashboard can connect() the control socket"
	else
		_fail "dashboard CANNOT connect() the control socket — check group_add: 1101"
	fi
else
	_skip "dashboard checks (container '$DASHBOARD' not running)"
fi

# --- Verdict ------------------------------------------------------------------
if [ "$QUIET" = 1 ]; then
	printf "SUMMARY %d %d\n" "$PASSED" "$((PASSED + FAILED))"
	[ "$FAILED" -eq 0 ] && exit 0 || exit 1
fi

printf "\n"
if [ "$FAILED" -eq 0 ]; then
	printf "${_GR}${_B}isolation verified${_RST} ${_DIM}(%d checks)${_RST}" "$PASSED"
	[ "$SKIPPED" -gt 0 ] && printf " ${_DIM}— %d skipped${_RST}" "$SKIPPED"
	printf "\n"
	exit 0
fi
printf "${_RD}${_B}%d of %d check(s) failed${_RST} — the uid split is not intact.\n" \
	"$FAILED" "$((PASSED + FAILED))"
exit 1
