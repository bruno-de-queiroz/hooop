# Catalog: second-brain

Read by `/hooop:setup` to populate the second-brain menu.

Menu items: Obsidian (sub-menu), Notion, Logseq, NotebookLM, Skip.

---

## Option: Obsidian

Has a follow-up sub-menu with three integration flavors.

### Sub-option A: obsidian-second-brain (Claude Code skill)

**One-line pitch:** Full vault skill suite with 30+ commands. Native to Claude Code.

**When to pick:** Want pre-built vault commands (note creation, daily logs, knowledge synthesis) bundled in. Don't already have a workflow you're trying to preserve.

**Prereqs:** Existing Obsidian vault at a known path. `bash` and `curl` available.

**Install (auto-runnable):**
```bash
curl -fsSL https://raw.githubusercontent.com/eugeniughelbur/obsidian-second-brain/main/scripts/quick-install.sh | bash
```

**Post-install (user-typed slash command):**
```
/obsidian-init
```

**Verify:**
```bash
ls ~/.claude/skills/obsidian-second-brain 2>/dev/null && echo installed
```

**Notes:** This is a Claude Code skill, not an MCP. It writes files in `~/.claude/skills/` and adds slash commands. The `setup.sh` script will prompt for the vault path.

### Sub-option B: mcp-obsidian (MCP via Obsidian REST API)

**One-line pitch:** Lightweight MCP. Wires Claude to the vault via REST. No bundled commands.

**When to pick:** Already have a working Obsidian workflow and just want Claude to read/write notes. Comfortable with the Local REST API plugin.

**Prereqs:** Obsidian Local REST API community plugin installed and enabled (https://github.com/coddingtonbear/obsidian-local-rest-api). API key copied. `uvx` available (`pip install uv` or `brew install uv`).

**Install (auto-runnable):**
```bash
claude mcp add --scope user mcp-obsidian uvx mcp-obsidian \
  --env OBSIDIAN_API_KEY="<YOUR_KEY>" \
  --env OBSIDIAN_HOST="127.0.0.1" \
  --env OBSIDIAN_PORT="27124"
```

**Verify:**
```bash
claude mcp list | grep mcp-obsidian
```

**Notes:** Setup must ask for the API key during the run. Defaults `OBSIDIAN_HOST=127.0.0.1` and `OBSIDIAN_PORT=27124` if not overridden.

### Sub-option C: obsidian-claude-code-mcp (community plugin + /ide)

**One-line pitch:** Obsidian-side plugin that auto-discovers Claude Code via WebSocket. Uses the `/ide` integration.

**When to pick:** Want vault editing inside Obsidian's UI while Claude assists. IDE-style workflow rather than CLI-style.

**Prereqs:** Obsidian. Install the `obsidian-claude-code-mcp` community plugin from Obsidian's Community Plugins browser. Node.js available.

**Install:** Not auto-runnable from Claude. The setup wizard will print these steps and wait for the user to confirm completion:
1. Open Obsidian, go to Settings > Community plugins, search for "Claude Code MCP", install and enable.
2. In the terminal: `claude`
3. In Claude Code: `/ide` and pick "Obsidian".

**Verify:** The user sees Obsidian as a connected IDE in Claude Code's status line.

**Notes:** No `claude mcp add` step. The connection is auto-discovered.

---

## Option: Notion

Two install paths. Default to the official plugin for the richer experience.

### Path A: Notion official plugin (recommended)

**One-line pitch:** Notion's own Claude Code plugin. Bundles the MCP server, pre-built skills, and slash commands.

**When to pick:** Want Notion-specific workflows beyond raw page CRUD. OK with OAuth.

**Prereqs:** A Notion account.

**Install (user-typed slash commands):**
```
/plugin marketplace add makenotion/claude-code-notion-plugin
/plugin install claude-code-notion-plugin@makenotion
```

Then in Claude Code:
```
/mcp
```

Follow the OAuth flow to authenticate.

**Verify:**
```bash
cat ~/.claude/installed_plugins.json | grep -i notion
```

**Notes:** Slash-command install, so the setup wizard prints these and waits for the user to type them.

### Path B: Notion official MCP (HTTP transport)

**One-line pitch:** Minimal MCP install. Just the tools, no bundled skills.

**When to pick:** Want raw Notion access; will build your own workflows.

**Prereqs:** A Notion account.

**Install (auto-runnable):**
```bash
claude mcp add --scope user --transport http notion https://mcp.notion.com/mcp
```

**Authenticate (end of setup, in the sandbox):** `hooop setup` runs `claude mcp login notion --no-browser` at the end — open the printed URL, approve, paste the redirect URL back. (Or run `/mcp` inside a session.)

**Verify:**
```bash
claude mcp list | grep notion
```

**Notes:** Notion's docs warn against the deprecated `notion-mcp-server` npm package. Always use the hosted HTTP endpoint above.

---

## Option: Logseq

**One-line pitch:** MCP for the Logseq graph via Logseq's Local HTTP API.

**When to pick:** Logseq user. Want Claude to query and edit blocks in your graph.

**Prereqs:**
1. Logseq desktop app installed.
2. Logseq HTTP API enabled (click the API icon in Logseq, click "Start server", generate an Authorization token).
3. `uv` available.

**Install (auto-runnable):**
```bash
claude mcp add --scope user mcp-logseq \
  --env LOGSEQ_API_TOKEN="<YOUR_TOKEN>" \
  --env LOGSEQ_API_URL="http://localhost:12315" \
  -- uv run --with mcp-logseq mcp-logseq
```

**Verify:**
```bash
claude mcp list | grep mcp-logseq
```

**Notes:** Setup must ask for the API token during the run. The Logseq HTTP server must be running for the MCP to work.

---

## Option: NotebookLM

**One-line pitch:** Google's NotebookLM for long-form Q&A over uploaded docs. Accesses notebooklm.google.com from Claude via the `notebooklm-mcp` package (Jacob Ben-David, the canonical 2026 choice; ships both the `nlm` CLI and the MCP binary in one install).

**When to pick:** You use (or want to use) NotebookLM for deep Q&A over PDFs, web pages, and Google Drive docs.

**Prereqs:** Google account with NotebookLM access. `pipx` available (the Dockerfile installs it; on host, `brew install pipx` or `python3 -m pip install --user pipx && pipx ensurepath`).

**Install (auto-runnable):**
```bash
pipx install notebooklm-mcp-cli
nlm setup add claude-code
```

The first command installs both the `nlm` CLI and the `notebooklm-mcp` binary. The second writes the MCP server entry into your Claude Code config (`~/.claude.json:mcpServers.notebooklm-mcp`).

**Authenticate (interactive, one-time on host or wherever a browser is available):**
```bash
nlm login
```

This opens a browser and signs you in with Google. Inside a Docker container with no browser, `nlm login` will print a URL plus a code; complete the OAuth in your Mac browser and paste the code back into the terminal (same pattern as `claude login`). Auth state persists under `~/.config/notebooklm-mcp/` (mount this dir or set the appropriate env var if you want to skip re-login in throwaway containers).

**Verify:**
```bash
claude mcp list | grep notebooklm-mcp
```

**Notes:** Until `nlm login` succeeds, the MCP server is configured but every tool call returns an auth error. The wizard installs and wires the package; auth is a separate one-time step the user runs when they're ready.

---

## Option: Skip

No second-brain installed. The routing layer will note "second brain: none" and recommend revisiting later via `/hooop:setup`.
