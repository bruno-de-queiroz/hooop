#!/bin/bash
#@module Install - install/configure the hooop CLI (symlinks + shell completion)

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# Interactive confirm helper (side-effect-free to source, so completion/help
# stay fast). Used to ask before reconfiguring an existing install.
. ${MODULES_DIR}/../lib/prompt.sh

PROFILES=(${HOME}/.bashrc ${HOME}/.zshrc)
# Resolved at runtime so the repo is portable (no absolute paths baked in).
HOOOP_OUT_DIR="$(cd "${MODULES_DIR}/.." && pwd)"

function _call() {
  # The interactive stack wizard moved out of here into its own top-level
  # command: `hooop setup` (was `hooop install setup`). Point stale muscle memory
  # + old docs at the new spelling instead of a bare "unknown command".
  if [[ "${1:-}" == setup ]]; then
    _error "\`hooop install setup\` has moved — run:  hooop setup"
    return 2
  fi
  [[ $# -eq 0 ]] && { cli; return; }
  _default_call "$@"
}

#@protected ~ find a writable bin directory
function _find_bin_dir() {
  local d
  for d in /opt/homebrew/bin /usr/local/bin ${HOME}/.local/bin; do
    [[ -d "$d" && -w "$d" ]] && { echo "$d"; return; }
  done
  mkdir -p "${HOME}/.local/bin"
  for i in ${PROFILES[@]}; do
    _write_to_profile $i 'export PATH="$HOME/.local/bin:$PATH"'
  done
  echo "${HOME}/.local/bin"
}

#@protected ~ find bash completion directory
function _find_comp_dir() {
  local d
  for d in /opt/homebrew/etc/bash_completion.d \
           /usr/local/etc/bash_completion.d \
           /opt/local/etc/bash_completion.d \
           /etc/bash_completion.d \
           /usr/share/bash-completion/completions; do
    [[ -d "$d" && -w "$d" ]] && { echo "$d"; return; }
  done
  d="${HOME}/.bash_completion.d"
  mkdir -p "$d"
  local entry='for f in ~/".bash_completion.d/"*; do [[ -f "$f" ]] && . "$f"; done'
  for i in ${PROFILES[@]}; do
    _write_to_profile $i "$entry"
  done
  echo "$d"
}

#@public ~ install the hooop cli (symlinks + shell profile wiring) then run setup
#@flag -f|--force INSTALL_FORCE "false" boolean ~ reinstall even if hooop is already on PATH
#@flag --wizard INSTALL_WIZARD "false" boolean ~ run the interactive setup wizard instead of installing the default stack
function cli() {
  # Decide whether to (re)wire the symlink + shell profile. When `hooop` is
  # already on PATH we don't need to relink — but `hooop install` continues into
  # `hooop setup`, so ask first whether to reconfigure (a plain re-run shouldn't
  # silently rebuild/reconfigure the stack). `-f|--force` relinks and proceeds
  # without asking; a non-interactive shell can't be asked, so it proceeds.
  local _wire=true _existing_bin
  _existing_bin=$(command -v hooop 2>/dev/null || true)
  if [[ -n "$_existing_bin" && "$INSTALL_FORCE" == true ]]; then
    _info "forcing reinstall (removing existing ${_existing_bin})"
    rm -f "$_existing_bin"
  elif [[ -n "$_existing_bin" && -e "$_existing_bin" ]]; then
    if [ -t 0 ] && ! _p_confirm "hooop is already installed at ${_existing_bin}. Reconfigure the stack now (runs 'hooop setup')?" y; then
      _info "left as-is — run 'hooop setup' any time to reconfigure, or 'hooop install -f' to relink."
      return 0
    fi
    _info "hooop already on PATH — skipping relink, continuing to setup (use -f|--force to relink)."
    _wire=false
  elif [[ -n "$_existing_bin" ]]; then
    _info "hooop symlink is broken — reinstalling"
    rm -f "$_existing_bin"
  fi

  if [[ "$_wire" == true ]]; then
    local binDir; binDir=$(_find_bin_dir)
    local compDir; compDir=$(_find_comp_dir)

    ln -sf "${HOOOP_OUT_DIR}/hooop.sh" "$binDir/hooop"
    ln -sf "${HOOOP_OUT_DIR}/hooop.comp.sh" "$compDir/hooop"

    # NB: we intentionally do NOT export HOOOP_DIR — hooop.sh always self-resolves
    # its own location, and a stale exported HOOOP_DIR (e.g. after the CLI moves)
    # only causes confusion. HOOOP_PATH is still needed by the completion script.
    for i in ${PROFILES[@]}; do
      _write_to_profile $i "export HOOOP_PATH=$binDir"
      if [[ "$i" == *".zshrc" ]]; then
        _write_to_profile $i "autoload -Uz compinit && compinit"
        _write_to_profile $i "[[ -f ${HOOOP_OUT_DIR}/hooop.zcomp.sh ]] && source ${HOOOP_OUT_DIR}/hooop.zcomp.sh"
      else
        _write_to_profile $i "[[ -f ${HOOOP_OUT_DIR}/hooop.comp.sh ]] && . ${HOOOP_OUT_DIR}/hooop.comp.sh"
      fi
    done

    _info "hooop installed to ${binDir}/hooop"
    _info "open a new shell (or 'source ${HOOOP_OUT_DIR}/hooop.comp.sh') to enable completion"
  fi

  # `hooop install` is the one-liner: after wiring the CLI onto PATH it continues
  # straight into `hooop setup`, which configures the sandbox stack and — when a
  # TTY is present — signs the sandbox in and starts the dashboard. Invoke the
  # CLI by its real path (not the just-created PATH symlink the current shell
  # hasn't picked up yet). Pass --wizard through for the full interactive menus.
  local _setup_args=()
  [[ "${INSTALL_WIZARD:-false}" == true ]] && _setup_args=(--wizard)
  _info "configuring the sandbox stack: hooop setup ${_setup_args[*]}"
  "${HOOOP_OUT_DIR}/hooop.sh" setup "${_setup_args[@]}"
}

# Bootstraps the parser
main $0 "$@"
