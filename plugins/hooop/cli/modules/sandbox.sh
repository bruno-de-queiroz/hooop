#!/bin/bash
#@module Sandbox - manage just the agent-sandbox container lifecycle

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# The two-service engine (preflight + compose). Sourced, not exec'd, so these
# commands call its functions scoped to the sandbox service — the host-side
# preflight (credential reconcile, plugin wiring, forwarded env) runs before
# the container comes up.
. ${MODULES_DIR}/../lib/stack.sh

#@public ~ start the agent-sandbox container (builds its image only if missing)
function start() { hooop_stack_start sandbox; }

#@public ~ stop the agent-sandbox container (leaves the dashboard running)
function stop() { hooop_stack_stop sandbox; }

#@public ~ restart just the agent-sandbox container
function restart() { hooop_stack_restart sandbox; }

#@public ~ rebuild the sandbox image and recreate the container (picks up code changes)
#@flag -n|--no-cache SANDBOX_NO_CACHE "false" boolean ~ build without the layer cache
function rebuild() {
  hooop_stack_nocache "$SANDBOX_NO_CACHE"
  hooop_stack_rebuild sandbox
}

#@public ~ pin the claude-code CLI baked into the sandbox image to a version and rebuild just that layer forward
#@flag -c|--claude-version SANDBOX_CLAUDE_VERSION "" ~ version to pin (default: resolve latest from npm)
function update() {
  _hs_require_host || return $?
  _hs_preflight_common || return 1
  local version="$SANDBOX_CLAUDE_VERSION"
  if [[ -z "$version" ]]; then
    # Resolve the latest version WITHOUT host npm — run npm inside the sandbox
    # image (Node is baked in), keeping the host Docker-only.
    docker image inspect "$HS_IMAGE_SANDBOX" >/dev/null 2>&1 \
      || _die "sandbox image not built yet — run 'hooop start' first, or pass -c <version>"
    version="$(docker run --rm --entrypoint npm "$HS_IMAGE_SANDBOX" view @anthropic-ai/claude-code version 2>/dev/null | tr -d '[:space:]')"
    [[ -n "$version" ]] || _die "could not resolve latest @anthropic-ai/claude-code version (need network + the sandbox image; or pass -c <version>)"
  fi
  _info "pinning claude-code ${version} into the sandbox image"
  # Run the same host-side preflight as start/rebuild so the recreated container
  # keeps its forwarded env (embedding backend, gh token, telemetry switches)
  # instead of losing it to empty compose interpolation. Also creates/chmods the
  # bind-mount source so docker doesn't make it root-owned.
  _hs_preflight_sandbox
  "${HS_COMPOSE[@]}" build --build-arg "CLAUDE_CODE_VERSION=${version}" "$HS_SVC_SANDBOX"
  "${HS_COMPOSE[@]}" up -d --no-deps --force-recreate "$HS_SVC_SANDBOX"
}

# NOTE: installing MCPs/plugins/skills lives in the `add` module (hooop add …);
# bind-mounting host folders lives in the `mount` module (hooop mount …). Both
# were split out of here so their subcommands get first-class oosh help + tab-
# completion. This module now only owns the agent-sandbox container lifecycle.

# Bootstraps the parser
main $0 "$@"
