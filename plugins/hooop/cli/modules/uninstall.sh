#!/bin/bash
#@module Uninstall - purge the hooop stack + state, then remove the CLI

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# The runtime engine (HS_* paths + hooop_stack_purge) and the confirm helper.
# Sourcing both is side-effect-free, so completion/help stay fast.
. ${MODULES_DIR}/../lib/stack.sh
. ${MODULES_DIR}/../lib/prompt.sh

PROFILES=(${HOME}/.bashrc ${HOME}/.zshrc)
HOOOP_OUT_DIR="$(cd "${MODULES_DIR}/.." && pwd)"

function _call() {
  [[ $# -eq 0 ]] && { cli; return; }
  _default_call "$@"
}

#@public ~ purge the hooop stack + all sandbox state, then remove the CLI (keeps the repo)
#@flag -y|--yes UNINSTALL_YES "false" boolean ~ skip the confirmation prompt
function cli() {
  # Uninstall is the inverse of `hooop install`: it tears the stack down and
  # removes ALL hooop state (the same blank-slate teardown as `hooop setup
  # --reset-first`), then removes the CLI — it never re-installs anything. This
  # is destructive, so confirm first (unless -y or head-less with an explicit y).
  cat >&2 <<EOF

  ${_RD}${_B}hooop uninstall — full removal${_RST}
  This PERMANENTLY deletes the hooop stack and all its state:
    • stop + remove containers, network, and the hooop-run volume
    • remove images hooop-sandbox / hooop-dashboard
    • sandbox profile — Claude credentials, MCP config, installed plugins &
      skills, chat sessions, and the events database
    • hooop.env (embedding / telemetry / gh config) + token & cache files
    • any leftover host temp files from an interrupted setup/login run
    • the 'hooop' PATH symlink + shell-completion wiring
  Your host ${_B}~/.claude${_RST} (real Claude Code) and the repo are NOT touched.
EOF
  if [[ "${UNINSTALL_YES:-false}" != true ]]; then
    _p_confirm "Remove everything now?" n || {
      echo "  Uninstall cancelled — nothing was removed." >&2; return 1
    }
  fi

  # Destructive stack teardown (shared with `hooop setup --reset-first`). Guarded
  # on docker so a host without it still gets the CLI removed below.
  if command -v docker >/dev/null 2>&1; then
    hooop_stack_purge
  else
    _info "docker not found — skipping stack teardown, removing the CLI only."
  fi

  # Remove the PATH symlink.
  local bin; bin=$(command -v hooop 2>/dev/null)
  [[ -L "$bin" ]] && rm -f "$bin"

  # Remove the completion symlink from any known location.
  local d
  for d in /opt/homebrew/etc/bash_completion.d \
           /usr/local/etc/bash_completion.d \
           /opt/local/etc/bash_completion.d \
           /etc/bash_completion.d \
           /usr/share/bash-completion/completions \
           ${HOME}/.bash_completion.d; do
    [[ -L "$d/hooop" ]] && rm -f "$d/hooop"
  done

  # Clean shell profiles.
  for i in ${PROFILES[@]}; do
    _remove_from_profile $i "export HOOOP_DIR="
    _remove_from_profile $i "export HOOOP_PATH="
    _remove_from_profile $i "${HOOOP_OUT_DIR}/hooop.comp.sh"
    _remove_from_profile $i "${HOOOP_OUT_DIR}/hooop.zcomp.sh"
  done

  _info "hooop fully removed — stack + state purged, CLI unlinked (the repo at ${HOOOP_OUT_DIR} was left in place)"
}

# Bootstraps the parser
main $0 "$@"
