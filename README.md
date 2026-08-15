# hooop

[![CI](https://github.com/bruno-de-queiroz/hooop/actions/workflows/ci.yml/badge.svg)](https://github.com/bruno-de-queiroz/hooop/actions/workflows/ci.yml)

<img width="1280" height="640" alt="image" src="https://github.com/user-attachments/assets/ef8186db-5c0f-417b-b1eb-941eb55006f3" />

**hooop** runs Claude Code inside a disposable Docker sandbox, with a live web dashboard in front of it. The agent works isolated from your machine, and you get to watch every move.

It gives you two things:

1. **A curated agent stack.** `hooop setup` installs a solid default toolset into the sandbox (memory, code-graph search, docs search, semantic search, GitHub, telemetry isolation). Add `--wizard` for the full menu: automation, platform MCPs, observability, design, second-brain, and more.
2. **A live dashboard.** A containerized Next.js app at [http://localhost:7842/](http://localhost:7842/): live sessions, a skill browser with one-click triggers, a sub-agent tree, live event logs, a diff viewer for files the agent touched, and search across everything that happened.

hooop doesn't reimplement the MCPs or skills it installs. It picks them, installs them, documents them, and shows you what they're doing.

## Install

You only need Docker and `jq`. Everything else, Claude Code, Node, `gh`, and every other tool, runs *inside* hooop's containers, so your machine stays clean. If you can run `docker`, you can run hooop. (You do **not** need Claude Code, or even Node, installed on your machine.)

> **New to Docker?** Install **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (macOS / Windows), or on Linux, your distro's Docker Engine with Compose v2. Launch it, then run `docker run hello-world` to check it works.
>
> **Install `jq`** (a small JSON tool the setup step needs):
> - macOS: `brew install jq`
> - Debian / Ubuntu: `sudo apt-get install -y jq`
> - Fedora / RHEL: `sudo dnf install -y jq`
> - Windows: `winget install jqlang.jq` (or `choco install jq`)
>
> Check it worked: `jq --version`.
>
> You'll also want **git** (to download hooop) and a **Claude account** on a paid plan (Pro / Max / Team / Enterprise) to sign in with.

### Install in one line

```bash
git clone https://github.com/bruno-de-queiroz/hooop && cd hooop && ./plugins/hooop/cli/hooop.sh install
```

That one command clones hooop, adds the `hooop` command to your shell, and runs setup for you. The **first** run also builds the sandbox image (a few minutes, so grab a coffee), installs the default toolset, then walks you through signing in.

**The only parts that need you** (everything else is automatic):

1. **Sign in to Claude.** hooop drops you into a `claude` prompt. Type `/login`, open the URL it prints, approve it in your browser, paste the code back, then type `/exit`. hooop uses its **own** Claude account here, your personal Claude Code login is never read or touched. (A web browser is all you need, and it doesn't have to be on the same machine, which is handy for remote servers.)
2. **Sign in to GitHub.** A one-time code appears with a URL. Open it and paste the code.

When it's done, open **[http://localhost:7842/](http://localhost:7842/)** in your browser. hooop recognizes your own machine automatically, so there's nothing to paste. (Remote access is locked down on purpose, see [Architecture](#architecture).)

> **Want to choose each tool yourself?** Run the guided menu instead:
> ```bash
> ./plugins/hooop/cli/hooop.sh install --wizard
> ```

**Installed by default, no questions asked:**

| Tool | What it does for you |
|---|---|
| **claude-mem** | Remembers context across sessions |
| **Serena** | Code-graph search, for engineering work |
| **Context7** | Fetches up-to-date docs for libraries & frameworks |
| **Docker Model Runner** | Local semantic search (falls back to keyword search if unavailable) |
| **GitHub CLI** | Access to your repos, PRs, and issues |
| **Telemetry isolation** | Blocks the bundled tools' analytics traffic |

### Everyday commands

- **Add or change one piece:** `hooop setup <section>`, e.g. `hooop setup mcps` to add integrations like Jira or Slack, or `hooop setup observability` for Sentry/Datadog. Sections: `code-graph`, `automation`, `mcps`, `rag`, `model-runner`, `telemetry`, `observability`, `design`, `second-brain`, `memory`.
- **Just a terminal, no dashboard?** `hooop open` runs `claude` in a throwaway sandbox over your current folder.
- **Update to the latest:** `git pull`, then `hooop rebuild`.
- **Switch Claude accounts:** `hooop logout`, then `hooop login`.
- **Remove everything:** `hooop uninstall` wipes the whole stack (containers, images, credentials, settings) and removes the `hooop` command. Your personal `~/.claude` and the cloned repo stay untouched.

Stuck? Run **`hooop doctor`** any time. It checks your setup and tells you what's missing.

<details>
<summary><strong>Optional host tools</strong> (hooop runs fine without them)</summary>

<br>

- **curl**: used to probe Docker Model Runner. Falls back to a built-in bash probe if it's missing.
- **awk**: only needed by `hooop mount`.
- **Docker Model Runner** (needs Docker Compose **v2.38+**): powers local semantic search. If it isn't available, hooop falls back to keyword (BM25) search automatically, so nothing breaks. Ollama, OpenAI, or any OpenAI-compatible endpoint work too (pick them in `hooop setup --wizard`).
</details>

<details>
<summary><strong>Already running Claude Code?</strong> You can install hooop as a plugin instead</summary>

<br>

```text
/plugin marketplace add bruno-de-queiroz/hooop
/plugin install hooop@hooop-marketplace
/plugin list
/reload-plugins
/hooop:setup
```

(The `/plugin list` + `/reload-plugins` step is only needed on Claude Code v2.1.138, to activate a freshly pre-seeded plugin in the current session. New sessions don't need it.) `/hooop:setup` just points you back to the `hooop setup` command above. The stack itself always runs in containers either way.
</details>

## What the wizard does

`hooop setup --wizard` (or `/hooop:setup`, which points you to it) walks you through these steps with one consent at the top, then installs each pick. Auto-runnable and secret-taking MCPs run immediately, with every command printed first. Browser-login, plugin-marketplace, and host-CLI options are printed as guided steps for you to finish yourself. (Plain `hooop setup` skips the menus and installs the default stack. `hooop setup <section>` runs just the layers you name.)

| # | Step | Pick |
|---|---|---|
| 1 | Consent | Y / N |
| 2 | Detect prior state | (read-only) |
| 3 | Memory | claude-mem (installed automatically, no choice) |
| 4 | Code-graph RAG (if you code) | Serena / claude-context / code-graph-mcp / Cognee / skip |
| 5 | Automation | n8n-mcp yes / no |
| 6 | Platform MCPs | multi-select: Atlassian, Google Workspace, GitHub, incident.io, Slack |
| 7 | Docs RAG | Context7 yes / no |
| 8 | Observability | Sentry / Datadog (multi-select) |
| 9 | Design | Excalidraw yes / no |
| 10 | Second-brain | Obsidian (3 flavors) / Notion (2) / Logseq / NotebookLM |
| 11 | Sign-ins | Claude Code `/login`, then gh (device flow) + any queued MCP OAuth, all inside the sandbox |

Each run appends to the sandbox profile's `~/.claude/hooop/sandbox/profile/.claude/hooop/install-log.md` (also viewable from the dashboard), so re-runs are auditable. Secrets never reach the log. They go straight to `claude mcp add -e` or the 0600 `~/.claude/hooop/hooop.env`.

## Dashboard

`hooop start` (plus `stop | restart | rebuild | status | logs`, or `/hooop:dashboard` from inside Claude Code) runs the dashboard **inside a container**. Your host only needs Docker: no Node, no `npm install`, no Next.js build mess. Each verb takes an optional service target (`all` by default, `sandbox`, `dashboard`, or `preview`). `start` builds lazily, only when an image is missing. `rebuild` always rebuilds.

Pairing (inviting a teammate to co-drive a session) uses **`cloudflared`** to expose the local dashboard over a public tunnel. It's **baked into the dashboard image**, so there's nothing to install on the host. The dashboard runs fine without pairing. Only share links start a tunnel.

The dashboard has these panels:

- **Sessions**: watches `~/.claude/sessions/` and updates in real time.
- **Skills**: every skill on disk (user + plugin), filterable, with a one-click "Run" that starts a real session using the skill's invocation as its first turn. It behaves like any other session (same transcript, `/stop`, permission gate, pairing), just badged with the skill that triggered it.
- **Sub-agents**: a tree rebuilt from PreToolUse/PostToolUse events on the `Agent` tool. Click a node to see its prompt, tool calls, and final output.
- **Files**: a docked diff viewer for files the agent has touched, unified diffs with hunk navigation, markdown preview, and click-to-insert `#path:line` references into the composer. A small "N files affected, Review" pill shows up above the composer when there's something to look at.
- **Events**: a live tail over Server-Sent Events. Hooks push each event to the sandbox's `/ingest` endpoint over a Unix domain socket. No polling.
- **Preview**: a docked panel showing a running app in an iframe, its spec, per-step logs, and Restart / Rebuild / Stop / Share. Shows up on its own when the agent brings a preview up. See [Live previews](#live-previews).
- **Search**: opens with ⌘K. Keyword search (BM25/FTS5) always works. Semantic search (sqlite-vec) turns on once you configure an embedding backend via `hooop setup`. Docker Model Runner is the easy default; Ollama, OpenAI, or any OpenAI-compatible endpoint are alternatives. Hybrid mode blends both.

The composer itself packs a few extra behaviors. `/stop` aborts the running turn, `/model <alias>` switches the session's model, and `/auto-mode [on|off]` toggles unattended approval for routine tools, git and anything destructive always still stops for a human. You can attach images (paste or file picker) and pull files into the message with `#name` autocomplete. The sandbox translates those to claude's own `@` syntax on the way to the model, so `@` stays free for people.

When the agent asks a clarifying question (`AskUserQuestion`), it shows up as an inline card with the choices as buttons, plus a free-text "Other" option, right above the composer. Peers who are just spectating see it read-only.

The dashboard is single-user and localhost-only by design. Access is gated by a per-install token (see [Architecture](#architecture) below).

## CLI (`hooop`)

`plugins/hooop/cli/` ships a small [oosh](https://github.com/bruno-de-queiroz/oosh)-based CLI that wraps the runtime. It lives **inside the plugin** (engine, entry point, completions, and the stack engine in `lib/stack.sh`), so it ships with the plugin and the slash commands (`/hooop:setup`, `/hooop:dashboard`) can call it directly. Nothing to install separately.

```bash
./plugins/hooop/cli/hooop.sh install     # symlink `hooop` onto PATH + shell completion (bash/zsh)
# or run in place without installing:
./plugins/hooop/cli/hooop.sh <module> <command>
```

Two levels: **top-level verbs** act on the whole stack, **modules** scope a single service. All of them drive one engine (`cli/lib/stack.sh`), the single source of truth for host-side setup (profile prep, auth tokens, compose orchestration). `start`/`rebuild` are deliberately split: `start` only builds an image when it's missing, `rebuild` always rebuilds so you pick up code changes.

| Command | What it does |
|---|---|
| `hooop start` · `stop` · `restart` · `rebuild` · `status` · `logs` | Controls the whole stack (`agent-sandbox` + `dashboard`). `rebuild` takes `-n\|--no-cache`. |
| `hooop login` · `logout` | Authenticate the sandbox with its **own** Claude account. `login` drops you into `claude` to run `/login`. `logout` clears it so you can sign in as someone else. Your host credentials are never touched. |

| Module | Commands | What it does |
|---|---|---|
| `dashboard` | `start` · `stop` · `restart` · `rebuild` · `status` · `logs` | Controls only the dashboard container, leaves `agent-sandbox` alone. |
| `sandbox` | `start` · `stop` · `restart` · `rebuild` · `update` | Controls only the `agent-sandbox` container. `update` pins the baked-in `claude-code` version. |
| `open` | *(default)* | Runs a throwaway, telemetry-isolated sandbox over the current folder and launches `claude` in it. Use `-T\|--telemetry` to allow bundled-tool telemetry. Extra args pass through, e.g. `hooop open --model opus`. |
| `add` | `mcp` · `plugin` · `skill` | Installs a component into the sandbox profile, so it persists across rebuilds and is shared by the dashboard **and** `hooop open`. `mcp <name> [flags] [-- <cmd>]`, `plugin <plugin[@marketplace]>`, `skill -d <dir>` copies a local skill (needs a `SKILL.md`). |
| `mount` | `add` · `list` · `remove` | Bind-mounts a host folder into the sandbox workspace at `/home/agent/workspace/<name>`. Recreates the sandbox container each time. |
| `install` | *(default)* | The one-liner: symlinks `hooop` onto PATH, wires shell completion, then runs `hooop setup` (add `--wizard` for the full menu). Never touches the repo itself. |
| `uninstall` | *(default)* | The inverse of `install`: purges the whole stack (containers, images, credentials, tokens, caches), then removes the `hooop` symlink. `-y\|--yes` skips the confirm. Your host `~/.claude` and the repo are untouched. |
| `setup` | *(default)* | Configures the sandbox stack, the native version of `/hooop:setup`. Bare `hooop setup` installs the default stack, `--wizard` runs the full menu, `hooop setup <section>…` runs just the named layers. `--reset-first` wipes all sandbox state first. |
| `doctor` | *(default)* | Read-only health check: Docker/Compose version, which optional host tools are present, sandbox image/container state, Claude auth, and the semantic-search backend. Only fails on real blockers. |

```bash
hooop start                    # bring up the whole stack at http://localhost:7842/
hooop setup                    # install the default stack (add --wizard for menus, or name sections)
hooop login                    # one-time: authenticate the sandbox with its own Claude account
hooop dashboard rebuild        # rebuild + recreate ONLY the dashboard container
hooop sandbox rebuild          # rebuild + recreate ONLY the agent-sandbox container
hooop open                     # interactive claude in a sandbox over $PWD
hooop add mcp context7 -- npx -y @upstash/context7-mcp   # install an MCP (user scope) into the sandbox
hooop add skill -d ~/.claude/skills/impeccable           # copy a local skill into the sandbox profile
hooop mount add -p ~/code/myproject                      # expose a host folder to the sandbox workspace
```

`add` and `mount` are also available as the **`/hooop:add`** and **`/hooop:mount`** slash commands. Everything `add` writes lives in `~/.claude/hooop/sandbox/profile`, so a component installed once is there in every dashboard session and in `hooop open`, and survives rebuilds.

**Live-editing the dashboard UI (`HOOOP_DASHBOARD_DEV=1`).** Normally the dashboard is a baked production image, so a UI change needs `hooop dashboard rebuild`. Set `HOOOP_DASHBOARD_DEV=1` to build a dev image instead, with `next dev` (webpack HMR) and live file watching, so edits reload without a rebuild. First switch needs one `HOOOP_DASHBOARD_DEV=1 hooop dashboard rebuild`, then `restart` is enough. It's a dev convenience: share tunnels aren't available in dev mode, since that image skips `cloudflared`. `HOOOP_PLUGIN_DEV=1` does the same live-overlay trick for the sandbox's plugin source.

`hooop open` mounts the sandbox's Claude profile (`~/.claude/hooop/sandbox/profile`, override with `-p\|--profile`), so `claude` is already signed in. Run `hooop login` once first. It's a clean, isolated session (telemetry off, no dashboard hooks) that still has your setup MCPs and skills. `hooop install` / `hooop uninstall` manage the PATH symlink; the repo itself is never modified.

### Browser automation

The `hooop-sandbox` image ships a **headless Chromium** with the official [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp), registered automatically. The agent gets `browser_navigate`, `browser_click`, `browser_type`, `browser_snapshot`, `browser_take_screenshot`, and more, all running **entirely in-container** as the unprivileged `agent` user. No host browser, no host process, nothing runs under *your* user. Because the same image and profile back both surfaces, browser tools work in every dashboard session **and** in `hooop open`.

Two deliberate hardening choices:

- **Ephemeral profile.** The browser profile lives in memory and is never written to disk, so no cookies or logins persist across sessions. To drive a site that needs login, hand the browser tools a `--storage-state` file (see the [`@playwright/mcp` docs](https://github.com/microsoft/playwright-mcp#user-profile)).
- **No arbitrary-code tool.** `@playwright/mcp`'s `browser_run_code_unsafe` (arbitrary JavaScript, effectively RCE) is denied via Claude's own `permissions.deny`, so the model never even sees it.

## Session lifecycle

A session that goes quiet goes **dormant**: the sandbox kills its `claude` subprocess, and the next turn you send revives it with `claude --resume`. Nothing is lost. The transcript, the model, auto mode, and the working directory all come back. Dormant sessions stay in the sidebar with a moon avatar and a `resume` hint.

The install-wide window is **30 minutes**, tunable with `HOOOP_SESSION_IDLE_TTL_MS`. Setting it to `0` disables idle dormancy for every session that does not set its own window (see below). Going dormant also releases the session's [live preview](#live-previews) so its slot returns to the pool, and after a much longer grace period (4 hours, `HOOOP_SESSION_SHARE_GRACE_MS`) it revokes the session's share links, because revoking is permanent and a lunch break should not cost you a pairing.

**Per-session window.** The "goes dormant after" field on the new-session form overrides the default for one session: 5 minutes, 30 minutes, 2 hours, or never. Pick `never` and that session keeps its subprocess for as long as the sandbox runs. The header shows a quiet `sleeps after 5m` chip whenever a session differs from the install default.

**Burn after use.** Tick the box on the new-session form and the session **deletes itself instead of going dormant**: transcript, private workspace, search-DB events, share links, and any running preview. Use it for a throwaway session you would rather not leave on disk.

|  | what happens |
|---|---|
| its idle window elapses | burns |
| it is ended explicitly (the `POST /sessions/:id/end` API) | burns |
| the sandbox restarts | burns on the way back up, so the teardown can finish |
| the agent's process crashes | **kept**, so you can read what went wrong. The next restart takes it |

Deleting a session from the sidebar removes all of the same things for *any* session, burn or not. Burn is about what happens when you walk away and forget.

Three things worth knowing before you use it:

- **It can only be armed when the session is created.** The header's flame pill has an ✕ to cancel a burn, and cancelling is permanent: nothing in the UI or the API can re-arm it, so you would have to start a fresh session.
- **Peers lose it too.** Burning revokes the session's share links, and there is no session left to re-share.
- **`never` plus burn is allowed.** That session only burns when you end it or when the sandbox restarts, never from sitting idle.

Burn rows carry a **flame avatar** in the sessions rail so a self-deleting session is obvious from the list.

## Pairing & plan review

`/hooop:dashboard` can hand a **share link** to a teammate over a `cloudflared` tunnel. They open it, pick a name, and the host admits them. From that point both sides see the same live transcript and can chat (`>` prefix) or co-drive the model, from a laptop or a phone.

Peers get one of three capability levels when admitted: **full** (can act like the host, including admitting other peers), **drive** (can act, but not admit anyone), or **spectate** (read-only). A pending join shows up as an admit/deny toast for the host or any full-capability peer.

**The dangerous ones are always yours.** This covers the `!bash` fast lane too: a guest typing `!rm -rf build` raises a card for you rather than running, and `git push` is refused outright. Whatever a share says, a guest can never approve a tool call in the **critical set**: any `git` command, a destructive shell command (`rm -rf`, `mkfs`, `dd of=`, a pipe from `curl` into a shell), anything reading secrets (`~/.ssh`, `.env`, credentials), a write by an MCP server that reaches outside this machine (Gmail, Drive, a tracker), a path outside the session's own folder, or publishing a preview to the public. Those wait for **you**, and a full-access peer sees the same "waiting for the host" card a spectator does. `/auto-mode` does not change it, an approved plan does not change it, and "allow all from this peer" does not change it — the critical set is excluded from every unattended approval by construction, and only the host can grant that standing trust in the first place.

An MCP server that runs **inside** the sandbox (Serena, claude-mem — anything stdio) is treated like the built-in tools: editing a file inside the session folder is routine either way. Only servers that act on the outside world are always yours.

Each session also gets a scratch directory at `/tmp/hooop-session/<id>` that counts as inside its boundary, and the agent is told to use it for screenshots and throwaway scripts. Measured on a real session: that alone removes about 40% of the approval prompts, which were the agent writing to `/tmp` and reading its own output back. It isolates the model's file tools, not Bash: Landlock gives a session all of `/tmp` read-write, so a shell command can still reach another session's scratch, and real isolation there would need separate uids or a per-session tmpfs. The session creates the directory itself (the server runs as a different user and only prepares the writable, sticky parent), and the allowance only applies while a plain directory is actually sitting at that path — `/tmp` is shared by every session in the install, so a symlink planted at the name would otherwise redirect a session's own "contained" reads anywhere on disk. If that check fails the session just loses the allowance and goes back to prompting.

This is livable because of devices: the prompt reaches your phone, so a paired session no longer stalls the moment you walk away from your laptop.

### Your own second screen

A share link invites **somebody else** in as a guest. To get hooop on **your own** phone, use **Your devices** in the share dialog instead: it shows a QR that is good for two minutes and can be scanned once. The device that scans it acts as **you** — same sessions, your name on your messages, no admit prompt, nothing marked as a guest joining.

That is host authority on a public URL, so it is fenced in:

- the code can only be minted by the host, expires in **2 minutes**, and works **once**;
- the device gets its **own** revocable credential, never a copy of the install token, which does not leave the machine;
- every device is bound to the current tunnel hostname, so all of them drop when the tunnel stops (a new tunnel means a new QR);
- **Revoke** cuts a device instantly, including its live transcript feed and any preview it has open. Revoking the device you are holding signs it out.

Peers can move devices too, without a new link. **Continue on another device** in the shared-session panel re-shows their existing link as a QR, so the second screen is the same guest with the same name, handle and access level. The host is still asked to admit them, as always.

Either way there is still **one row per person** in the roster. Two screens make you `typing` if you are typing on either, `away` only once both are idle, and never a second participant.

Run a turn with `/plan <task>` and the sandbox forces the agent **read-only**: it investigates, then submits a plan that opens in a **review panel**. The host and any full-capability peer can drop **inline comments** anchored to the exact passage, synced live for everyone, then **Approve** or **Request changes**. A rejection feeds the comments back and the agent revises the plan.

## Live previews

When the agent builds something with a UI, it can bring it up and hand you a URL. `start_preview` takes a **spec shaped like a Dockerfile**. The agent derives it from your repo (README, lockfiles, `Makefile`, `Procfile`, `pyproject.toml`, `Cargo.toml`, `go.mod`), and hooop passes the commands to a shell **verbatim**:

| Dockerfile | spec field |
|---|---|
| `WORKDIR` | `workdir`, relative to the session's workspace |
| `ENV` | `env` |
| `RUN` | `setup[]`, ordered, fail-fast, one captured log each |
| `EXPOSE` | *(hooop assigns the port, read `$PORT` or name your framework's variable in `port.env`)* |
| `CMD` | `run` |
| `HEALTHCHECK` | `readyPath` / `readyTimeoutSec` |

It runs in **its own container** (`preview-runner-1..3`): no `claude`, no Claude credentials, no `events.db`, no route to `agent-sandbox`. Three slots, each leased to one session at a time, so two sessions can each have one and a fourth is refused. Your app binds `127.0.0.1` however its framework likes; the runner owns the only `0.0.0.0` socket and forwards to it.

Two states, and only one of them touches the internet:

| | Reachable by | Approval |
|---|---|---|
| **running** | you, at `http://127.0.0.1:785n` | none, nothing left your machine |
| **shared** | you **and everyone in that session** | a permission card, every time |

Sharing publishes agent-written code to a `cloudflared` URL, so it's in the **critical set**: auto mode, an approved plan, and a trusted peer all still stop for a human. Access follows the session's share; revoke a peer and their preview dies within ~5s. A peer who joins later just gets the link, no re-approval needed.

Host or a full-access peer can **Restart** (respawn the run command), **Rebuild** (re-run every setup step, then respawn), or **Stop**. `drive`/`spectate` peers can watch. There's **no file watcher**, so Rebuild/Restart is how you get a change on screen if your framework doesn't hot-reload on its own.

Two things worth knowing:

- **Every lease starts cold.** Nothing is cached across sessions, so a preview redownloads its packages. What lives in the project tree (`node_modules`, `.venv`, `target/`) is in your workspace and does survive.
- **Previews only see the session's own workspace.** A `hooop mount`ed folder is mounted inside the sandbox only, so the runner can't see it. hooop refuses with an explanation rather than serving an empty directory; clone or copy the project into the session first.

The runner bakes in node + corepack (pnpm/yarn) + bun + python3 + uv + git + `mise`. Setup steps run unprivileged, so `apt-get install` won't work. Use `mise` (it reads your repo's own `.tool-versions` / `.nvmrc` / `.python-version`), `uv`, or `pip --user`.

## Architecture

The runtime is split across **two trust levels**, so a compromise of the web layer can't reach your credentials:

- **`agent-sandbox`** (trusted): owns the `claude` binary, your Claude profile (OAuth credentials, plugins, MCP config, sessions/transcripts), the long-lived `claude` subprocesses, and `events.db` (sole writer). It exposes a small HTTP API over a **Unix domain socket**, no TCP port. The model runs as an unprivileged `agent` user. The plugin surface it actually uses (hook scripts, the `.mcp.json` tools server, the plugin manifest) is **baked into the image** and root-owned, so that user can't tamper with it. Host-only pieces aren't baked in: `commands/` and `agents/` don't mean anything inside the sandbox, and `catalog/`/`templates/` are only read by `hooop setup` on the host. The image is self-contained, no host repo bind-mount, so it runs on a host without the repo or Claude Code installed. (Set `HOOOP_PLUGIN_DEV=1` to overlay the full host repo back onto the image for live plugin development.)
- **`dashboard`** (untrusted view): Next.js bound to `127.0.0.1:7842`, with **no `claude` binary and no access to `~/.claude`**. Every API route is a thin proxy that calls the sandbox over the socket, so a compromised dashboard can only do what the sandbox API allows. It also serves ports `7850-7852` and is the only door to a live preview.
- **`preview-runner-1..3`** (least trusted): one leased per previewing session. Mounts only the workspace, holds no credentials, has no control socket, and sits on its own network that `agent-sandbox` isn't on. Filesystem isolation between sessions inside a runner is enforced by Landlock. A released lease wipes its scratch space and exits. Docker's restart policy brings the container back clean.

`events.db` stays the source of truth: the sandbox writes it, the dashboard only reads it over the socket. Three tokens gate the three hops:

| Token | Hop | Header |
|---|---|---|
| `dashboard.token` | browser ↔ dashboard | `x-dashboard-token` (+ cookie) |
| `sandbox.token` | dashboard ↔ sandbox | `x-sandbox-token` |
| `hook.token` | hook scripts ↔ sandbox `/ingest` | `x-hook-token` |

This is the "sandboxed agent" model: the OS-process boundary is the security boundary, and the dashboard holds no secrets. The `/auto-mode` toggle only relaxes approval for routine, non-destructive tools; git and anything destructive always requires a human, no matter what mode is on. Pairing layers on top of all this via `cloudflared` and per-peer share tokens.

## State written by the plugin

```
~/.claude/hooop/
  hooop.env                    opt-in overrides forwarded into the sandbox (0600):
                              OPENAI_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL /
                              EMBED_DIM / telemetry switches
  host-gateway.cache          cached host.docker.internal address
  sandbox/profile/            the sandbox's Claude HOME (bind-mounted to /home/agent)
    .claude/
      .credentials.json       the sandbox's OWN Claude OAuth token (never the host's)
      hooop/
        events.db             SQLite (FTS5 + sqlite-vec); the dashboard reads it over the socket
        events.jsonl          append-only event audit log + replay buffer if the dashboard is down
        shares.json           active pairing share links (cleared on every start)
        host-devices.json     your own enrolled devices (cleared on every start)
        install-log.md        audit trail of every `hooop setup` run
        profile.md            identity + installed-stack summary written by the wizard
~/.local/share/hooop/          per-install secrets: dashboard.token, peer-signing.secret (0600)
```

Because the sandbox's HOME is bind-mounted from `sandbox/profile/`, everything the container writes to its own `~/.claude/hooop/` lands under that nested path on the host. The agent owns all runtime state; the dashboard only reads it over the socket.

The plugin does **not** edit your `~/.claude/CLAUDE.md` or `~/.claude/settings.json`.

## Repo structure

```
hooop/
  .claude-plugin/marketplace.json        self-hosted marketplace
  plugins/hooop/
    .claude-plugin/plugin.json           manifest
    commands/                            /hooop:setup, /hooop:dashboard, /hooop:plan, /hooop:add, /hooop:mount
    catalog/                             8 install recipes (one per wizard layer)
    hooks/scripts/                       emit-event.sh (Unix-socket push, <50ms) + permission-gate.sh
    preview-runner/                      least-privileged runtime for live previews
      Dockerfile                         node+bun+uv+mise+git; no claude, no credentials
      server.ts                          per-slot supervisor on a UDS (lease/start/rebuild/…)
      lib/supervisor.ts                  spec execution, Landlock wrap, port forwarder
    sandbox/                             trusted agent runtime (owns claude + all state)
      Dockerfile                         sandbox image (claude + Node HTTP server on a UDS)
      server.ts                          HTTP-over-Unix-socket API the dashboard proxies to
      lib/                               active-sessions, db, ingestor, embeddings, sessions,
                                         skills, agents, search, shares, peer-joins, …
    dashboard/                           untrusted view (no claude, no credentials)
      Dockerfile                         dashboard image (Next.js standalone; no claude, no compilers)
      docker-compose.yml                 agent-sandbox + dashboard services (+ optional DMR embedding model via Compose `models:`)
      app/api/*                          proxy routes → sandbox over the socket
      lib/sandbox-client/                HTTP-over-UDS client; lib/auth*, lib/peer-*  (auth + pairing)
    shared/                              logger, clamp, shutdown (used by both images)
    templates/                           profile.md + install-log.md wizard templates (read host-side)
    cli/                                 oosh-based `hooop` CLI (ships inside the plugin)
      oo.sh                              oosh framework engine
      hooop.sh                            entry point (+ hooop.comp.sh / hooop.zcomp.sh)
      lib/stack.sh                       the two-service runtime engine (preflight + compose)
      modules/                           dashboard, sandbox, open, login, logout, add, mount, setup, doctor, install, uninstall
  README.md
  LICENSE
```

## Hooks pipeline

The sandbox seeds its **own** profile on boot (`sandbox/seed-profile.mjs`, run by the container entrypoint using the image's baked Node, no host `jq` needed). It wires `settings.json` hooks on PreToolUse, PostToolUse, SessionStart, Stop, and UserPromptSubmit, all declared in the sandbox profile (not a host `hooks.json`), so they only ever run inside the sandbox, never on your host. Every event runs `hooks/scripts/emit-event.sh`, which:

1. POSTs the JSON event to the sandbox's `/ingest` endpoint over the Unix domain socket, via `curl --max-time 1`. Push, not polling. (`HOOOP_INGEST_URL` can override the target for legacy/dev setups.)
2. Falls back to appending to `events.jsonl` if the socket isn't reachable.
3. Exits in under 50ms: pure bash + curl, no node/python/jq.

The sandbox is the sole writer: its ingest route saves to SQLite + FTS5 (and sqlite-vec if semantic search is on), then emits on an in-process EventEmitter that feeds the SSE stream the dashboard proxies to the browser. On startup, the ingestor drains `events.jsonl` from its saved offset, so events written while the dashboard was down replay automatically.

`hooks/scripts/permission-gate.sh` (PreToolUse) is the sole tool-permission gate: it asks the sandbox over the same socket and blocks until the host (or a peer allowed to decide) responds. This is what backs `/plan`'s read-only enforcement, the plan-review approval flow above, and the `/auto-mode` toggle's exceptions for git and destructive commands.

## Roadmap

- **v0.1** (this release): wizard, containerized dashboard, push-based event pipeline, BM25 + opt-in semantic search.
- **v0.2**: inject skill triggers into existing Claude sessions instead of spawning new ones; per-skill-run isolation via ephemeral containers.
- **v0.3+**: more catalog entries; non-Claude clients (Cursor, Codex) where MCPs overlap.

## Contributing

This is opinionated by design. PRs welcome, especially:

- Verifying install commands on less-common platforms (Windows, NixOS).
- Adding new catalog options with verified install recipes.

Please open an issue before changing the curation philosophy (curated menus, one-consent install, no re-implementation, single-user localhost dashboard).

## License

MIT
