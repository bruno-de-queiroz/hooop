#!/bin/bash
#@module Login - authenticate the sandbox with its own Claude account (one-time)

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# The two-service engine owns the interactive login (compose exec into the
# running agent-sandbox). Sourced, not exec'd — no side effects at source time.
. ${MODULES_DIR}/../lib/stack.sh

#@protected ~ run the one-time interactive sandbox login (claude /login)
function _login() {
  hooop_stack_login "$@"
  exit $?
}

# `hooop login` takes no subcommands — anything that isn't a built-in runs the
# login flow. Built-ins (help/shortlist/version) still resolve for tab-
# completion + help.
function _call() {
  case "${1:-}" in
    help|--help|-h|shortlist|version|--version|-V) _default_call "$@"; return ;;
  esac
  _login "$@"
}

# Bootstraps the parser
main $0 "$@"
