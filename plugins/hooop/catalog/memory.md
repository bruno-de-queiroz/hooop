# Catalog: memory backend

`hooop setup` installs **claude-mem** unconditionally — there is no menu.
It is the only supported memory backend because it is the sole store the
dashboard Summary rail reads: `~/.claude-mem/claude-mem.db` (tables
`session_summaries` + `sdk_sessions`). Other keepers (Mem0, mcp-memory-service,
MemPalace) do not feed the dashboard, so they are intentionally not offered.

---

## claude-mem

**One-line pitch:** Local, automatic session capture with AI compression. The
most popular Claude Code memory plugin in 2026, and what powers hooop's dashboard
session summaries (Request / Investigated / Learned / Completed / Next steps).

**Prereqs:** Node.js / npm — baked into the sandbox image, so nothing to install
on the host.

**Install (auto-runnable, in the sandbox):**
```bash
npx -y claude-mem install
```

The wizard runs this for you and is idempotent — it skips when `~/.claude-mem`
already exists in the sandbox profile.

**Why `npx claude-mem install` and not the marketplace plugin:** this path
registers the plugin hooks AND sets up the background worker service that writes
`session_summaries`. The `/plugin install` path registers the plugin only; the
worker setup is separate, and without the worker the dashboard summary stays
empty.

**Verify (inside the sandbox — `hooop open`):**
```bash
ls ~/.claude-mem/claude-mem.db
claude mcp list  # (claude-mem is hook-based, not an MCP; DB presence is the signal)
```

**Notes:** Summaries are produced asynchronously by claude-mem's worker after a
turn completes, so the dashboard's Summary rail fills in a moment after the
first completed turn. All data stays local under `~/.claude-mem/`.
