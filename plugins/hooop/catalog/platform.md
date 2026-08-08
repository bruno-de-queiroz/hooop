# Catalog: platform MCPs (org-configurable)

Read by `/hooop:setup`. Multi-select category. Defaults all selected. Each tool is installed independently; failures stop the wizard with a fixable error message.

Tools:
- Atlassian (Jira + Confluence)
- Google Workspace CLI (`gws`)
- GitHub CLI (`gh`)
- incident.io
- Slack

---

## Option: Atlassian (Jira + Confluence)

**One-line pitch:** Atlassian Rovo remote MCP. Lets Claude search Jira and read/write Confluence directly.

**Install (auto-runnable):** it is a normal remote HTTP MCP — `claude mcp add` in the sandbox:

```bash
claude mcp add --scope user --transport http atlassian https://mcp.atlassian.com/v1/mcp
```

Endpoint choice matters: the legacy `/v1/sse` lost support after 30 June 2026, and `/v1/mcp/authv2` currently fails the Claude Code OAuth flow with "Invalid context provided" (anthropics/claude-code #69035). `/v1/mcp` with `--transport http` is the working endpoint.

**Authenticate (end of setup, in the sandbox):** OAuth 2.1. `hooop setup` runs `claude mcp login atlassian --no-browser` at the end — it prints an auth URL; open it in your browser, approve, and (since the localhost redirect can't reach the container) paste the address-bar redirect URL back at the prompt.

**Verify:** Ask Claude `Find my open Jira tickets`. A non-empty list means it's connected.

**Troubleshooting:**
- Login fails: use your org email; ensure your account has access to the Jira/Confluence sites.
- Jira Service Management / Bitbucket tools use an API token, not this OAuth flow.

---

## Option: Google Workspace CLI (`gws`)

**One-line pitch:** Email, calendar, Drive, Docs via the `gws` CLI from https://github.com/googleworkspace/cli.

**Install:** nothing to install — `@googleworkspace/cli` is baked into the sandbox image (`sandbox/Dockerfile`). The host stays docker-only.

**Auth model (why service-account, not `gws auth login`):** the current `gws` release (v0.22.x) only supports a localhost browser-callback OAuth flow — it starts a callback server on a *random* localhost port and blocks for the redirect. There is no `--no-browser`/device/paste flow and no way to pin the port (upstream issue #210). That callback can't round-trip to a headless container on Docker Desktop, so `hooop setup` wires a **GCP service-account key** instead (gws's documented headless path via `GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE`).

**Configure (auto-runnable):** the wizard prompts for a path to a service-account JSON key, copies it into the sandbox profile (`~/.claude/hooop/sandbox/profile/.config/gws/service-account.json`, mode 0600), and sets:

```bash
GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/agent/.config/gws/service-account.json
```

in `~/.claude/hooop/hooop.env`, which the launcher forwards into the sandbox (see `docker-compose.yml`). The baked `gws` reads the key on next start — no browser, no host install.

**Prerequisites for the key:** a GCP service account with **domain-wide delegation** enabled and the Workspace APIs/scopes you need (Gmail, Calendar, Drive, …) authorized for it in the Admin console. Create the key at https://console.cloud.google.com/iam-admin/serviceaccounts.

**Verify (in a sandbox session — `hooop open`):**
```bash
gws auth status              # expect: token_valid: true
gws calendar events list --params '{"calendarId": "primary", "maxResults": 3}'
```

**Important:** Claude Code may also surface a "Google Workspace MCP" server. **Do not connect it.** Always use the `gws` CLI.

---

## Option: GitHub CLI (`gh`)

**One-line pitch:** Repos, PRs, issues, CI status via the GitHub CLI authenticated to the user's GitHub account / org.

**Install:** nothing on the host — `gh` is baked into the sandbox image.

**Authenticate (sandbox device flow, at the end of setup):** `hooop setup` runs, inside the sandbox:

```bash
gh auth login --hostname github.com --git-protocol https --web
```

`gh`'s web flow is the OAuth **device** flow — it prints a one-time code and `https://github.com/login/device` (no localhost callback), so it completes headlessly. The code + URL appear in your setup terminal; open the URL in any browser, enter the code, approve. The token is stored in the mounted profile (`~/.config/gh`), so the host needs no `gh` at all.

**Legacy fallback (optional):** if you'd rather reuse an existing host `gh` login, set `HOOOP_GH_ACCOUNT=<user>` in `hooop.env`; the launcher forwards that account's token as `GH_TOKEN`. This requires host `gh` and is not used by default.

**Verify (in a sandbox session — `hooop open`):**
```bash
gh auth status
gh repo list <your-org> --limit 5
```

---

## Option: incident.io

**One-line pitch:** Query incidents, alerts, and on-call data from Claude.

**Install (auto-runnable):**
```bash
claude mcp add --scope user incident-io --transport http https://mcp.incident.io/mcp
```

**Authenticate (end of setup, in the sandbox):** `hooop setup` runs `claude mcp login incident-io --no-browser` at the end — open the printed URL, approve, paste the redirect URL back. No deferring to first tool use.

**Verify:**
```bash
/mcp                # in Claude Code; expect to see incident-io listed
```

---

## Option: Slack

**One-line pitch:** Claude reads channels, threads, and DMs; can post messages. Official Slack MCP.

**Install (auto-runnable):** hosted remote HTTP MCP — added in the sandbox:
```bash
claude mcp add --scope user --transport http slack https://slack.com/mcp
```

**Authenticate (end of setup, in the sandbox):** `hooop setup` runs `claude mcp login slack --no-browser` at the end — open the printed URL, approve, paste the redirect URL back.

**Verify:** Ask Claude `What's the latest in <a channel you're in>?` and confirm it can read.
