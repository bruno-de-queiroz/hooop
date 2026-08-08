#!/usr/bin/env bash
# emit-event.sh — fast hook event emitter for hooop.
#
# Called by Claude Code with the hook type as $1 and the hook context JSON on stdin.
# In the sandboxed-agent runtime the hook fires INSIDE the sandbox container and
# POSTs to the sandbox's /ingest endpoint over a Unix domain socket. Falls back
# to appending to events.jsonl so events are never lost — the sandbox drains
# the file on startup.
#
# Target: <50ms hot path. Pure bash + curl (no node, python, or jq).
# Safety: any failure is swallowed so hooks never block tool execution.

HOOK_TYPE="${1:-unknown}"
STATE_DIR="$HOME/.claude/hooop"
EVENTS_FILE="$STATE_DIR/events.jsonl"
# The hook token lives next to the hook socket, not in the profile: the server
# writes it as its own uid (hooopd) and this script reads it as `agent` through
# the shared `hooop` group. Env-overridable like the socket path — the default
# below is only for a hand-run container without the image's ENV.
HOOK_TOKEN_FILE="${HOOOP_HOOK_TOKEN_FILE:-/run/hooop-hooks/hook.token}"

# Defaults assume the sandboxed runtime: ingest via UDS to the sandbox.
#   HOOOP_SANDBOX_SOCKET — path to the sandbox.sock bind-mount
#   HOOOP_INGEST_URL     — full http(s)://… override for legacy / dev setups
SANDBOX_SOCKET="${HOOOP_SANDBOX_SOCKET:-/var/run/hooop/sandbox.sock}"
INGEST_URL_OVERRIDE="${HOOOP_INGEST_URL:-}"

mkdir -p "$STATE_DIR" 2>/dev/null

TS=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
STDIN_JSON=$(cat 2>/dev/null)

if [ -n "$STDIN_JSON" ]; then
  LINE='{"ts":"'"$TS"'","hook":"'"$HOOK_TYPE"'","ctx":'"$STDIN_JSON"'}'
else
  LINE='{"ts":"'"$TS"'","hook":"'"$HOOK_TYPE"'"}'
fi

post_to_sandbox() {
  command -v curl >/dev/null 2>&1 || return 1
  local token=""
  if [ -r "$HOOK_TOKEN_FILE" ]; then
    token=$(cat "$HOOK_TOKEN_FILE" 2>/dev/null)
  fi
  [ -n "$token" ] || return 1

  if [ -n "$INGEST_URL_OVERRIDE" ]; then
    # Explicit http(s) override: post directly. Useful for dev/CI where the
    # sandbox is reachable on a TCP port.
    curl -fsS --max-time 1 -X POST \
      -H "Content-Type: application/json" \
      -H "X-Hook-Token: $token" \
      --data "$LINE" \
      "$INGEST_URL_OVERRIDE" >/dev/null 2>&1
    return $?
  fi

  [ -S "$SANDBOX_SOCKET" ] || return 1
  curl -fsS --max-time 1 --unix-socket "$SANDBOX_SOCKET" -X POST \
    -H "Content-Type: application/json" \
    -H "X-Hook-Token: $token" \
    --data "$LINE" \
    "http://sandbox/ingest" >/dev/null 2>&1
}

if post_to_sandbox; then
  exit 0
fi

# Fallback: append to the audit file. Sandbox drains this on next startup.
printf '%s\n' "$LINE" >> "$EVENTS_FILE" 2>/dev/null
exit 0
