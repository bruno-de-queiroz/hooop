#!/bin/bash
#
# hooop — oosh-generated CLI for the hooop stack. Ships inside the plugin
# (plugins/hooop/cli) so the slash commands can invoke it directly.
#
# Top-level verbs (start/stop/restart/rebuild/status/logs) drive the WHOLE
# stack via the engine in lib/stack.sh. Modules scope a single concern:
#   dashboard   control only the dashboard UI container
#   sandbox     control only the agent-sandbox container (+ update)
#   open        launch an interactive claude sandbox in the current directory
#   setup       interactive wizard: configure the sandbox stack (native /hooop:setup)
#
# HOOOP_DIR is always resolved from this script's own location (see below), so
# the CLI works straight from the repo (./plugins/hooop/cli/hooop.sh ...) with no
# env setup. `hooop install` symlinks it onto PATH and wires up HOOOP_PATH +
# shell completion in your profile (it does NOT export HOOOP_DIR — self-resolution
# makes that both unnecessary and a footgun if the CLI ever moves).

# Resolve the real directory of THIS script (following symlinks) and always use
# it — the script knows where it lives, so we intentionally ignore any inherited
# HOOOP_DIR. Honoring a stale exported value (e.g. from an old `hooop install`
# before the CLI moved) would make it look for oo.sh/lib/modules at the wrong
# path. Self-resolution keeps in-repo runs, the installed symlink, and slash
# commands all correct with zero env setup.
_hooop_src="${BASH_SOURCE[0]}"
while [ -L "$_hooop_src" ]; do
  _hooop_dir="$(cd "$(dirname "$_hooop_src")" && pwd)"
  _hooop_src="$(readlink "$_hooop_src")"
  [[ "$_hooop_src" != /* ]] && _hooop_src="$_hooop_dir/$_hooop_src"
done
export HOOOP_DIR="$(cd "$(dirname "$_hooop_src")" && pwd)"
export MODULES_DIR="${HOOOP_DIR}/modules"
unset _hooop_src _hooop_dir

#import oo.sh
. "${HOOOP_DIR}/oo.sh"
# The two-service runtime engine (preflight + docker-compose orchestration).
# Sourcing has no side effects; the top-level lifecycle verbs below call its
# functions to drive the WHOLE stack. Per-service control lives in the
# dashboard/sandbox modules (which source the same engine).
. "${HOOOP_DIR}/lib/stack.sh"

MODULES=""
for _f in "${MODULES_DIR}"/*.sh; do
  [[ -f "$_f" ]] && MODULES="${MODULES:+${MODULES} }$(basename "${_f%.sh}")"
done
unset _f

# Top-level verbs act on the WHOLE stack (both services). They drive the engine
# directly with the `all` target; `hooop dashboard <cmd>` / `hooop sandbox <cmd>`
# scope a single service.
LIFECYCLE_VERBS="start stop restart rebuild status logs"

function _orchestrate() {
  local action="$1"; shift
  # Let `hooop rebuild -n` / `--no-cache` bust the layer cache for the whole stack.
  local a
  for a in "$@"; do
    case "$a" in -n|--no-cache) hooop_stack_nocache true ;; esac
  done
  case "$action" in
    start)   hooop_stack_start all ;;
    stop)    hooop_stack_stop all ;;
    restart) hooop_stack_restart all ;;
    rebuild) hooop_stack_rebuild all ;;
    status)  hooop_stack_status ;;
    logs)    hooop_stack_logs all ;;
  esac
}

function _shortlist() {
  local all=("$@")
  local module="${all[0]}"

  if [[ -f "${MODULES_DIR}/${module}.sh" ]]; then
    all=("${all[@]:1}")
    "${MODULES_DIR}/${module}.sh" shortlist "${all[@]}"
  elif [[ "$module" == "logs" ]]; then
	echo ""
  elif [[ "$module" == "help" ]]; then
    _default_shortlist "$@"
    [[ -z "${all[1]}" ]] && echo "$LIFECYCLE_VERBS $MODULES"
  else
    _default_shortlist "$@"
    echo "$MODULES"
    # Offer the top-level lifecycle verbs only while completing the first token.
    [[ -z "$module" ]] && echo "$LIFECYCLE_VERBS"
  fi
}

function _help() {
  printf "\n  ${_DIM}Usage:${_RST} ${_B}hooop${_RST} ${_CY}[ ${LIFECYCLE_VERBS} ${MODULES} help ]${_RST}\n"
  printf "\n  ${_B}Commands:${_RST} ${_DIM}(whole stack: sandbox + dashboard)${_RST}\n"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "start"   "start both services (builds an image only if missing)"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "stop"    "stop both services"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "restart" "restart both services"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "rebuild" "rebuild both images and recreate (picks up code changes)"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "status"  "is the dashboard up?"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "logs"    "follow both services' logs"
  printf "  ${_CY}%-20s${_RST} ${_DIM}%s${_RST}\n" "help"    "show options and flags available"
  printf "\n  ${_B}Modules:${_RST} ${_DIM}(scope a single concern)${_RST}\n"
  for module in $MODULES; do
    if [[ -f "${MODULES_DIR}/${module}.sh" ]]; then
      local description="" _desc_line _pfx="#@module"
      while IFS= read -r _desc_line; do
        [[ "$_desc_line" == '#@module'* ]] || continue
        description="${_desc_line#"$_pfx"}"
        description="${description#"${description%%[! ]*}"}"
        break
      done < "${MODULES_DIR}/${module}.sh"
      printf "  ${_MG}%-20s${_RST} ${_DIM}%s${_RST}\n" "$module" "$description"
    fi
  done
  echo ""
}

function _call() {
  local all=("$@")
  local module="${all[0]}"

  # Top-level lifecycle verbs drive the whole-stack engine.
  if [[ -n "$module" && " ${LIFECYCLE_VERBS} " == *" ${module} "* ]]; then
    all=("${all[@]:1}")
    _orchestrate "$module" "${all[@]}"
    return $?
  fi

  if [[ "$module" =~ ^[a-zA-Z0-9_-]+$ && -f "${MODULES_DIR}/${module}.sh" ]]; then
    all=("${all[@]:1}")
    "${MODULES_DIR}/${module}.sh" "${all[@]}"
  else
    _default_call "$@"
  fi
}

# `hooop add mcp …` forwards its args verbatim to the real `claude mcp add`
# inside the sandbox. oosh's parser would strip the `--` separator that stdio
# MCPs (`… -- npx -y some-mcp`) rely on and warn on claude's own flags, so hand
# the raw args straight to the add module (which has its own pre-main intercept
# for `mcp`) before main() ever sees them. Only `add mcp` needs this — the other
# add/mount subcommands use declared flags and flow through main() normally, so
# they keep full help + tab-completion. `hooop shortlist …` / `hooop help …` keep
# first token = shortlist/help, so this never fires for completion or help.
if [[ "${1:-}" == "add" && "${2:-}" == "mcp" ]]; then
  exec "${MODULES_DIR}/add.sh" "${@:2}"
fi

main "$0" "$@"
