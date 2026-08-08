#!/bin/bash
_hooop() {
  local cur opts src
  COMPREPLY=()

  src="${HOOOP_PATH}/hooop"
  cur="${COMP_WORDS[COMP_CWORD]}"

  opts=$("$src" shortlist "${COMP_WORDS[@]:1:COMP_CWORD-1}")
  case "$opts" in
    __file__)
      compopt -o filenames 2>/dev/null
      COMPREPLY=($(compgen -f -- "${cur}")) ;;
    __dir__)
      compopt -o filenames 2>/dev/null
      COMPREPLY=($(compgen -d -- "${cur}")) ;;
    *)
      compopt +o filenames 2>/dev/null
      COMPREPLY=($(compgen -W "${opts}" -- "${cur}")) ;;
  esac
  return 0
}
complete -o filenames -F _hooop hooop
