---
description: Start, stop, or check the hooop local web dashboard (containerized; runs on http://localhost:7842/). Surfaces sessions, skills, sub-agents, events, and search.
allowed-tools: ["Bash"]
---

# /hooop:dashboard

Launches the hooop dashboard, a localhost-only Next.js app that surfaces:

- **Sessions** — live Claude Code sessions on this machine.
- **Skills** — every user-level and plugin skill, with a one-click "Run" trigger.
- **Sub-agents** — nested tree of `Agent` tool invocations, with their prompts, tool calls, and final outputs.
- **Events** — chronological live tail of every Pre/PostToolUse event (push-based via Unix socket, no polling).
- **Search** — BM25 + opt-in semantic + RRF hybrid across all captured events.

The dashboard itself runs **inside a Docker container** — your host only needs Docker Desktop. No Node, no npm install, no Next.js build pollution on the host.

---

## Modes

Argument (default: `start`). These operate on the **whole stack** (both `agent-sandbox` + `dashboard`). For per-service control use the CLI directly: `hooop dashboard <cmd>` / `hooop sandbox <cmd>`.

| Mode | Effect |
|---|---|
| `start` | `docker compose up -d` (builds an image only when it's **missing** — no forced rebuild); waits for the dashboard health endpoint. |
| `stop` | `docker compose down` for the project. |
| `restart` | stop + start. |
| `rebuild` | `docker compose build` + `up -d --force-recreate` — the way to pick up code changes. |
| `status` | reports running / not running. |
| `logs` | tails both containers' logs. |

---

## Execution

1. Resolve the CLI: `${CLAUDE_PLUGIN_ROOT}/cli/hooop.sh` (the oosh `hooop` CLI, shipped inside the plugin). The top-level verbs act on the whole stack.
2. Run with the user's chosen mode (default `start`). Show stdout/stderr to the user verbatim — the CLI narrates its own progress.
3. If `start` reports success, also print:
   - `http://localhost:7842/`
   - One-liner on semantic search: "If Docker Model Runner is available, semantic search activates automatically via the embedder model declared in docker-compose.yml. Otherwise BM25-only search still works."

---

## First-launch notes (relay to user verbatim if asked)

- First start builds the images (~1-2 min). Subsequent starts are seconds because `start` no longer forces a rebuild — run `rebuild` (optionally `rebuild dashboard` / `rebuild sandbox`) after changing code.
- The **agent-sandbox** container bind-mounts only the sandbox Claude profile (`~/.claude/hooop/sandbox/profile`) — never your host `~/.claude`. The hooop plugin is baked into the image at `/opt/hooop`, so no host repo or host Claude Code is required. The **dashboard** is claude-less and talks to the sandbox over a shared Unix socket.
- Skill "Run" triggers spawn `claude -p '/skill-name'` **inside the agent-sandbox container** (the dashboard has no claude) so your host process tree stays clean.

---

## Bash to run

```bash
"${CLAUDE_PLUGIN_ROOT}/cli/hooop.sh" "${1:-start}"
```

After it returns, briefly confirm the outcome and (on `start`) remind the user the URL is `http://localhost:7842/`.
