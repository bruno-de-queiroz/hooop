#!/bin/bash
#@module Add - install MCPs / plugins / skills into the sandbox (persisted in the profile)

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# Shared engine: HS_* paths, the sandbox-exec helpers (_hs_exec_sandbox,
# _hs_require_sandbox_up), and host guards. Sourced, not exec'd — no side effects.
. ${MODULES_DIR}/../lib/stack.sh

# Everything this module writes lands in the sandbox profile
# ($HOME/.claude/hooop/sandbox/profile), which is bind-mounted at /home/agent in
# BOTH the dashboard's agent-sandbox and every `hooop open` container. So an
# install here is durable across rebuild/restart/recreate and shared with open.

#@public ~ install an MCP server — forwards to `claude mcp add` (defaults to --scope user: global + durable)
function mcp() {
  _hs_require_host || return $?
  _requires docker
  [ "$#" -gt 0 ] || _die "usage: hooop add mcp <name> [flags] [-- <command…>]   (forwarded to 'claude mcp add')"
  _hs_require_sandbox_up
  # Inject `--scope user` by default. claude defaults to `local` scope, which
  # keys the server under the CURRENT PROJECT path in ~/.claude.json — but the
  # exec cwd here is the image WORKDIR (/app), so a local server lands under
  # projects["/app"] and is invisible to every dashboard session (cwd
  # ~/workspace or a cloned subdir) AND to `hooop open` (cwd ~/workspace). `user`
  # scope writes the top-level mcpServers key instead: available across ALL
  # projects, durable via the bind-mounted ~/.claude.json. Skip if the caller
  # already chose a scope (only inspect claude flags before a `--` separator).
  local scope=(--scope user) a
  for a in "$@"; do
    case "$a" in
      --) break ;;
      -s|--scope|--scope=*) scope=(); break ;;
    esac
  done
  _info "sandbox: claude mcp add ${scope[*]:+${scope[*]} }$*"
  _hs_exec_sandbox claude mcp add ${scope[@]+"${scope[@]}"} "$@"
}

#@public ~ install a plugin — forwards to `claude plugin install` (user scope: global + durable)
#@flag -m|--marketplace ADD_MARKETPLACE "" ~ marketplace to register first, e.g. owner/repo or a git URL
function plugin() {
  _hs_require_host || return $?
  _requires docker
  [ "$#" -gt 0 ] || _die "usage: hooop add plugin [-m <marketplace>] <plugin[@marketplace]> …"
  _hs_require_sandbox_up
  if [ -n "$ADD_MARKETPLACE" ]; then
    _info "sandbox: claude plugin marketplace add $ADD_MARKETPLACE"
    _hs_exec_sandbox claude plugin marketplace add "$ADD_MARKETPLACE" || _die "marketplace add failed"
  fi
  _info "sandbox: claude plugin install $*"
  _hs_exec_sandbox claude plugin install "$@"
}

#@public ~ install a local skill directory into the sandbox profile (~/.claude/skills/<name>)
#@flag -d|--dir ADD_SKILL_DIR "" dir ~ path to the skill directory (must contain SKILL.md)
#@flag -f|--force ADD_SKILL_FORCE "false" boolean ~ overwrite an existing skill of the same name
function skill() {
  # Pure host-side file copy into the bind-mounted profile — no docker needed,
  # so only refuse from inside a container (don't require the docker CLI).
  if _hs_in_container; then
    _die "refusing to modify the sandbox profile from inside a container — run on your host shell."
  fi
  local src="$ADD_SKILL_DIR"
  [ -n "$src" ]          || _die "usage: hooop add skill -d <path-to-skill-dir> [-f]"
  [ -d "$src" ]          || _die "not a directory: $src"
  [ -f "$src/SKILL.md" ] || _die "no SKILL.md in $src — not a skill directory"
  local name dest; name="$(basename "$src")"; dest="$HS_SANDBOX_CLAUDE_DIR/skills/$name"
  mkdir -p "$HS_SANDBOX_CLAUDE_DIR/skills"
  if [ -e "$dest" ] && [ "$ADD_SKILL_FORCE" != true ]; then
    _die "skill '$name' already exists at $dest (use -f to overwrite)"
  fi
  rm -rf "$dest"
  # -L DEREFERENCES symlinks so the REAL files land in the profile. Skills are
  # very often symlinks (e.g. ~/.claude/skills/foo -> ~/.agents/skills/foo, or
  # nested symlinked assets); a plain `cp -R` copies the link verbatim and it
  # dangles inside the container, where the link target doesn't exist — the
  # skill then silently never loads. Copying the resolved tree fixes that.
  cp -RL "$src" "$dest" || _die "failed to copy skill into $dest"
  _info "installed skill '$name' -> available in the sandbox at ~/.claude/skills/$name"
}

# `mcp` forwards its args VERBATIM to `claude mcp add`, so it must bypass oosh's
# flag parser for EXECUTION: main() strips the `-- <cmd>` separator that stdio
# MCPs rely on and would warn on claude's own flags (-e, --transport, …).
# `-h`/`--help` still route through main() so `hooop add help mcp` and tab-
# completion keep working. plugin/skill use only declared flags, so they flow
# through main() normally and get full flag/dir autocompletion.
case "${1:-}" in
  mcp)
    for _a in "$@"; do
      case "$_a" in -h|--help) main "$0" help "$1"; exit 0 ;; esac
    done
    "$@"; exit $?
    ;;
esac

# Bootstraps the parser
main $0 "$@"
