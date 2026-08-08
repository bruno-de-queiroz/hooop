---
description: Set up the hooop stack. The interactive wizard now lives in the hooop CLI (`hooop setup`) so it works with or without Claude Code on the host; this command points you to it.
allowed-tools: ["Bash"]
---

# /hooop:setup

The hooop setup wizard has moved into the **hooop CLI** as `hooop setup`. It's a
single source of truth: it configures the sandbox stack (memory, code-graph RAG,
automation, platform MCPs, docs RAG, semantic search, observability, design,
second-brain, telemetry isolation) whether or not the host has Claude Code
installed. It has three modes:

- `hooop setup` — installs the **non-interactive default stack** (claude-mem,
  Serena, Context7, semantic search, GitHub, telemetry isolation).
- `hooop setup --wizard` — the **full interactive wizard** (menus, secret prompts).
- `hooop setup <section>…` — runs just the named layers, e.g.
  `hooop setup automation mcps`. Sections: `code-graph`, `automation`, `mcps`,
  `rag`, `model-runner`, `telemetry`, `observability`, `design`,
  `second-brain`, `memory`.

`hooop install` already chains into `hooop setup` (default mode), so a fresh
standalone install is a single command — see the README. The `--wizard` and
`<section>` modes have **interactive menus / secret prompts**, and every mode's
sign-ins (Claude `/login`, `gh`) need a real terminal. Claude's Bash tool is not
an interactive TTY, so it can't drive those for you — the user runs them in their
own terminal. Your job here is only to point them to the right command.

## What to do

1. Resolve the hooop CLI path and check whether `hooop` is already on the user's PATH:

```bash
# Prefer the installed plugin's CLI; fall back to the highest-semver cache dir.
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
PLUGIN_ROOT=$(jq -r '(.plugins | to_entries[] | select(.key|startswith("hooop@")) | .value[0].installPath) // empty' "$INSTALLED" 2>/dev/null | head -1)
if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  PLUGIN_ROOT=$(ls -d "$HOME"/.claude/plugins/cache/*/hooop/*/ 2>/dev/null | sort -V | tail -1)
  PLUGIN_ROOT="${PLUGIN_ROOT%/}"
fi
HOOOP_CLI="$PLUGIN_ROOT/cli/hooop.sh"
command -v hooop >/dev/null 2>&1 && echo "hooop is on PATH" || echo "hooop not on PATH — use: $HOOOP_CLI"
```

2. Tell the user to run setup **in their terminal** (not via you). Pick the form
   that matches their intent:

- Default stack:  `hooop setup`  (or `"$HOOOP_CLI" setup`)
- Full menus:     `hooop setup --wizard`
- Just some layers: `hooop setup <section>…`
- Never installed yet? `"$HOOOP_CLI" install` is the one-liner (wires the CLI onto
  PATH, then runs `hooop setup` for them).

3. Briefly explain what it does: it configures the sandbox stack and, when run in
   a terminal, completes the sign-ins (Claude `/login`, `gh`) and starts the
   dashboard at http://localhost:7842/. If they skipped the sign-ins, they finish
   with `hooop login` (one-time).

Do **not** try to run these yourself — the `--wizard` / `<section>` menus and
every mode's sign-ins need a real interactive TTY, which Claude's Bash tool is
not. Just surface the right command for the user.
