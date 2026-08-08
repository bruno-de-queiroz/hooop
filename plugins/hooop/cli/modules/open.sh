#!/bin/bash
#@module Open - launch an interactive, telemetry-isolated claude sandbox over $PWD

#import oo.sh
. ${MODULES_DIR}/../oo.sh

# Mount the current working directory read-write into the sandbox and drop the
# user into claude code. Uses the same image the dashboard's agent-sandbox runs
# (built by `hooop sandbox rebuild`).
#
#   $PWD        -> /home/agent/workspace   (rw, the code you're editing)
#   <profile>   -> /home/agent             (claude config, credentials, setup MCPs + skills)
#
# Differences from the dashboard's agent-sandbox, by design:
#   - Telemetry is fully isolated (HOOOP_DISABLE_TELEMETRY=1) unless --telemetry.
#   - The model's Bash tool is NOT Landlock-confined (HOOOP_BASH_CONFINE=off,
#     set explicitly below). Confinement exists to stop a dashboard session
#     from reaching the sandbox's own control plane (the token + socket under
#     /var/run/hooop) and other sessions' workdirs. Neither exists here: there
#     is no sandbox server, no socket, no sibling session, and the container
#     isn't reachable from anywhere. What's left would only be a confined
#     interactive shell over the user's OWN code — friction with nothing on
#     the other side of it. See sandbox/lib/landlock-policy.ts.
#   - No chown and no chmod, anywhere. `open` does not manage the profile's
#     ownership or permissions: the container user IS this host user (the uid
#     remap below), so the mount is writable through the owner bits alone. The
#     entrypoint's permission work — the recursive profile chown, the two-uid mode
#     fixups, the socket directories, the /app pass, the setuid-helper stamp —
#     all exists to separate the dashboard's server from the model, and neither
#     the server nor a second uid exists here. It was also most of the boot: the
#     chown walks every inode of the mounted profile (~200k in practice). Run
#     with HOOOP_TRACE=1 for per-phase timings. See sandbox/entrypoint.sh
#     ($OPEN_MODE).
#   - hooop's OWN dashboard-coupled hook commands (permission-gate.sh/emit-event.sh)
#     and the hooop plugin are stripped from a throwaway settings.json overlay:
#     they need the sandbox HTTP socket that doesn't exist here, and claude code's
#     own hooks/permission prompts cover an interactive session. Other hooks any
#     other tool wired into the profile (e.g. Serena's self-contained
#     serena-hooks, which need no socket) are left in place — only hooop's own
#     two commands are filtered out, not the whole `hooks` key. Setup MCPs,
#     skills, other plugins, and credentials from the mounted profile are kept.
#
# docker run is interactive (-it) so claude code's TUI gets a real tty.

#@flag -i|--image OPEN_IMAGE "hooop-sandbox" ~ sandbox image to run
# Default resolved in _launch — oosh only expands a bare "${VAR}" default, not a
# "${VAR}/subpath", so $HOME is expanded here instead of in the annotation.
#@flag -p|--profile OPEN_PROFILE "" dir ~ claude profile to mount (default: ~/.claude/hooop/sandbox/profile)
#@flag -y|--yolo OPEN_YOLO "false" boolean ~ pass --dangerously-skip-permissions to claude
#@flag -T|--telemetry OPEN_TELEMETRY "false" boolean ~ allow bundled-tool telemetry (default: fully isolated)

# Browser automation is provided by the in-container @playwright/mcp baked into
# the sandbox image and registered in the mounted profile — no host process or
# host networking needed (see sandbox/Dockerfile + cli/lib/stack.sh).

#@protected ~ default entrypoint: run claude in an isolated sandbox over $PWD
function _launch() {
  _requires docker

  # Resolve the profile default here so $HOME expands to a real absolute path
  # (docker rejects a bind source containing literal "${HOME}").
  : "${OPEN_PROFILE:=${HOME}/.claude/hooop/sandbox/profile}"

  docker image inspect "$OPEN_IMAGE" >/dev/null 2>&1 \
    || _die "image '${OPEN_IMAGE}' not found — build it first: hooop sandbox rebuild"

  # Bind source must exist or docker creates it as root. The container
  # entrypoint chowns/seeds it under the agent user.
  mkdir -p "${OPEN_PROFILE}/.claude"
  if [[ ! -s "${OPEN_PROFILE}/.claude/.credentials.json" ]]; then
    _error "no claude credentials in ${OPEN_PROFILE} — claude may prompt for login."
    _error "run 'hooop login' once to authenticate the sandbox with its own Claude account."
  fi

  local workspace="/home/agent/workspace"

  # Telemetry isolation is the point of `open` — on by default. The entrypoint
  # honours HOOOP_DISABLE_TELEMETRY=1: exports every documented tool opt-out and
  # blackholes discovered OTEL endpoints + a curated intake denylist in /etc/hosts.
  local iso_env=(-e "HOOOP_DISABLE_TELEMETRY=1")
  [[ "$OPEN_TELEMETRY" == true ]] && iso_env=()

  # Opt out of Bash confinement explicitly (rationale in the header comment).
  # The image sets HOOOP_BASH_CONFINE=require, which is inert on this path today
  # only because nothing here reads it — the sandbox server, which is the sole
  # consumer, never starts. Relying on that is fragile: the flag means "refuse
  # to run rather than run unconfined", so the day anything on the `open` path
  # does consult it, `hooop open` would stop launching instead of degrading.
  # State the intent rather than depend on the omission.
  local confine_env=(-e "HOOOP_BASH_CONFINE=off")

  # Run the whole container as `agent`, not as the server's `hooopd` account.
  # The image's entrypoint now defaults to hooopd because that is what the
  # dashboard stack needs, but this path overrides CMD with `claude` directly:
  # there is no sandbox server, no control socket and no sibling sessions here,
  # so the model IS the container and must own the profile it writes. Without
  # this the claude process would come up as hooopd and be unable to refresh its
  # own OAuth credentials.
  local user_env=(-e "HOOOP_ENTRYPOINT_USER=agent")

  # Align the container's agent user with this host user's uid/gid, same as the
  # compose path (cli/lib/stack.sh: _hs_export_host_ids) — see entrypoint.sh for
  # why: on native Linux Docker it keeps the HOST able to write its own
  # ${OPEN_PROFILE} after the entrypoint's chown. No-op on macOS.
  local id_env=(-e "HOOOP_HOST_UID=$(id -u 2>/dev/null || true)" -e "HOOOP_HOST_GID=$(id -g 2>/dev/null || true)")

  # Forward the boot-phase profiler (see sandbox/entrypoint.sh's _trace). Every
  # other override above gets an explicit -e; this one was documented (line ~32)
  # but never actually wired through, so `HOOOP_TRACE=1 hooop open` silently did
  # nothing — the container never saw the var and every _trace call was a no-op.
  local trace_env=(-e "HOOOP_TRACE=${HOOOP_TRACE:-}")

  # Strip hooop's own dashboard-coupled hook commands + the hooop plugin from a
  # throwaway copy of the profile's settings.json, then overlay it read-only
  # over just that one file. Keeps credentials, setup MCPs (in .claude.json),
  # skills, other plugins, and any OTHER tool's hooks (e.g. Serena's
  # self-contained serena-hooks); drops only emit-event.sh/permission-gate.sh
  # (need a socket absent here) and hooop@workspace.
  local settings_overlay=() tmp_settings=""
  local prof_settings="${OPEN_PROFILE}/.claude/settings.json"
  # Build the overlay UNCONDITIONALLY — even when settings.json doesn't exist
  # yet (a profile that's never been booted, e.g. the very first `hooop open`
  # ever run before `hooop setup`/the dashboard has seeded anything). A missing
  # file has nothing dashboard-specific to strip, but we still need an overlay
  # in place: the container's OWN entrypoint (sandbox/seed-profile.mjs) seeds
  # the hooop hooks + plugin into settings.json unconditionally on every boot,
  # "self-healing" it every time it runs — including inside this `open`
  # container. Skipping the overlay just because there was nothing to strip YET
  # left a race where that first-run seed would land unstripped. Starting from
  # `{}` when the file is absent closes that gap the same way as the read-only
  # mount does for an existing file below.
  if command -v jq >/dev/null 2>&1; then
    tmp_settings="$(mktemp -t hooop-open-settings.XXXXXX)"
    # Belt-and-suspenders: the explicit cleanup at the end of _launch only runs
    # on a normal return, so a Ctrl-C/killed session before then would leave
    # this behind. Contains no credentials (just a hooks-stripped settings.json
    # copy), but stray files are still stray files.
    trap 'rm -f "$tmp_settings"' EXIT
    local src_json='{}'
    [[ -f "$prof_settings" ]] && src_json="$(cat "$prof_settings" 2>/dev/null || echo '{}')"
    if printf '%s' "$src_json" | jq '.hooks |= ((. // {})
             | with_entries(
                 .value |= (
                   map(.hooks |= map(select(((.command // "") | startswith("/opt/hooop/hooks/scripts/")) | not)))
                   | map(select((.hooks | length) > 0))
                 )
               )
             | with_entries(select((.value | length) > 0))
           )
           | if (.hooks | length) == 0 then del(.hooks) else . end
           | if (.enabledPlugins | type) == "object" then .enabledPlugins |= del(.["hooop@workspace"]) else . end' \
           > "$tmp_settings" 2>/dev/null; then
      # 0644 so the in-container agent (uid 1100) can read it on a Linux bind mount.
      chmod 0644 "$tmp_settings"
      settings_overlay=(-v "${tmp_settings}:/home/agent/.claude/settings.json:ro")
    else
      rm -f "$tmp_settings"; tmp_settings=""
      _error "could not rewrite settings.json — dashboard hooks may error inside the sandbox."
    fi
  else
    _error "jq not found on host — cannot strip dashboard hooks; they will error inside the sandbox."
  fi

  # --yolo -> claude's --dangerously-skip-permissions.
  local claude_flags=()
  [[ "$OPEN_YOLO" == true ]] && claude_flags=(--dangerously-skip-permissions)

  # -it: interactive tty for claude code's TUI.
  # --rm: ephemeral; state that matters lives in the mounted profile + $PWD.
  # Overrides the image CMD (the sandbox server) with claude + any passthrough
  # args (a prompt, --model, etc.). Not exec'd so we can clean up the overlay.
  docker run --rm -it \
    ${iso_env[@]+"${iso_env[@]}"} \
    ${confine_env[@]+"${confine_env[@]}"} \
    ${user_env[@]+"${user_env[@]}"} \
    ${id_env[@]+"${id_env[@]}"} \
    ${trace_env[@]+"${trace_env[@]}"} \
    ${settings_overlay[@]+"${settings_overlay[@]}"} \
    -v "${PWD}:${workspace}" \
    -v "${OPEN_PROFILE}:/home/agent" \
    -w "$workspace" \
    "$OPEN_IMAGE" claude ${claude_flags[@]+"${claude_flags[@]}"} "$@"
  local rc=$?

  [[ -n "$tmp_settings" ]] && rm -f "$tmp_settings"
  exit $rc
}

# Forward everything that isn't a built-in straight to claude, so `hooop open`,
# `hooop open --model opus`, and `hooop open "fix the bug"` all work. Built-ins
# (help/shortlist/version) still resolve normally for tab-completion + help.
function _call() {
  case "${1:-}" in
    help|--help|-h|shortlist|version|--version|-V) _default_call "$@"; return ;;
  esac
  _launch "$@"
}

# Bootstraps the parser
main $0 "$@"
