#!/usr/bin/env bash
# prompt.sh — tiny interactive TTY helpers for the hooop CLI.
#
# oo.sh (the CLI framework) intentionally has no interactive primitives — it's a
# flag/dispatch parser. The `hooop setup` wizard needs menus, confirms,
# and secret reads, so those live here as a small sourced library.
#
# Contract: sourcing has NO side effects (only function defs + color fallbacks),
# so it's safe to source during tab-completion or `help`. Every helper renders
# its prompt/menu on STDERR and prints only the chosen value on STDOUT, so
# callers can capture the answer with `x="$(_p_select …)"` without the menu text
# leaking into the value. Secrets are assigned to a named variable (never echoed).

# Colour fallbacks — reuse oo.sh's palette when present, else no-op so this file
# is usable stand-alone (and during `NO_COLOR`).
: "${_B:=}" "${_RST:=}" "${_CY:=}" "${_DIM:=}" "${_GR:=}" "${_YL:=}" "${_RD:=}" "${_MG:=}"

# Refuse to prompt when stdin isn't a terminal — the wizard can't be driven
# head-less (e.g. from Claude's Bash tool). Callers do `_p_require_tty || return`.
_p_require_tty() {
  if [ ! -t 0 ]; then
    printf '  %s✘%s  this is an interactive wizard — run `hooop setup` in a terminal.\n' "$_RD" "$_RST" >&2
    return 1
  fi
}

# _p_confirm "message" [default:y|n]  → exit 0 (yes) / 1 (no)
_p_confirm() {
  local msg="$1" def="${2:-y}" ans hint
  case "$def" in n|N) hint="[y/N]"; def=n ;; *) hint="[Y/n]"; def=y ;; esac
  while true; do
    printf '  %s %s%s%s ' "$msg" "$_DIM" "$hint" "$_RST" >&2
    read -r ans || return 1
    ans="${ans:-$def}"
    case "$ans" in [Yy]|[Yy][Ee][Ss]) return 0 ;; [Nn]|[Nn][Oo]) return 1 ;; esac
    printf '  %sPlease answer y or n.%s\n' "$_DIM" "$_RST" >&2
  done
}

# _p_input "message" [default]  → prints the entered value (or default) on stdout
_p_input() {
  local msg="$1" def="${2:-}" ans
  printf '  %s%s ' "$msg" "${def:+ [$def]}" >&2
  read -r ans || return 1
  printf '%s' "${ans:-$def}"
}

# _p_secret "message" VARNAME  → reads without echo, assigns to VARNAME
_p_secret() {
  local msg="$1" __p_var="$2" __p_val
  printf '  %s ' "$msg" >&2
  read -rs __p_val || return 1
  printf '\n' >&2
  printf -v "$__p_var" '%s' "$__p_val"
}

# _p_select "header" opt1 opt2 …  → prints the chosen option string on stdout.
# The first option is treated as the default (Enter with no input picks it).
_p_select() {
  local header="$1"; shift
  local opts=("$@") i choice
  {
    printf '\n  %s%s%s\n' "$_B" "$header" "$_RST"
    for i in "${!opts[@]}"; do
      local tag=""; [ "$i" -eq 0 ] && tag=" ${_DIM}(default)${_RST}"
      printf '    %s%d%s) %s%b\n' "$_CY" "$((i + 1))" "$_RST" "${opts[$i]}" "$tag"
    done
  } >&2
  while true; do
    printf '  %s> %s' "$_DIM" "$_RST" >&2
    read -r choice || return 1
    [ -z "$choice" ] && { printf '%s' "${opts[0]}"; return 0; }
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#opts[@]}" ]; then
      printf '%s' "${opts[$((choice - 1))]}"; return 0
    fi
    printf '  %sinvalid choice — enter 1-%d%s\n' "$_DIM" "${#opts[@]}" "$_RST" >&2
  done
}

# _p_select_skip "header" opt1 opt2 …  → prints the chosen option on stdout, or
# NOTHING when the user skips. Skipping is uniform across the wizard: an empty
# line, "none", or "skip" (any case) returns empty. Unlike _p_select there is NO
# Enter-picks-first default — Enter always means skip. Use for optional layers;
# use _p_select when one of the options must be chosen.
_p_select_skip() {
  local header="$1"; shift
  local opts=("$@") i choice
  {
    printf '\n  %s%s%s %s(Enter or "none" to skip)%s\n' "$_B" "$header" "$_RST" "$_DIM" "$_RST"
    for i in "${!opts[@]}"; do
      printf '    %s%d%s) %s\n' "$_CY" "$((i + 1))" "$_RST" "${opts[$i]}"
    done
  } >&2
  while true; do
    printf '  %s> %s' "$_DIM" "$_RST" >&2
    read -r choice || return 0
    case "$choice" in ""|[Nn][Oo][Nn][Ee]|[Ss][Kk][Ii][Pp]) return 0 ;; esac
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "${#opts[@]}" ]; then
      printf '%s' "${opts[$((choice - 1))]}"; return 0
    fi
    printf '  %sinvalid choice — enter 1-%d, or Enter/none to skip%s\n' "$_DIM" "${#opts[@]}" "$_RST" >&2
  done
}

# _p_multiselect "header" opt1 opt2 …  → prints chosen options, one per line.
# User enters comma/space-separated numbers (e.g. "1 3 4" or "1,3"), or "all".
# Skipping is uniform with _p_select_skip: empty, "none", or "skip" selects NONE.
_p_multiselect() {
  local header="$1"; shift
  local opts=("$@") i tok
  {
    printf '\n  %s%s%s %s(numbers e.g. "1 3", "all", or Enter/"none" to skip)%s\n' \
      "$_B" "$header" "$_RST" "$_DIM" "$_RST"
    for i in "${!opts[@]}"; do
      printf '    %s%d%s) %s\n' "$_CY" "$((i + 1))" "$_RST" "${opts[$i]}"
    done
  } >&2
  local raw; printf '  %s> %s' "$_DIM" "$_RST" >&2; read -r raw || return 0
  case "$raw" in ""|[Nn][Oo][Nn][Ee]|[Ss][Kk][Ii][Pp]) return 0 ;; esac
  if [ "$raw" = "all" ] || [ "$raw" = "ALL" ]; then
    printf '%s\n' "${opts[@]}"; return 0
  fi
  raw="${raw//,/ }"
  for tok in $raw; do
    if [[ "$tok" =~ ^[0-9]+$ ]] && [ "$tok" -ge 1 ] && [ "$tok" -le "${#opts[@]}" ]; then
      printf '%s\n' "${opts[$((tok - 1))]}"
    fi
  done
}

# _p_pause "message"  → wait for the user to press Enter (used for manual steps).
_p_pause() {
  local msg="${1:-Press Enter to continue}"
  printf '\n  %s%s …%s ' "$_DIM" "$msg" "$_RST" >&2
  read -r _ || return 1
}
