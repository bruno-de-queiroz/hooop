#!/usr/bin/env bash
# Sandbox container entrypoint.
#
# Runs as root initially so it can fix ownership of the bind-mounted Claude
# state, then drops to the non-root `agent` user (uid 1100) via gosu before
# exec-ing the server process.
#
# Mount layout (set up on the host by the hooop CLI engine, cli/lib/stack.sh):
#   /home/agent/                       ← bind-mount source = $HOME/.claude/hooop/sandbox/profile
#     .claude.json                     ← claude top-level config
#     .claude/
#       .credentials.json              ← OAuth refresh tokens
#       plugins/, sessions/, hooop/, ...
#
# Why chown here instead of on the host:
#   On macOS with Docker Desktop the bind-mount source is owned by the
#   macOS user (typically uid 501 / 502). The container's `agent` user is
#   uid 1100. Without the chown the agent process can't write credentials,
#   session state, etc. Doing it at entrypoint time avoids a manual
#   `sudo chown -R 1100:1100 ...` step on the host after every fresh setup.
#
#   That is the DASHBOARD path only. `hooop open` performs no chown and no chmod
#   anywhere: it remaps `agent` to the host uid instead, so the mount is already
#   writable and there is nothing to fix up. See $OPEN_MODE below — roughly half
#   of what follows is skipped there, and the boot is mostly what's left.
#
# Security posture:
#   The server process itself NEVER runs as root; this script is the only
#   root-capable code and it exits immediately after exec-ing the final drop.
#
#   Two unprivileged accounts, not one. `agent` runs claude and owns the
#   profile above; `hooopd` runs the server and owns the control plane. With a
#   single uid there was no DAC boundary between them at all — measured on a
#   live container, the model's uid could read the server's /proc/<pid>/environ
#   and PTRACE_ATTACH to it, which is a total compromise of the host-privileged
#   control socket no matter how the token is permissioned. See
#   landlock/hooop-as-agent.c for how the server gets back to the model's uid.

set -euo pipefail

HOME_DIR="/home/agent"
RUN_DIR="/var/run/hooop"
HOOK_RUN_DIR="/run/hooop-hooks"

# Boot profiler. HOOOP_TRACE=1 logs cumulative elapsed ms per phase, so "why is
# the boot slow" stays a measurement instead of a guess — the phases below vary
# by two orders of magnitude with the size of the mounted profile and with the
# host filesystem, which is exactly the kind of thing that can't be reasoned
# about from the source. Costs one `date` fork per call, and only when enabled.
#
# `%3N` is a GNU extension: anything else (busybox) echoes it back literally, and
# "<epoch>%3N" in the arithmetic below is a FATAL expansion error under `set -e` —
# taking the whole boot down over a debug flag. So validate, and reject anything
# that isn't all digits rather than salvaging the digits out of it: a plausible
# but wrong number is worse than an obviously dead counter.
_now_ms() {
  local t; t="$(date +%s%3N 2>/dev/null || true)"
  case "$t" in ""|*[!0-9]*) echo 0 ;; *) echo "$t" ;; esac
}
_T0_MS="$(_now_ms)"
_trace() {
  [ -n "${HOOOP_TRACE:-}" ] || return 0
  echo "[entrypoint] trace +$(( $(_now_ms) - _T0_MS ))ms $*"
}

# The server's account and the group that gates the control plane. hooopctl MUST
# stay hooopd's primary group and never appear in --groups below: hooop-as-agent
# holds no capabilities, so shedding the primary gid is the only way it can drop
# hooopctl before exec-ing claude. It re-checks this and refuses to exec if broken.
SERVER_USER="hooopd"
CONTROL_GROUP="hooopctl"
AGENT_GROUP="hooop"
AS_AGENT="${HOOOP_AS_AGENT:-/usr/local/bin/hooop-as-agent}"

# gid for a GROUP name (`id -g` resolves a USER, which these names are not).
# Falls back to the baked gid so a hand-run container without these groups still
# produces a usable number rather than an empty --groups argument.
_gid_of() {
  local gid; gid="$(getent group "$1" 2>/dev/null | cut -d: -f3)"
  [ -n "$gid" ] && echo "$gid" || echo "$2"
}

# Change an account's uid WITHOUT the recursive chown of its home directory that
# `usermod -u` performs implicitly (chown_tree() in shadow's usermod.c rewrites
# every inode under the home dir still owned by the old uid).
#
# For `agent` that home IS the bind-mounted profile, so the walk covers the whole
# ~200k-inode tree: measured at ~71s of a macOS `hooop open` boot under
# HOOOP_TRACE=1, versus ~113ms for every other phase COMBINED. It is also exactly
# the recursive chown the open path documents that it does not do (see $OPEN_MODE
# below) — stripping this script's explicit chowns never removed this one,
# because it happens inside usermod rather than in the script, which is why the
# boot stayed slow after that change.
#
# Dropping the walk is safe on BOTH paths:
#   - open:   the profile is already owned by the host uid we are remapping TO,
#             so the walk rewrites nothing. A profile left owned by a stale uid
#             1100 is out of scope by design — the writability check below
#             detects that and prints the host-side `chown -R` to run.
#   - server: the explicit recursive `chown -R agent:hooop` a few phases down
#             covers the same tree immediately after, so this is duplication.
#
# Suppressed through usermod's own guard rather than by hand-editing passwd:
# chown_tree runs only when the home directory is accessible, and when -d is
# given it is the NEW home that gets tested. So hand it a home that cannot exist
# for the duration of the uid change, then put the real one back. `-d` without
# `-m` rewrites the passwd field only — it moves no files and creates nothing.
# usermod commits -u and -d in a single passwd write, so a failure leaves BOTH
# untouched and there is nothing to roll back.
_remap_uid() {
  local user="$1" newuid="$2" home void="/nonexistent"
  home="$(getent passwd "$user" 2>/dev/null | cut -d: -f6)"
  # No home on record — nothing to suppress, so do it the plain way.
  [ -n "$home" ] || { usermod -u "$newuid" "$user" 2>/dev/null; return $?; }
  # "Cannot exist" is verified, not assumed.
  while [ -e "$void" ]; do void="${void}x"; done
  usermod -u "$newuid" -d "$void" "$user" 2>/dev/null || return 1
  # Only reachable when the uid change above succeeded. A failure to restore is
  # loud rather than swallowed: a home left at $void would break claude's HOME.
  usermod -d "$home" "$user" 2>/dev/null \
    || echo "[entrypoint] WARNING: could not restore $user home to $home"
  return 0
}

# Which account the final exec drops to. Defaults to the server; `hooop open`
# overrides CMD with `claude` directly and passes agent, because it has no
# server, no control socket and no sibling sessions (see cli/modules/open.sh).
ENTRYPOINT_USER="${HOOOP_ENTRYPOINT_USER:-$SERVER_USER}"

# `hooop open` path. Derived from the SAME variable that decides the final exec at
# the bottom of this file, so the two can never disagree: when this is 1, no
# server process will exist in this container at all.
#
# `open` is a deliberately NARROWER tool than the dashboard sandbox, and its value
# is in what it does not do (see cli/modules/open.sh). Its jobs are: trim the
# tooling surface the model gets (MCPs, skills, plugins), require no Claude Code
# install on the host, and isolate telemetry. That is the whole list.
#
# So it owns NO part of the filesystem's ownership or permissions — no chown, no
# chmod, anywhere. The container user IS the host user (HOOOP_HOST_UID, remapped
# just below), which is what makes the mount writable without a fixup, and the
# little layout it needs is CREATED as `agent` rather than repaired afterwards.
# Every permission phase below is there for the DASHBOARD's two-uid split — the
# server reaching a profile it doesn't own via group `hooop`, a token behind a
# group-gated directory, a socket the dashboard traverses — none of which exists
# here. Same reasoning as the Landlock exemption on this path: don't pay to be
# walled off from a control plane that was never started.
#
# It was also, incidentally, most of the boot: a recursive walk of a bind-mounted
# profile that runs to ~200k inodes in practice (plugin node_modules, uv tool
# venvs, playwright + npm caches, transcripts), every one a round trip on macOS.
#
# What the open path DOES do: the uid remap, the layout seed, the stale
# hook-token sweep, profile seeding, telemetry isolation, browser-MCP
# registration.
OPEN_MODE=0
[ "$ENTRYPOINT_USER" = "agent" ] && OPEN_MODE=1

# Align the container's `agent` USER with the HOST user's uid (HOOOP_HOST_UID,
# forwarded by the CLI engine's _hs_export_host_ids / `hooop open`'s docker run)
# BEFORE the chown below. On native Linux Docker the chown that follows actually
# takes effect — reassigning the bind-mounted profile to a fixed uid 1100 that
# the host user isn't leaves the HOST unable to write its own
# ~/.claude/hooop/sandbox/profile afterward (this CLI's own preflight, and
# setup's profile.md/install-log.md writes). Remapping first means that chown
# lands on the uid that already owns the tree from the host's side, so host
# write access survives (via the owner permission bits — the group is
# irrelevant to the host's own writes).
#
# Deliberately UID-ONLY: the `hooop` GROUP is left at its baked gid 1100 and is
# NOT remapped to the host gid. gid 1100 is a hard cross-container contract —
# the separate dashboard image bakes in a `node` user joined to gid 1100, and
# reaches the shared UDS + sandbox.token (created group=hooop, modes 0660/0640)
# purely through that shared group. Renumbering `hooop` here would (a) make the
# server's own `chownSync(sock/token, -1, 1100)` fail EPERM (agent would no
# longer be a member of 1100) and (b) leave the run dir/socket/token
# group-owned by the host gid, which the dashboard's node user isn't in — so
# on any host whose uid/gid != 1000 the dashboard could not even traverse the
# 0770 run dir, breaking the entire two-service stack. Host profile writes
# don't need the group remap (owner bits suffice), so the uid remap alone gives
# us both properties: host keeps write access AND the dashboard keeps socket
# access, on macOS and Linux alike.
#
# Guarded to uid > 0 only — never remap `agent` to root, which would defeat the
# non-root security posture (see file header). NOT guarded at 1000: macOS's own
# regular user accounts start at uid 501 (Linux distros vary too — some start
# at 500), so a >=1000 floor would skip perfectly normal host uids. A uid
# collision with an existing container account is the reason the image drops the
# base image's stock `node` user (uid 1000) — see sandbox/Dockerfile. Any other
# failure is swallowed — worst case is the fixed uid 1100.
#
# No-op by design when unset (older CLI, `hooop open` without the flag, or a
# hand-run `docker compose up`) and harmless on macOS Docker Desktop: the
# chown-probe below already skips the recursive profile chown there regardless
# of which uid `agent` resolves to (grpcfuse/osxfs either no-ops chown or
# refuses it outright; the bind mount permits writes either way) — so remapping
# ahead of that probe changes nothing when it's a no-op, and only helps on the
# rarer setups (e.g. newer VirtioFS) where chown does take effect.
#
# Move `hooopd` out of the way FIRST if the host user happens to own its uid.
# Exactly the failure class the Dockerfile describes for the stock `node`
# account: `usermod -u <host uid> agent` fails with "UID already exists" and the
# error is swallowed, silently leaving the HOST locked out of its own profile.
if [ -n "${HOOOP_HOST_UID:-}" ] && [ "${HOOOP_HOST_UID}" -gt 0 ] 2>/dev/null; then
  if [ "$(id -u "$SERVER_USER" 2>/dev/null || echo "")" = "$HOOOP_HOST_UID" ]; then
    for candidate in 1102 1103 1104 1105 1106; do
      if ! getent passwd "$candidate" >/dev/null 2>&1; then
        _remap_uid "$SERVER_USER" "$candidate" \
          && echo "[entrypoint] host uid $HOOOP_HOST_UID collides with $SERVER_USER; moved $SERVER_USER -> uid $candidate" \
          || echo "[entrypoint] WARNING: could not move $SERVER_USER off uid $HOOOP_HOST_UID"
        break
      fi
    done
  fi
fi
if [ -n "${HOOOP_HOST_UID:-}" ] && [ "${HOOOP_HOST_UID}" -gt 0 ] 2>/dev/null; then
  current_uid="$(id -u agent 2>/dev/null || echo "")"
  if [ -n "$current_uid" ] && [ "$current_uid" != "$HOOOP_HOST_UID" ]; then
    if _remap_uid agent "$HOOOP_HOST_UID"; then
      echo "[entrypoint] aligned agent uid -> $HOOOP_HOST_UID (host owner); hooop group kept at gid 1100"
    elif [ "$OPEN_MODE" = 1 ]; then
      # Louder here than on the server path, because this remap is now the ONLY
      # thing making the profile writable: `hooop open` does no chown, so there is
      # no second mechanism to fall back on. Left unremapped, claude comes up as
      # uid 1100 against a host-owned profile and cannot persist its own
      # credentials — a failure that otherwise surfaces as a mystery re-login.
      echo "[entrypoint] WARNING: could not remap agent to the host uid $HOOOP_HOST_UID."
      echo "[entrypoint]          claude may be unable to write the mounted profile"
      echo "[entrypoint]          (credentials, config). Check for a uid collision."
    else
      echo "[entrypoint] note: could not remap agent uid to $HOOOP_HOST_UID; using default"
    fi
  fi
fi

_trace "uid remap done"

# Ensure the expected layout exists even on a freshly-bootstrapped host.
#
# Deliberately AFTER the uid remap above, and created as `agent` on the `hooop
# open` path, because that path performs no chown at all: a .claude.json created
# by ROOT here is a file claude can never write for the life of the session, and
# nothing downstream would fix it (seed-profile.mjs runs as agent and would die
# on EACCES, so even the onboarding bypass would be lost). Born under the right
# uid needs no fixup — which is the whole point. Running it before the remap
# would have been just as wrong: `agent` was still uid 1100 up there, not the
# host user. The server path keeps creating them as root; its ownership pass
# below converges the tree as it always has.
if [ "$OPEN_MODE" = 1 ]; then
  gosu agent mkdir -p "$HOME_DIR/.claude" "$HOME_DIR/workspace" 2>/dev/null \
    || echo "[entrypoint] WARNING: could not create the profile layout as agent"
  [ -f "$HOME_DIR/.claude.json" ] \
    || gosu agent sh -c 'echo "{}" > "$1"' _ "$HOME_DIR/.claude.json" 2>/dev/null \
    || echo "[entrypoint] WARNING: could not seed .claude.json as agent"

  # Can the model actually WRITE the profile it was handed? Asked, never fixed —
  # this path deliberately owns no ownership or modes, so the answer here is a
  # diagnosis, not a prelude to a chown.
  #
  # It exists because dropping the recursive chown also dropped the thing that
  # silently papered over a mis-owned profile (one created by an older hooop, or a
  # bind source docker made as root). Left undetected that surfaces as claude
  # failing to persist its OAuth refresh — i.e. as an inexplicable re-login every
  # session, with nothing in the log pointing at the cause. Two `test`s are a
  # cheap price for turning that into a sentence.
  # One fork, and it distinguishes its two failure modes: exit 3 is "the paths
  # are not writable", anything else non-zero is "gosu could not run the check at
  # all". Collapsing those would let a broken gosu print a confident diagnosis
  # about file ownership and send someone chowning a profile that was fine.
  _prof_w=0
  # .claude.json is checked only if it EXISTS: `test -w` on a missing path fails,
  # which would report "not writable" for a file that simply isn't there yet —
  # a second, wrong diagnosis chasing the real warning above it.
  gosu agent sh -c '
    test -w "$1" || exit 3
    if [ -e "$2" ] && [ ! -w "$2" ]; then exit 3; fi
    exit 0' _ "$HOME_DIR/.claude" "$HOME_DIR/.claude.json" 2>/dev/null || _prof_w=$?
  case "$_prof_w" in
    0) ;;
    3)
      echo "[entrypoint] WARNING: the mounted profile is not writable by agent (uid $(id -u agent))."
      echo "[entrypoint]          claude cannot persist credentials or config; expect it to"
      echo "[entrypoint]          re-prompt for login every session."
      echo "[entrypoint]          \`hooop open\` never rewrites ownership — fix it on the HOST:"
      echo "[entrypoint]            sudo chown -R \$(id -u):\$(id -g) <profile dir>"
      ;;
    *)
      echo "[entrypoint] note: could not run the profile writability check (gosu exit $_prof_w)."
      ;;
  esac
else
  mkdir -p "$HOME_DIR/.claude"
  mkdir -p "$HOME_DIR/workspace"
  [ -f "$HOME_DIR/.claude.json" ] || echo "{}" > "$HOME_DIR/.claude.json"
fi

# Let the server read `hooop mount add` trees. Those are nested bind mounts that
# keep their HOST ownership (the `-xdev` guard below deliberately never chowns
# them), so on Linux — where bind-mount DAC is real — the server reaches them
# only through the host's own gid. Supplementary is safe here; the one group that
# must never be supplementary on this account is $CONTROL_GROUP.
#
# Server-only: on the `hooop open` path the model runs as `agent`, which already
# owns $PWD through the uid remap above, and $SERVER_USER never runs at all.
if [ "$OPEN_MODE" = 0 ] && [ -n "${HOOOP_HOST_GID:-}" ] && [ "${HOOOP_HOST_GID}" -gt 0 ] 2>/dev/null; then
  if ! getent group "$HOOOP_HOST_GID" >/dev/null 2>&1; then
    groupadd -g "$HOOOP_HOST_GID" hooophost 2>/dev/null || true
  fi
  host_group="$(getent group "$HOOOP_HOST_GID" | cut -d: -f1)"
  if [ -n "$host_group" ] && [ "$host_group" != "$CONTROL_GROUP" ]; then
    usermod -aG "$host_group" "$SERVER_USER" 2>/dev/null \
      || echo "[entrypoint] note: could not add $SERVER_USER to host group $host_group"
  fi
fi

# Re-stamp the setuid helper. Remapping `agent` above leaves the owner baked at
# build time stale, and a stale owner makes the helper fail CLOSED (exit 125,
# "setuid bit not effective") rather than silently running claude as the server's
# own uid — so this is a correctness fixup, not a hardening nicety.
#
# Server-only: the helper exists to get the SERVER's uid back to the model's. On
# the `hooop open` path the process already IS the model's uid, so nothing execs
# it — and the verification gate further down (which would catch a stale stamp)
# is on the server path too.
#
# What skipping it leaves behind, stated plainly because it looks alarming: a
# setuid binary still owned by the baked uid 1100 while `agent` is the host uid,
# group-executable by the model. It is inert on two independent counts, both
# checked rather than assumed — (1) uid 1100 owns nothing in the image or the
# profile once `agent` has moved off it, so the euid buys no access; (2) the
# helper's own first act is `geteuid() != agent uid -> exit(125)`
# (landlock/hooop-as-agent.c), so a stale stamp is precisely the case it refuses
# to run in. Fail-closed is the documented behaviour of a stale owner, which is
# why re-stamping was a correctness fixup for the SERVER, not a hardening step.
# Dropping the setuid bit instead would be tidier — and would be a chmod, which
# this path does not do.
if [ "$OPEN_MODE" = 0 ] && [ -x "$AS_AGENT" ]; then
  chown "agent:$AGENT_GROUP" "$AS_AGENT" 2>/dev/null || true
  chmod 6750 "$AS_AGENT" 2>/dev/null || true
fi

# The server's supplementary groups, resolved ONCE and reused by the profile
# post-condition check, the helper verification and the final drop — so all three
# reason about the same credentials. `hooop` for the shared profile, plus the host's
# own gid when set, for `hooop mount add` trees that keep their host ownership.
# $CONTROL_GROUP is excluded by construction; see the final drop for why.
server_groups="$(_gid_of "$AGENT_GROUP" 1100)"
if [ -n "${HOOOP_HOST_GID:-}" ] && [ "${HOOOP_HOST_GID}" -gt 0 ] 2>/dev/null; then
  if [ "$HOOOP_HOST_GID" != "$server_groups" ] \
     && [ "$HOOOP_HOST_GID" != "$(_gid_of "$CONTROL_GROUP" 1101)" ]; then
    server_groups="$server_groups,$HOOOP_HOST_GID"
  fi
fi

# Can the server actually reach the profile, with the credentials it will have?
#
# Asked as a post-condition rather than inferred from the platform, because the
# chown probe below answers "does chown work", which is NOT the same question as
# "is DAC enforced". They coincide on macOS (neither) and on native Linux (both),
# but diverge exactly where it hurts: under rootless Docker or userns-remap, the
# profile's files belong to an unmapped uid so chown/chmod are refused WHILE DAC
# is fully enforced. Inferring would skip the group grants and leave the server
# unable to traverse ~/.claude — a blank dashboard with nothing in the log.
_check_server_can_read_profile() {
  [ -x "$AS_AGENT" ] || return 0   # not a split image; nothing to check
  command -v setpriv >/dev/null 2>&1 || return 0

  local as_server=(setpriv --reuid "$SERVER_USER" --regid "$CONTROL_GROUP" --groups "$server_groups")
  local broken=""
  "${as_server[@]}" test -x "$HOME_DIR/.claude" 2>/dev/null || broken="traverse ~/.claude"
  [ -z "$broken" ] && { "${as_server[@]}" test -r "$HOME_DIR/.claude.json" 2>/dev/null || broken="read ~/.claude.json"; }
  [ -z "$broken" ] && { "${as_server[@]}" test -w "$HOME_DIR/.claude/hooop" 2>/dev/null || broken="write ~/.claude/hooop"; }

  [ -z "$broken" ] && return 0
  echo "[entrypoint] WARNING: the server ($SERVER_USER) cannot $broken."
  echo "[entrypoint]          The dashboard will show no sessions, transcripts or events."
  echo "[entrypoint]          This host enforces bind-mount permissions but refused the"
  echo "[entrypoint]          ownership fixup — typical of rootless Docker or userns-remap."
  echo "[entrypoint]          Fix on the HOST, then restart:"
  echo "[entrypoint]            chmod -R g+rwX ~/.claude/hooop/sandbox/profile"
  echo "[entrypoint]            chgrp -R $(_gid_of "$AGENT_GROUP" 1100) ~/.claude/hooop/sandbox/profile"
}
# /app (the compiled server + its production deps) was chowned to agent:hooop
# at IMAGE BUILD time (Dockerfile), baked in as the fixed uid/gid 1100 — a
# remap above makes that ownership stale (still literally 1100 on disk), so
# the now-different-uid agent process would depend on "other" permission bits
# to read it. Make that explicit instead of assuming npm's default umask left
# it world-readable: same `a+rX` treatment the Dockerfile already gives
# /opt/bun and /opt/playwright-mcp for the same reason. Cheap (a few
# production deps + one compiled bundle, not the multi-GB profile).
# NOTE: /app is now root-owned (see the Dockerfile) so the agent user cannot
# rewrite the server bundle it runs under. This stays as belt-and-braces for
# readability only — it must NOT be relaxed into a chown.
#
# Server-only: /app holds the compiled server plus its production deps (a few
# thousand files), and on the `hooop open` path nothing in it is ever loaded —
# CMD is overridden with `claude`. Recursing it there was several thousand
# stat+chmod syscalls to make a bundle readable that no process opens.
if [ "$OPEN_MODE" = 0 ]; then
  chmod -R a+rX /app 2>/dev/null || true
  _trace "/app modes done"
fi

# --- Profile ownership + permissions (server path only) -----------------------
# `hooop open` performs NO chown and NO chmod on the profile, by design. It is not
# in the business of managing ownership: the container user IS the host user
# (HOOOP_HOST_UID, remapped above), so the mount is already writable through the
# owner bits, and the layout it needs was created as `agent` rather than fixed up
# afterwards. Everything below exists for the DASHBOARD's two-uid split — the
# server reaching a profile it doesn't own, through group `hooop` — which is a
# problem `open` does not have.
#
# `open` is a narrower tool than the dashboard sandbox and its whole value is in
# what it does NOT do (see cli/modules/open.sh): trim the tooling surface (MCPs,
# skills, plugins), need no Claude Code on the host, isolate telemetry. Rewriting
# the permissions of the user's own profile is none of those things — it was just
# inherited cost, and on a large profile it was most of the boot.
if [ "$OPEN_MODE" = 0 ]; then

  # Fix ownership of the bind-mounted tree. Approach varies by filesystem:
  #
  #   Linux bind-mount (uid honoured): recursive chown writes real ownership,
  #     ~milliseconds even on big trees.
  #
  #   macOS Docker Desktop grpcfuse: chown silently no-ops (files always
  #     appear as the host user's uid). A recursive walk still STATs every
  #     file before giving up — on a 2.5 GB / 60k-file profile (claude-mem,
  #     uv tool installs, plugins/cache, etc.) that's 30+ seconds, blowing
  #     past the healthcheck's start-period and causing `compose up
  #     --depends_on: service_healthy` to bail.
  #
  # Probe with a single non-recursive chown. If THAT succeeds, the FS honours
  # chown and we walk the tree. If it refuses, the recursive walk would be
  # pure wasted IO — skip it. The agent process still writes fine on grpcfuse
  # because the bind-mount surfaces files under the host user's uid and the
  # Docker fuse layer permits writes regardless.
  #
  # `find -xdev` (chown itself has no --one-file-system): never cross into a
  # DIFFERENT bind mount nested under $HOME_DIR — namely /home/agent/workspace
  # (`hooop open`'s $PWD) and any `hooop mount add` target (also under
  # /home/agent/workspace/<name>). Those are the user's own project files on the
  # host; a plain recursive chown walks straight into them too and would
  # silently reassign their ownership on native Linux, which is a much worse
  # surprise than the profile permission issue this block exists to fix. `-xdev`
  # still visits the mount-point directory ENTRY itself (just not its contents)
  # — with the uid/gid alignment above that's a no-op in the common case since
  # it's already host-owned; worst case (no HOOOP_HOST_UID/GID) it's one
  # directory's metadata, never file contents.
  PROFILE_DAC=0
  if chown agent:hooop "$HOME_DIR" 2>/dev/null; then
    PROFILE_DAC=1
    # Only touch what is actually WRONG. The unfiltered walk rewrote ownership of
    # every inode on EVERY boot — tens of thousands of chown(2) calls to converge a
    # tree that was already converged, which on a large profile is the single
    # biggest item in a steady-state boot. With the filter, a converged tree costs a
    # read-only walk instead.
    #
    # `-o` binds looser than the implicit `-a`, so the parenthesized clause reads
    # "owner isn't agent OR group isn't hooop" — either one is enough to re-stamp.
    find "$HOME_DIR" -xdev \( -not -user agent -o -not -group hooop \) -print0 2>/dev/null \
      | xargs -0 -r chown agent:hooop 2>/dev/null || true
  else
    echo "[entrypoint] note: chown $HOME_DIR refused (likely macOS Docker Desktop bind-mount); skipping recursive chown."
  fi
  _trace "profile ownership done"

  # Profile permissions, now that two uids share this tree. The server has to READ
  # into it (session transcripts, ~/.claude.json, settings.json, the skills dirs)
  # and has to be able to PRUNE stale transcripts and session files. It reaches all
  # of that through group `hooop`, which the recursive chown above just applied —
  # never through ownership, and never through "other" bits.
  #
  # Only relax the modes where DAC is actually enforced. On macOS Docker Desktop
  # the profile is virtiofs, which ignores permissions outright — a 0600 file there
  # is readable by every uid in the container (measured directly) — so the server
  # already has the access it needs, and relaxing anything would widen the modes on
  # the HOST's copy of the profile for zero in-container gain. Note the flip side,
  # which is a macOS property and not something this split introduces: nothing
  # stored in the profile is private between these two uids there, which is why the
  # hook token now lives in $HOOK_RUN_DIR instead.
  #
  if [ "$PROFILE_DAC" = 1 ]; then
    # Traverse + list for group `hooop`; "other" stays shut. .credentials.json is
    # deliberately untouched at 0600 — the server has no business reading it.
    chmod 0750 "$HOME_DIR" 2>/dev/null || true
    chmod 0750 "$HOME_DIR/.claude" 2>/dev/null || true
    chmod 0640 "$HOME_DIR/.claude.json" 2>/dev/null || true


    # Two writers, one directory: the hooopd server, and emit-event.sh running as
    # agent on the fallback path. setgid pins group `hooop` on everything either of
    # them creates; 2770 plus umask 002 (set by the server and by hooop-as-agent)
    # keeps it group-writable, which is what stops one uid creating a file the
    # other can no longer truncate.
    mkdir -p "$HOME_DIR/.claude/hooop"
    chown "agent:$AGENT_GROUP" "$HOME_DIR/.claude/hooop" 2>/dev/null || true
    chmod 2770 "$HOME_DIR/.claude/hooop" 2>/dev/null || true

    # The directory mode alone is not enough for files that ALREADY exist. A
    # profile created before the split has events.db, active-sessions.json and
    # friends at 0644 owned by `agent`, so the server could read but never write
    # them — and sqlite needs write on the db, its -wal AND its -shm, or it fails
    # at the first insert. Flat pass, not recursive: everything the server writes
    # lives directly in this directory.
    find "$HOME_DIR/.claude/hooop" -maxdepth 1 -type f -exec chmod g+rw {} + 2>/dev/null || true

    # Written by claude, pruned by the server. Unlinking needs write on the
    # DIRECTORY rather than ownership of the file, so group-write here is what
    # keeps the sidebar from filling up with phantom sessions.
    for d in "$HOME_DIR/.claude/projects" "$HOME_DIR/.claude/sessions" \
             "$HOME_DIR/workspace" "$HOME_DIR/workspace/sessions"; do
      [ -d "$d" ] || continue
      chmod 2770 "$d" 2>/dev/null || true
    done

    # Per-project transcript dirs are created by CLAUDE, under claude's umask, so
    # they land 0755 and the server cannot unlink inside them — which is exactly
    # the prune path that keeps deleted sessions out of the sidebar. Depth-limited
    # to the slug level on purpose: the dirs need fixing, the transcripts under
    # them are deliberately left alone.
    #
    # Note the transcripts are NOT group-readable, and cannot be made so here:
    # claude creates each .jsonl 0600 with an explicit mode (not via its umask), so
    # a boot-time chmod would fix only the files that already exist and every new
    # session would land 0600 again. The server therefore never depends on reading
    # transcript CONTENTS — the dir grants above cover stat/walk/unlink, which is
    # all the prune path needs, and the resolved model comes from the init frame on
    # claude's stdout instead. See sandbox/lib/session-model.ts.
    find "$HOME_DIR/.claude/projects" -mindepth 1 -maxdepth 1 -type d \
      -exec chmod 2770 {} + 2>/dev/null || true

  else
    chmod 0700 "$HOME_DIR/.claude" 2>/dev/null || true
    chmod 0600 "$HOME_DIR/.claude.json" 2>/dev/null || true
  fi

  _trace "profile modes done"
fi  # OPEN_MODE = 0 — end of the profile ownership + permission work

# Drop the hook token's OLD home, on EVERY platform AND on both paths —
# deliberately outside every branch above. It moved to $HOOK_RUN_DIR, so the copy
# here is inert (the server mints a fresh one at the new path and never consults
# this one), but it is still a 64-hex credential sitting in the profile — and the
# profile is precisely where macOS virtiofs makes it readable to every uid in the
# container, which is the platform where leaving it would matter most. Also
# removes the ambiguity of two same-named token files holding different values.
#
# `hooop open` sweeps it too, even though it manages nothing else in this tree:
# this is deleting a stale credential, not fixing up ownership, it costs one
# unlink, and the profile is SHARED with the dashboard — so an open-only user
# would otherwise be the one person who never gets it cleaned up.
rm -f "$HOME_DIR/.claude/hooop/hook.token" 2>/dev/null || true

# Now that the modes are settled, confirm the server can actually use them.
[ "$OPEN_MODE" = 1 ] || _check_server_can_read_profile

# --- The control plane's two directories (server path only) -------------------
# Both hold a socket the SERVER creates and something else connects to. `hooop
# open` starts no server, so neither socket is ever bound: creating and
# permissioning the directories there produced two empty dirs nothing opened,
# and the security properties they encode ("the model's uid cannot traverse
# this") are meaningless when the model is the only uid in the container.
#
# emit-event.sh / permission-gate.sh are stripped from the settings.json overlay
# on that path (cli/modules/open.sh) precisely because they need these sockets;
# if the host had no jq to strip them they still fail soft — emit-event.sh falls
# back to appending events.jsonl, and the gate is a no-op without a socket.
if [ "$OPEN_MODE" = 0 ]; then

  # Named volume for the shared UDS + token file. Docker creates it as root:root
  # 755, so it needs a fixup regardless of who owns it.
  #
  # THIS DIRECTORY IS THE LOCK. Landlock (ABI 3) gates open(), not AF_UNIX
  # connect() — proven directly: from a confined shell, `stat` on a socket outside
  # the allow-list is denied while `curl --unix-socket` to it still connects. So no
  # allow-list can stop the model reaching the control socket; only DAC can, and
  # only if the socket sits behind a directory the model's uid cannot traverse.
  # Hence hooopd:hooopctl 0750: the server owns it, the dashboard traverses it via
  # `group_add: 1101`, and `agent` — which is in `hooop` and NOT in `hooopctl` — gets
  # EACCES on the path, so both the token read and the connect() die there.
  #
  # 0750 not 0770: the dashboard only needs to traverse and to open the socket, so
  # it has no business creating entries here. Unlinking a stale socket needs write
  # on this directory, and that is the owner's (hooopd's) privilege alone.
  #
  # Unlike the profile, this is a real Linux filesystem on every host — a named
  # volume lives in the VM, not on virtiofs — so these modes are enforced on macOS
  # exactly as they are on Linux. That is what makes the split worth doing here.
  mkdir -p "$RUN_DIR"
  chown "$SERVER_USER:$CONTROL_GROUP" "$RUN_DIR"
  chmod 0750 "$RUN_DIR"

  # Converge a token file left over from a PRE-SPLIT install. This volume persists
  # across rebuilds, so an existing sandbox.token is still owned agent:hooop — and
  # the server cannot fix that itself, because auth.ts only chowns a token it just
  # minted and a non-owner cannot chown at all. Left alone, the control-plane
  # credential keeps a group the MODEL is in. That is inert while the directory
  # above is 0750 hooopctl, which is exactly why it must not be left to depend on
  # that single lock.
  if [ -e "$RUN_DIR/sandbox.token" ]; then
    chown "$SERVER_USER:$CONTROL_GROUP" "$RUN_DIR/sandbox.token" 2>/dev/null || true
    chmod 0640 "$RUN_DIR/sandbox.token" 2>/dev/null || true
  fi

  # Container-local dir for the HOOK socket. Deliberately NOT the named volume
  # above: the dashboard never mounts this path, and the hook listener serves
  # only /permission-ask, /permission-wait and /ingest. Keeping the two sockets
  # on separate paths is what lets the control socket's directory be locked down
  # to the server's own user without breaking the permission gate, which must
  # keep working from inside the model's process tree.
  #
  # So this one is the mirror image of $RUN_DIR: owned by the server, group `hooop`
  # — which the model IS in — because permission-gate.sh and emit-event.sh run as
  # agent and have to connect() the hook socket and read hook.token (which now
  # lives here rather than in the profile, so its 0640 actually bites on macOS).
  # Still 0750: the model reads and connects, it never creates entries here.
  mkdir -p "$HOOK_RUN_DIR"
  chown "$SERVER_USER:$AGENT_GROUP" "$HOOK_RUN_DIR"
  chmod 0750 "$HOOK_RUN_DIR"

  _trace "control-plane dirs done"
fi  # OPEN_MODE = 0 — end of the control-plane directory setup

# The HOME env must point at the agent's real home so Node's os.homedir()
# returns /home/agent and claude resolves ~/.claude.json + ~/.claude/ at the
# canonical paths.
#
# This stays /home/agent for the SERVER too, even though the server is now
# hooopd and has no home of its own. Every path in lib/paths.ts derives from
# homedir(), and lib/landlock-policy.ts computes the Bash allow-list from it —
# so letting HOME follow the server's account would silently relocate the whole
# state tree and grant confinement for the wrong home. Deliberate, not leftover.
export HOME="$HOME_DIR"

# --- Seed the sandbox Claude profile (idempotent, runs as `agent`) -----------
# Ports the former host-side jq wiring (onboarding bypass, hooop plugin
# install+enable, sandbox-only hook wiring, playwright deny) INTO the container.
# Node is baked into this image; jq is not — so this is what lets the HOST run
# `hooop start` with nothing but Docker. Merge-safe: never clobbers a logged-in
# identity (oauthAccount / mcpServers preserved).
if [ -f /usr/local/lib/hooop/seed-profile.mjs ]; then
  # HOOOP_OPEN_MODE is an explicit contract, not an inference from the ambient
  # environment: the seeder's only mode work exists for the server's second uid,
  # and this path has no server (see $OPEN_MODE).
  gosu agent env HOME="$HOME_DIR" HOOOP_OPEN_MODE="$OPEN_MODE" \
    node /usr/local/lib/hooop/seed-profile.mjs \
    || echo "[entrypoint] WARNING: profile seeding failed"
fi
_trace "profile seeding done"

# --- Docker Model Runner (Compose `models:`) endpoint shim -------------------
# When `hooop setup` wires DMR via Compose's `models:` element, Compose
# injects HOOOP_MODEL_ENDPOINT / HOOOP_MODEL_NAME into this container. Map them to
# the EMBEDDING_* vars the embedder reads (sandbox/lib/embeddings.ts uses the
# OpenAI SDK with baseURL = EMBEDDING_BASE_URL, so the base must be an
# OpenAI-compatible root). An explicit endpoint (Ollama/OpenAI/custom, forwarded
# from hooop.env) always wins — only fill in when nothing else is configured.
if [ -z "${EMBEDDING_BASE_URL:-}" ] && [ -z "${OPENAI_API_KEY:-}" ] && [ -n "${HOOOP_MODEL_ENDPOINT:-}" ]; then
  _ep="${HOOOP_MODEL_ENDPOINT%/}"
  # Normalize to an OpenAI-compatible base: DMR may inject a bare host:port or a
  # full engines path. If it's neither an engines path nor a `/v1` root, append
  # the DMR OpenAI base so the SDK's `${base}/embeddings` resolves correctly.
  case "$_ep" in
    */engines/*|*/v1) : ;;
    *) _ep="$_ep/engines/v1" ;;
  esac
  export EMBEDDING_BASE_URL="$_ep"
  [ -n "${EMBEDDING_MODEL:-}" ] || export EMBEDDING_MODEL="${HOOOP_MODEL_NAME:-ai/nomic-embed-text-v1.5}"
  echo "[entrypoint] embeddings: Compose model runner -> ${EMBEDDING_BASE_URL} (${EMBEDDING_MODEL})"
fi

# --- Telemetry isolation (opt-in, configured via /hooop:setup → hooop.env) ---
#
# One master switch, off by default so the shipped image and the open-source
# repo carry no org-specific config or surprising outbound suppression:
#
#   HOOOP_DISABLE_TELEMETRY  truthy → fully isolate this sandbox from telemetry.
#     Nothing but the model API (and, later, hooop's own telemetry) should leave.
#     It does two complementary things:
#
#     (1) APP-LAYER OPT-OUTS. Export every documented Claude Code kill switch
#         plus the standard DO_NOT_TRACK and the claude-mem plugin's own toggle.
#         CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is the aggregate (auto-updater
#         + feedback + error-reporting/Sentry + Statsig telemetry); the granular
#         vars are set too for older clients, plus DISABLE_GROWTHBOOK (feature-
#         flag fetches). These are honored by things that CHOOSE to phone home
#         (Statsig, Sentry, GrowthBook, claude-mem) — so their telemetry stops at
#         the source, without blackholing vendor API apexes that MCP *tools*
#         (a Sentry or Datadog MCP) legitimately use.
#
#     (2) NETWORK BLACKHOLE for what ignores the flags. The org's managed
#         remote-settings force-enables CLAUDE_CODE_ENABLE_TELEMETRY (OTEL) at a
#         precedence no in-app setting can beat, and Claude still reaches some
#         Statsig/feature-flag hosts even with the opt-outs set (see
#         anthropics/claude-code#10494). So we map those hosts to 0.0.0.0 in
#         /etc/hosts → the exporter resolves to localhost → connection-refused,
#         fails open (drops the batch, never crashes claude). Hosts come from:
#           - DISCOVERY: every OTLP endpoint declared in the mounted Claude
#             settings and in this process's env (so the org endpoint needs no
#             hand-copying). remote-settings.json is fetched LAZILY and persists
#             in the bind-mounted profile, so discovery covers every boot after
#             the first session; HOOOP_OTEL_COLLECTOR_URL closes the first-boot gap.
#           - DENYLIST: a curated set of pure telemetry / feature-flag hosts that
#             don't honor the flags. Deliberately NOT vendor apexes (sentry.io,
#             datadoghq.com) so MCP tools keep working.
#
#   HOOOP_OTEL_COLLECTOR_URL  optional explicit host(s) to also blackhole — the
#     first-boot gap, or endpoints not present in settings. URL or bare host;
#     comma-/space-separated for multiple. Honored regardless of the switch.
#
# NOTE: a /etc/hosts denylist can't wildcard and can't enumerate every endpoint;
# for a hard guarantee an egress ALLOWLIST firewall is the only complete tool.
# /etc/hosts must also be written at RUNTIME — Docker regenerates it per start,
# so a build-time entry would be wiped (and would leak endpoints into image layers).

# Blackhole every given host in ONE pass: strip scheme/path/userinfo/port, drop
# what's already mapped, append the rest with a single write. Idempotent.
#
# Was one function call per host, each forking a `grep` over /etc/hosts — ~20
# processes on every boot to consult a file that cannot change while we're the
# only writer. Read it once instead: `tr` collapses all whitespace so every
# field becomes a space-delimited word, which turns "is this host already
# mapped" into a substring test with no subshell at all.
#
# Also strictly more correct than the regex it replaces: that pattern
# interpolated the hostname unescaped, so its dots were `.` wildcards and
# `api.statsig.com` would match a line reading `apiXstatsig.com`. Exact word
# matching can't. Case-insensitivity is kept (hosts are compared lowercased).
blackhole_hosts() {
  local present seen=" " out="" added="" h lc
  present=" $(tr -s '[:space:]' ' ' < /etc/hosts 2>/dev/null | tr '[:upper:]' '[:lower:]' || true) "
  for h in "$@"; do
    h="${h#*://}"; h="${h%%/*}"; h="${h##*@}"; h="${h%%:*}"
    [ -n "$h" ] || continue
    # Compare lowercased, but WRITE the spelling we were given. Resolver lookups
    # against /etc/hosts are case-insensitive (verified: `getent hosts LOCALHOST`
    # matches a lowercase entry), so canonicalising would be safe — but a
    # discovered OTEL endpoint arrives in whatever case the settings file used,
    # and this is the path where a miss means telemetry silently egresses. Not
    # worth a behaviour delta from the per-host version this replaced.
    lc="${h,,}"
    # Dedupe within this batch (the denylist and discovery can overlap), then
    # against what the file already maps.
    case "$seen" in *" $lc "*) continue ;; esac
    seen="$seen$lc "
    case "$present" in *" $lc "*) continue ;; esac
    out="${out}0.0.0.0"$'\t'"${h}"$'\n'
    added="$added $h"
  done
  [ -n "$out" ] || return 0
  if printf '%s' "$out" >> /etc/hosts 2>/dev/null; then
    echo "[entrypoint] telemetry: blackholed ->0.0.0.0:$added"
  else
    echo "[entrypoint] telemetry: WARNING could not write /etc/hosts for:$added"
  fi
}

# Curated denylist: pure telemetry / feature-flag / analytics INTAKE hosts that
# don't reliably honor the app-level opt-outs. Vendor API *apexes* are
# deliberately excluded so Sentry/Datadog/PostHog/etc. MCP *tools* keep
# functioning — these are all one-way INGESTION endpoints, never what a tool
# queries interactively:
#   - http-intake.logs.*.datadoghq.com  Datadog log ingestion (tools use api.*)
#   - {us,eu}.i.posthog.com             PostHog event ingestion (claude-mem)
#   - oraios-software.de                Serena news/banner/usage (function is
#                                       100% local LSP; this host is non-functional)
# All of the above were observed leaking empirically (tshark SNI) during a
# claude-mem observer + Serena startup EVEN WITH the documented flags set
# (CLAUDE_MEM_TELEMETRY=0, DO_NOT_TRACK, SERENA_USAGE_REPORTING=false): the
# claude-mem endpoints are assembled at runtime and Serena's news/banner fetches
# aren't covered by its usage-reporting flag — so the flags alone don't suffice
# and the intake hosts must be blackholed to actually stop egress.
TELEMETRY_DENYLIST="
statsig.anthropic.com
api.statsig.com
statsigapi.net
events.statsigapi.net
featuregates.org
featureassets.org
prodregistryv2.org
api.growthbook.io
cdn.growthbook.io
http-intake.logs.datadoghq.com
http-intake.logs.us3.datadoghq.com
http-intake.logs.us5.datadoghq.com
http-intake.logs.ap1.datadoghq.com
http-intake.logs.datadoghq.eu
us.i.posthog.com
eu.i.posthog.com
i.posthog.com
oraios-software.de
"

case "${HOOOP_DISABLE_TELEMETRY:-}" in
  1|true|TRUE|yes|YES|on|ON)
    # (1) App-layer opt-outs — exported as root so the server and every claude /
    # plugin-worker subprocess inherit them.
    export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
    export DISABLE_TELEMETRY=1
    export DISABLE_ERROR_REPORTING=1
    export DISABLE_BUG_COMMAND=1
    export DISABLE_AUTOUPDATER=1
    export DISABLE_GROWTHBOOK=1
    export DO_NOT_TRACK=1
    export CLAUDE_MEM_TELEMETRY=0
    export SERENA_USAGE_REPORTING=false   # Serena MCP startup usage report -> oraios-software.de
    echo "[entrypoint] telemetry: app-layer opt-outs set (nonessential-traffic, telemetry, error-reporting, growthbook, autoupdater, claude-mem, serena)"

    # (2) Network blackhole: discovered OTLP endpoints (settings + env) ∪ denylist.
    _discovered="$(python3 - <<'PY' 2>/dev/null || true
import json, os
from urllib.parse import urlparse
files = [os.path.expanduser(os.path.join("~/.claude", f)) for f in
         ("remote-settings.json", "settings.json", "settings.local.json", "managed-settings.json")]
files.append("/etc/claude-code/managed-settings.json")
keys = ("OTEL_EXPORTER_OTLP_ENDPOINT", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
        "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT")
hosts = set()
def add(v):
    v = (v or "").strip()
    if not v:
        return
    netloc = urlparse(v if "://" in v else "//" + v).netloc or v
    netloc = netloc.split("@")[-1].split(":")[0]
    if netloc:
        hosts.add(netloc)
for fp in files:
    try:
        with open(fp) as fh:
            env = (json.load(fh) or {}).get("env", {})
    except Exception:
        continue
    if isinstance(env, dict):
        for k in keys:
            add(env.get(k))
for k in keys:               # also honor endpoints set directly in this env
    add(os.environ.get(k))
print(" ".join(sorted(hosts)))
PY
)"
    [ -n "$_discovered" ] && echo "[entrypoint] telemetry: discovered OTEL endpoint(s): $_discovered"
    # Unquoted on purpose: both lists are whitespace-separated hostnames that
    # must word-split into separate arguments.
    # shellcheck disable=SC2086
    blackhole_hosts $_discovered $TELEMETRY_DENYLIST
    ;;
esac

# Explicit extra/override hosts — honored regardless of the switch above.
if [ -n "${HOOOP_OTEL_COLLECTOR_URL:-}" ]; then
  # shellcheck disable=SC2086
  blackhole_hosts ${HOOOP_OTEL_COLLECTOR_URL//,/ }
fi
_trace "telemetry isolation done"

# --- Register the in-container browser MCP (idempotent, claude-owned write) ---
# @playwright/mcp + headless Chromium are baked into THIS image and the CLI path
# is exported as PLAYWRIGHT_MCP_CLI (see Dockerfile), so registration is coupled
# to the capability — the path we write always exists in the running image.
#
# We register via `claude mcp add` run as `agent` (claude's own config writer),
# not a host-side jq edit of .claude.json, so it can never race claude's live
# rewrites of that file. Presence is checked first (read-only jq), so the write
# happens once on a fresh profile and every later boot is a pure read.
#
# `--isolated`: the profile is kept in memory and never persisted to disk, so no
# cookies/logins carry across sessions (deliberate: no ambient auth state, and
# concurrent clients don't fight over one on-disk profile). To drive a logged-in
# site, hand the tools a `--storage-state` file. `--no-sandbox` is required
# because we're already inside a locked-down unprivileged container. The
# RCE-equivalent `browser_run_code_unsafe` tool is denied via claude's
# permissions in the mounted settings.json (see cli/lib/stack.sh).
if [ -n "${PLAYWRIGHT_MCP_CLI:-}" ] && [ -f "$PLAYWRIGHT_MCP_CLI" ]; then
  # Presence check uses node (always in this image; jq is not) so we only ever
  # write once and skip on every subsequent boot.
  if ! gosu agent node -e 'let c={};try{c=require(process.argv[1])}catch(e){}process.exit(c&&c.mcpServers&&c.mcpServers.playwright?0:1)' "$HOME_DIR/.claude.json" >/dev/null 2>&1; then
    gosu agent mkdir -p "$HOME_DIR/.cache/playwright-mcp" 2>/dev/null || true
    if gosu agent claude mcp add playwright --scope user \
         -- node "$PLAYWRIGHT_MCP_CLI" \
              --headless --browser chromium --no-sandbox --isolated \
              --output-dir "$HOME_DIR/.cache/playwright-mcp"; then
      echo "[entrypoint] registered in-container playwright browser MCP"
    else
      echo "[entrypoint] WARNING: failed to register playwright browser MCP"
    fi
  fi
fi

# --- Final drop ---------------------------------------------------------------
# `hooop open` keeps this entrypoint but overrides CMD with `claude` directly and
# passes HOOOP_ENTRYPOINT_USER=agent: it has no server, no control socket and no
# sibling sessions, so the model IS the whole container there. $OPEN_MODE is
# derived from this same test at the top of the file — every phase it skipped
# above is skipped precisely because this branch is the one that will be taken.
_trace "browser MCP done — handing over to $ENTRYPOINT_USER"
if [ "$OPEN_MODE" = 1 ]; then
  exec gosu agent "$@"
fi

# Prove the helper works BEFORE handing over, because every failure mode past
# this point is silent. If the setuid bit was stripped (an image built without
# it, `no-new-privileges`, a nosuid mount) the server would come up fine and only
# fail later, at the first session spawn, deep inside claude's stderr. The helper
# self-checks and exits 125; surface that here instead.
if [ ! -x "$AS_AGENT" ]; then
  echo "[entrypoint] FATAL: $AS_AGENT is missing or not executable; refusing to start the server."
  echo "[entrypoint]        Without it the server cannot spawn claude as the model's uid."
  exit 1
fi
if ! as_agent_check="$(setpriv --reuid "$SERVER_USER" --regid "$CONTROL_GROUP" \
                        --groups "$server_groups" \
                        "$AS_AGENT" id -u 2>&1)"; then
  echo "[entrypoint] FATAL: $AS_AGENT cannot drop to the agent uid; refusing to start the server."
  echo "[entrypoint]        $as_agent_check"
  exit 1
fi
if [ "$as_agent_check" != "$(id -u agent)" ]; then
  echo "[entrypoint] FATAL: $AS_AGENT landed on uid $as_agent_check, expected $(id -u agent)."
  exit 1
fi
echo "[entrypoint] hooop-as-agent verified: server($SERVER_USER) -> model(agent uid $as_agent_check)"

# Drop to the server's own account. setpriv rather than gosu because gosu calls
# initgroups(), which would hand the server EVERY group hooopd belongs to —
# including $CONTROL_GROUP as a SUPPLEMENTARY group. That distinction is the
# whole mechanism: hooop-as-agent holds no capabilities and so cannot call
# setgroups(2), which makes replacing the primary gid the only way it can shed
# $CONTROL_GROUP before exec-ing claude. Supplementary hooopctl would survive into
# the model's process tree and hand it back read access to sandbox.token.
#
# So: hooopctl is the PRIMARY gid, and $server_groups (resolved above, and already
# proven to work by the verification) lists exactly the supplementary groups the
# server legitimately needs. hooop-as-agent re-verifies this at runtime and refuses
# to exec if it regresses.
#
# NOT --no-new-privs: that flag is inherited and would neuter the setuid helper.
# (hooop-sandbox-exec sets PR_SET_NO_NEW_PRIVS on itself for the Bash subtree,
# which is downstream of the drop and needs no setuid.)
echo "[entrypoint] dropping to $SERVER_USER (primary group $CONTROL_GROUP, supplementary $server_groups)"
exec setpriv --reuid "$SERVER_USER" --regid "$CONTROL_GROUP" --groups "$server_groups" "$@"
