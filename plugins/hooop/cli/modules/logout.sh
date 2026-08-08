#!/bin/bash
#@module Logout - clear the sandbox's Claude login (sign in again with hooop login)

#import oo.sh
. ${MODULES_DIR}/../oo.sh
. ${MODULES_DIR}/../lib/stack.sh

#@protected ~ clear the sandbox's Anthropic OAuth (preserves per-MCP oauth)
function _logout() {
  hooop_stack_logout "$@"
  exit $?
}

function _call() {
  case "${1:-}" in
    help|--help|-h|shortlist|version|--version|-V) _default_call "$@"; return ;;
  esac
  _logout "$@"
}

# Bootstraps the parser
main $0 "$@"
