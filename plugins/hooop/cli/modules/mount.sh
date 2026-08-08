#!/bin/bash
#@module Mount - bind-mount host folders into the sandbox workspace

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# Shared engine: HS_* paths, HS_COMPOSE, the mounts.list/override helpers
# (_hs_regen_mounts_override, _hs_compose_reload) and host guards. No side effects.
. ${MODULES_DIR}/../lib/stack.sh

# oo.sh ships _info/_error/_die but no warning level; doctor.sh defines its own
# for the same reason. Same glyph and colour as doctor's, so the two read alike.
_mount_warn() { printf "  ${_YL}!${_RST}  %s\n" "$*"; }

# Can the sandbox SERVER actually walk a freshly mounted tree?
#
# The server runs as its own user (`hooopd`) while the model runs as `agent`, and a
# mounted tree keeps its HOST ownership — the entrypoint's `-xdev` guard
# deliberately never chowns into nested mounts. So on a host that enforces
# bind-mount permissions, the server reaches it only through group or "other"
# bits; it joins the host's own gid, which makes 0750 fine and 0700 not.
#
# Asked of the CONTAINER, after the mount exists, rather than inferred from host
# permissions. An earlier version ran `stat -c` on the host and gated on
# `uname -s = Linux`, which conflates two unrelated questions — "is GNU stat
# available" and "does this bind mount enforce DAC" — and answers the second one
# wrongly in both directions: Docker Desktop for Linux reports uname=Linux while
# mounting through a VM that does not enforce, and a macOS VM runtime that DOES
# enforce gets skipped entirely. The container can simply answer it.
#
# The model is unaffected either way (it IS the host uid), so a failure here
# degrades the dashboard's Files navigator and git decoration rather than breaking
# the mount. Warn, never refuse.
_hs_warn_unreadable_mount() {
  local name="$1" target="/home/agent/workspace/$1"

  # Older image without the uid split: one user, nothing to check.
  "${HS_COMPOSE[@]}" exec -T "$HS_SVC_SANDBOX" id -u hooopd >/dev/null 2>&1 || return 0

  # Distinguish "not there" from "there but unreadable" — as root first, which DAC
  # does not apply to. Conflating them sends the reader off to chmod a directory
  # whose real problem is that the mount never applied (a failed `compose up`, say),
  # which is exactly the wrong trail. Observed doing precisely that.
  if ! "${HS_COMPOSE[@]}" exec -T "$HS_SVC_SANDBOX" test -e "$target" >/dev/null 2>&1; then
    _mount_warn "$target does not exist in the container — the mount did not take effect."
    _mount_warn "Check the output above for a failed 'compose up', then: hooop sandbox restart"
    return 0
  fi

  # `test -r X -a -x X` in one exec, with no shell, so a name containing quotes
  # cannot break out of the command.
  if "${HS_COMPOSE[@]}" exec -T -u hooopd "$HS_SVC_SANDBOX" \
       test -r "$target" -a -x "$target" >/dev/null 2>&1; then
    return 0
  fi

  _mount_warn "the sandbox server cannot read $target inside the container."
  _mount_warn "The dashboard's Files navigator will show it as empty; the agent itself is unaffected."
  _mount_warn "To fix, on the host:  chmod g+rX '$2'   (the server joins your gid $(id -g))"
}

# Recreate just the sandbox container so a changed mount set takes effect.
#
# Goes through the full preflight, like every other path that ups the sandbox
# (hooop_stack_start/restart/rebuild and `hooop sandbox update` all call it). This
# used to call _hs_compose_reload alone, which recreates the container with
# everything the preflight exports MISSING — measured: HOOOP_HOST_UID went from set
# to empty across a `hooop mount add`, so the entrypoint skipped the uid remap and
# `agent` came back on its baked 1100 instead of the host owner's uid. macOS hides
# that (the bind mount squashes ownership and ignores DAC); on Linux and WSL2 it
# locks the HOST out of its own profile. The same gap drops whatever hooop.env
# exports — GH_TOKEN, OPENAI_API_KEY, EMBEDDING_* — and skips the DMR guard.
function _hs_recreate_sandbox() {
  _hs_preflight_sandbox
  "${HS_COMPOSE[@]}" up -d --no-deps --force-recreate "$HS_SVC_SANDBOX"
}

#@public ~ bind-mount a host folder into the sandbox workspace (recreates the container)
#@flag -p|--path MOUNT_PATH "" dir ~ host directory to mount (required)
#@flag -n|--name MOUNT_NAME "" ~ name under ~/workspace/ inside the sandbox (default: the folder's basename)
function add() {
  _hs_require_host || return $?
  _requires docker
  _requires awk
  [ -n "$MOUNT_PATH" ] || _die "usage: hooop mount add -p <host-path> [-n <name>]"
  local host; host="$(cd "$MOUNT_PATH" 2>/dev/null && pwd)" || _die "not a directory: $MOUNT_PATH"
  [ -d "$host" ] || _die "not a directory: $MOUNT_PATH"
  local name="${MOUNT_NAME:-$(basename "$host")}"
  case "$name" in */*|*'\'*|.|..|"") _die "invalid mount name: '$name' (must be a single path segment)" ;; esac

  mkdir -p "$HS_SANDBOX_PROFILE_ROOT"
  touch "$HS_SANDBOX_MOUNTS_LIST"
  # Upsert: drop any prior entry for this name, then append the new mapping.
  local tmp; tmp="$(mktemp)"
  awk -F '\t' -v n="$name" '$2 != n' "$HS_SANDBOX_MOUNTS_LIST" > "$tmp" 2>/dev/null || true
  printf '%s\t%s\n' "$host" "$name" >> "$tmp"
  mv "$tmp" "$HS_SANDBOX_MOUNTS_LIST"

  _hs_regen_mounts_override
  _info "mounting $host -> /home/agent/workspace/$name (recreating sandbox)"
  _hs_recreate_sandbox
  # Only meaningful once the container has been recreated WITH the mount.
  _hs_warn_unreadable_mount "$name" "$host"
}

#@public ~ list host folders currently mounted into the sandbox workspace
function list() {
  if [ ! -s "$HS_SANDBOX_MOUNTS_LIST" ]; then
    _info "no mounts configured"
    return 0
  fi
  local host name
  while IFS=$'\t' read -r host name; do
    [ -n "$host" ] || continue
    printf "  %s  ->  /home/agent/workspace/%s\n" "$host" "$name"
  done < "$HS_SANDBOX_MOUNTS_LIST"
}

#@public ~ remove a previously mounted folder by name (recreates the container)
function remove() {
  _hs_require_host || return $?
  _requires awk
  local name="${1:-}"
  [ -n "$name" ] || _die "usage: hooop mount remove <name>"
  [ -s "$HS_SANDBOX_MOUNTS_LIST" ] || _die "no mounts configured"
  local tmp; tmp="$(mktemp)"
  awk -F '\t' -v n="$name" '$2 != n' "$HS_SANDBOX_MOUNTS_LIST" > "$tmp"
  if cmp -s "$tmp" "$HS_SANDBOX_MOUNTS_LIST"; then
    rm -f "$tmp"; _die "no such mount: $name"
  fi
  mv "$tmp" "$HS_SANDBOX_MOUNTS_LIST"
  _hs_regen_mounts_override
  _info "unmounted '$name' (recreating sandbox)"
  _hs_recreate_sandbox
}

# Bootstraps the parser
main $0 "$@"
