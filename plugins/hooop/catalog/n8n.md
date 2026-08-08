# Catalog: n8n automation

Read by `/hooop:setup` to populate the n8n menu. Opt-in with default No.

Menu items: Yes (install n8n-mcp), No (skip).

---

## Option: n8n-mcp

**One-line pitch:** Build and manage n8n workflows from Claude. Generates, validates, and deploys workflow JSON.

**When to pick:** Run an n8n instance (cloud or self-hosted) and want Claude to author workflows for you. Or want the docs/validation tools even without a connected instance.

**Prereqs:** Node.js / npm. Optional but recommended: a running n8n instance, an API URL, and an API key. Without credentials, n8n-mcp runs in docs-only mode (no workflow management, no test executions).

### Install with full credentials (recommended)

**Install (auto-runnable):**
```bash
claude mcp add --scope user n8n-mcp \
  -e MCP_MODE=stdio \
  -e LOG_LEVEL=error \
  -e DISABLE_CONSOLE_OUTPUT=true \
  -e N8N_API_URL="<your-n8n-url>" \
  -e N8N_API_KEY="<your-api-key>" \
  -- npx n8n-mcp
```

For a local n8n: `N8N_API_URL=http://localhost:5678`.

### Install in docs-only mode (no credentials)

**Install (auto-runnable):**
```bash
claude mcp add --scope user n8n-mcp \
  -e MCP_MODE=stdio \
  -e LOG_LEVEL=error \
  -e DISABLE_CONSOLE_OUTPUT=true \
  -- npx n8n-mcp
```

Gives access to n8n documentation and workflow validation tools only. No deploy / no run.

**Verify:**
```bash
claude mcp list | grep n8n-mcp
```

**Notes:** Setup must ask:
1. "Install n8n-mcp?" (default No)
2. If yes: "Provide credentials, or use docs-only mode?" (radio)
3. If credentials: prompt for `N8N_API_URL` and `N8N_API_KEY`.

On native Windows PowerShell, replace the trailing backslashes with backticks in the install command.

---

## Option: No

n8n is heavy and only useful if the user actually runs an n8n instance. The setup wizard defaults to this option.
