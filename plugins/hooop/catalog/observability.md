# Catalog: observability

Read by `/hooop:setup`. Multi-select category. Default Sentry only if the user does engineering work; user can add Datadog.

---

## Option: Sentry

**One-line pitch:** Query Sentry issues, events, traces, and performance data from Claude. Includes a subagent that auto-delegates Sentry questions.

**Prereqs:** A Sentry account. Either organization access (for hosted Sentry) or self-hosted credentials.

**Install path A (recommended): Sentry plugin via Claude Code plugin marketplace**
```
/plugin marketplace add getsentry/sentry-mcp
/plugin install sentry-mcp@sentry-mcp
```

This installs the MCP server AND a subagent that Claude auto-delegates to for Sentry questions. Setup prints these as user-typed slash commands and waits for "done".

**Install path B (cloud transport, no plugin, OAuth flow):**
```bash
claude mcp add --scope user sentry --transport http https://mcp.sentry.dev/mcp
```

`hooop setup` authenticates it at the end via `claude mcp login sentry --no-browser` (open the printed URL, approve, paste the redirect URL back) — no deferring to first tool use.

**Install path C (self-hosted via stdio):**
```bash
claude mcp add --scope user sentry -- npx -y @sentry/mcp-server
```

The wizard offers path A by default; user can choose B or C from the menu if they prefer.

**Verify:**
```bash
claude mcp list | grep sentry
```

---

## Option: Datadog

**One-line pitch:** Query Datadog metrics, logs, and monitors from Claude.

**Prereqs:** Datadog account with an API key and (depending on the MCP package) an Application key. Set these as env vars before install:
```bash
export DD_API_KEY="..."
export DD_APP_KEY="..."
export DD_SITE="datadoghq.com"   # or "datadoghq.eu" / etc.
```

**Install (auto-runnable, community MCP):**
```bash
claude mcp add --scope user datadog \
  -e DD_API_KEY="$DD_API_KEY" \
  -e DD_APP_KEY="$DD_APP_KEY" \
  -e DD_SITE="$DD_SITE" \
  -- npx -y @datadog/mcp-server@latest
```

The exact npm package name has shifted; if the above fails, try `npx -y datadog-mcp-server` or `npx -y @ddog/mcp-server`. Setup tries each in order.

**Verify:**
```bash
claude mcp list | grep datadog
```

**Notes:** As of 2026 Q2 there's no first-party Datadog MCP from Datadog itself; community packages are common. Verify the package's GitHub source before installing.

---

## Option: Skip

No observability tooling. You can always add one later by re-running `/hooop:setup`.
