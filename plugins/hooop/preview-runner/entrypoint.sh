#!/bin/sh
# Preview-runner entrypoint.
#
# Runs as root only long enough to (a) align the container's `runner` user with
# the HOST user's uid, and (b) make the shared control-socket directory
# reachable. Then drops to `runner` via gosu — the supervisor and every preview
# command it spawns run unprivileged.
#
# The uid alignment matters for the same reason it does in the sandbox: the
# workspace is a bind mount of a host directory the AGENT owns, and a preview's
# dev server writes into it (`.next/`, `node_modules/.cache`, build output). If
# the runner wrote as a different uid, the session's tree would end up
# mixed-ownership and `git` inside it would start refusing to operate on
# "dubious ownership".
set -eu

RUNNER_USER=runner
SOCKET_DIR="${HOOOP_PREVIEW_SOCKET_DIR:-/var/run/hooop-preview}"
SOCKET_GID="${HOOOP_PREVIEW_SOCKET_GID:-1101}"
WORKSPACE_DIR="${HOOOP_WORKSPACE_DIR:-/workspace}"

if [ "$(id -u)" = "0" ]; then
  # Align `runner` with the host owner of the workspace. Same collision caveat
  # as the sandbox: if some OTHER account already holds that uid, usermod fails
  # with "UID already exists", so we only try when it's free.
  if [ -n "${HOOOP_HOST_UID:-}" ] && [ "${HOOOP_HOST_UID}" -gt 0 ] 2>/dev/null; then
    current_uid="$(id -u "$RUNNER_USER" 2>/dev/null || echo "")"
    if [ -n "$current_uid" ] && [ "$current_uid" != "$HOOOP_HOST_UID" ]; then
      if usermod -u "$HOOOP_HOST_UID" "$RUNNER_USER" 2>/dev/null; then
        echo "[preview-entrypoint] aligned $RUNNER_USER uid -> $HOOOP_HOST_UID (host owner)"
        # usermod -u does not chase the home directory's own ownership.
        chown -R "$HOOOP_HOST_UID" "/home/$RUNNER_USER" 2>/dev/null || true
      else
        echo "[preview-entrypoint] WARNING: could not remap $RUNNER_USER to host uid $HOOOP_HOST_UID;"
        echo "[preview-entrypoint]          files a preview writes into the workspace may be owned by the wrong user."
      fi
    fi
  fi

  # The control socket lives here, shared with agent-sandbox. 0750 root:hooopctl
  # so the sandbox server (whose primary group IS hooopctl) can traverse it while
  # the model's `agent` uid — in `hooop`, deliberately not in `hooopctl` — cannot.
  mkdir -p "$SOCKET_DIR"
  chgrp "$SOCKET_GID" "$SOCKET_DIR" 2>/dev/null || true
  chmod 2770 "$SOCKET_DIR" 2>/dev/null || true
  # The supervisor writes the socket + token as `runner`, so it needs the group.
  usermod -aG "$SOCKET_GID" "$RUNNER_USER" 2>/dev/null || true

  # Do NOT create or chown the workspace: it is the session's bind mount and
  # already belongs to the agent. Only warn if it's missing, which means the
  # mount didn't happen and every preview is going to fail confusingly.
  if [ ! -d "$WORKSPACE_DIR" ]; then
    echo "[preview-entrypoint] WARNING: $WORKSPACE_DIR is not mounted; previews will have no files to serve."
  fi

  exec gosu "$RUNNER_USER" "$@"
fi

exec "$@"
