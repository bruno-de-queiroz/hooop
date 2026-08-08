#!/usr/bin/env bash
# progress.sh — tiny step-progress (spinner + elapsed timer) for the hooop CLI.
#
# Contract: sourcing has NO side effects (only function defs + colour fallbacks),
# so it's safe to source during tab-completion or `help`. All rendering goes to
# STDERR (fd 2). When fd 2 isn't a real terminal (CI / piped), or HOOOP_NO_PROGRESS=1,
# or TERM=dumb, the animation is skipped and the wrapped command streams its own
# output normally so logs stay useful.
#
# Usage:
#   _prog_begin 8               # optional: known total → steps render as [i/N]
#   _prog_run "label" cmd args   # spinner while cmd runs; ✔ / ✘ + log tail on fail
#   _prog_end                    # clear the total
#
# The wrapped command runs in the FOREGROUND (so any env/var mutations persist)
# with stdin from /dev/null and stdout+stderr captured to a temp log; only the
# spinner line is shown live. Nested _prog_run calls (an outer step already owns
# the line) just run inline — no double-spinner, no double-count.

# Colour fallbacks — reuse oo.sh's palette when present, else no-op.
: "${_B:=}" "${_RST:=}" "${_DIM:=}" "${_GR:=}" "${_RD:=}" "${_YL:=}" "${_CY:=}"

# hooop brand accent — rgb(226,102,167). Defined HERE (never in oo.sh): truecolor
# when the terminal advertises it (COLORTERM), a basic-magenta fallback so it
# never prints raw, and empty when colour is off. Keyed off oo.sh's palette state
# (_GR non-empty == colour enabled) so it honours OO_COLOR / NO_COLOR untouched.
if [ -z "${_AC:-}" ]; then
  if [ -n "$_GR" ]; then
    case "${COLORTERM:-}" in
      truecolor|24bit) _AC=$'\033[38;2;226;102;167m' ;;
      *)               _AC=$'\033[35m' ;;
    esac
  else
    _AC=""
  fi
fi

# Progress counter state. _prog_begin sets a known total so steps render as
# [i/N]; without it, steps render with no denominator (used by the wizard, whose
# step count isn't known up front).
_PROG_N=""
_PROG_I=0
_prog_begin() { _PROG_N="${1:-}"; _PROG_I=0; }
_prog_end()   { _PROG_N=""; _PROG_I=0; }

# Animate only when stderr is a real terminal, the user hasn't opted out, and the
# terminal isn't the dumb one (which can't handle \r / cursor control).
_prog_active() {
  [ -t 2 ] && [ "${HOOOP_NO_PROGRESS:-0}" != 1 ] && [ "${TERM:-}" != dumb ]
}

# Spinner frames: braille when colour is on, ASCII otherwise. An array (not a
# string slice) so multi-byte glyphs are indexed cleanly regardless of locale.
if [ -n "$_GR" ]; then
  _PROG_FRAMES=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
else
  _PROG_FRAMES=('|' '/' '-' '\')
fi

# Background animator: render "\r <frame> <prefix><label> (Ns)" until killed.
# Runs in its own process and tracks its own start time for the elapsed counter.
_prog_spin() {
  local label="$1" prefix="$2" start=$SECONDS i=0 n=${#_PROG_FRAMES[@]}
  while :; do
    printf '\r  %s%s%s %s%s  %s(%ds)%s' \
      "${_AC:-$_GR}" "${_PROG_FRAMES[i++ % n]}" "$_RST" \
      "$prefix" "$label" "$_DIM" "$((SECONDS - start))" "$_RST" >&2
    sleep 0.1
  done
}

# _prog_run "label" cmd args…  — run cmd under a spinner (see file header).
_prog_run() {
  local label="$1"; shift

  # Nested: an outer step already owns the spinner + output capture. Run inline
  # so we neither double-animate nor double-count.
  if [ -n "${_PROG_IN_STEP:-}" ]; then
    "$@"
    return $?
  fi

  # Headless / opted-out / dumb terminal: stream the command's own output (keeps
  # CI logs useful). Announce the step so progress stays legible.
  if ! _prog_active; then
    [ -n "$_PROG_N" ] && _PROG_I=$((_PROG_I + 1))
    local pfx=""; [ -n "$_PROG_N" ] && pfx="[$_PROG_I/$_PROG_N] "
    printf '  %s+ %s%s%s\n' "$_DIM" "$pfx" "$label" "$_RST" >&2
    "$@"
    return $?
  fi

  _PROG_I=$((_PROG_I + 1))
  local prefix=""; [ -n "$_PROG_N" ] && prefix="[$_PROG_I/$_PROG_N] "
  local log start=$SECONDS rc sp
  log="$(mktemp "${TMPDIR:-/tmp}/hooop-step.XXXXXX" 2>/dev/null)" || log="/tmp/hooop-step.$$"

  command -v tput >/dev/null 2>&1 && tput civis >&2 2>/dev/null
  _prog_spin "$label" "$prefix" & sp=$!
  # Kill the animator if the user interrupts mid-step.
  trap 'kill "$sp" 2>/dev/null' INT TERM

  # Foreground (env preserved). </dev/null forces _hs_exec_sandbox to use -T and
  # keeps tools from grabbing the terminal; all output → the temp log.
  _PROG_IN_STEP=1
  "$@" </dev/null >"$log" 2>&1
  rc=$?
  unset _PROG_IN_STEP

  kill "$sp" 2>/dev/null; wait "$sp" 2>/dev/null
  trap - INT TERM
  command -v tput >/dev/null 2>&1 && tput cnorm >&2 2>/dev/null
  printf '\r\033[K' >&2   # clear the spinner line

  local elapsed=$((SECONDS - start))
  if [ "$rc" -eq 0 ]; then
    printf '  %s✔%s %s%s  %s(%ds)%s\n' "$_GR" "$_RST" "$prefix" "$label" "$_DIM" "$elapsed" "$_RST" >&2
  else
    printf '  %s✘%s %s%s  %s(failed, exit %d)%s\n' "$_RD" "$_RST" "$prefix" "$label" "$_DIM" "$rc" "$_RST" >&2
    if [ -s "$log" ]; then
      # Print the tail only — don't advertise (or keep) the file itself. Many
      # of the commands this wraps (`claude mcp add -e KEY=value ...` for
      # n8n/Datadog/claude-context/Obsidian/Logseq/Context7) carry secrets as
      # literal args; some tools echo their own argv/env back in error output.
      # Keeping the full capture around after we're done with it would leave
      # that secret sitting in $TMPDIR indefinitely — silently, since nothing
      # advertises or cleans up an arbitrary path later. Same "secrets never
      # touch the log" policy _setup_exec already applies to the audit trail.
      printf '    %s—— last log lines ——%s\n' "$_DIM" "$_RST" >&2
      tail -n 20 "$log" 2>/dev/null | sed 's/^/    /' >&2
    fi
  fi
  rm -f "$log"
  return $rc
}
