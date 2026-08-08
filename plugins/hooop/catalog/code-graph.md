# Catalog: code-graph search

Read by `/hooop:setup` to populate the code-graph menu. Only shown if the user says they do engineering work in Claude sessions.

Menu items: Serena MCP, claude-context (Zilliz), code-graph-mcp, Cognee MCP, Skip.

## Language coverage matrix

| Language | Serena | claude-context | code-graph-mcp | Cognee |
|---|---|---|---|---|
| Scala | yes (Metals) | yes | no | partial |
| Java | yes | yes | yes | yes |
| JavaScript / Node | yes | yes | yes | yes |
| TypeScript | yes | yes | yes | yes |
| React (JSX / TSX) | yes (via TS/JS) | partial | yes | partial |
| Terraform / HCL | yes (terraform-ls) | no | no | no |
| Python | yes | yes | yes | yes |
| Go | yes | yes | yes | yes |
| Rust | yes | yes | yes | yes |
| C / C++ | yes | yes | yes | no |
| C# | yes | yes | yes | no |
| Kotlin | yes | yes | yes | partial |
| Swift | yes | yes | yes | partial |

## Recommendation logic (encoded in /hooop:setup)

- If user's language list includes **Scala or Terraform**: recommend **Serena**. Only option that covers both.
- If user's list is **Node/TS-only or web stack**: recommend **claude-context** (vector-backed, fast) or **code-graph-mcp** (lighter, no cloud).
- If user wants **AI-memory + code graph in one**: recommend **Cognee**.

The recommendation is shown next to the option in the menu, but the user picks freely.

---

## Option: Serena MCP (most polyglot, recommended for Scala or Terraform)

**One-line pitch:** Symbol-level semantic understanding across 40+ languages via Language Server Protocol.

**When to pick:** Polyglot stack. Especially needed for Scala (via Metals) or Terraform (via terraform-ls), which other tools don't cover.

**Prereqs:** `uv` package manager (`pip install uv` or `brew install uv`). Python 3.13.

**Install (auto-runnable, two steps):**
```bash
# 1. Install the Serena CLI (uv is baked into the sandbox image).
uv tool install -p 3.13 serena-agent
# 2. Register the launch command with Claude Code (user scope).
claude mcp add --scope user serena -- serena start-mcp-server --context claude-code --project-from-cwd
```

`hooop setup` runs both steps automatically inside the sandbox.

**Hooks:** hooop also wires Serena's own recommended Claude Code hooks (`serena-hooks activate`/`remind`/`cleanup`) automatically inside the sandbox, self-healing on every boot whenever the `serena-hooks` binary is present — no separate step needed. Serena's fourth hook, `auto-approve` (which would auto-approve `mcp__serena__*` tool calls), is deliberately never wired: `permission-gate.sh` remains the sole thing that can grant/approve a tool call in the sandbox (it backs `/plan`'s read-only enforcement and the pairing/plan-review flow), and auto-approve would let Serena calls bypass that gate.

**Important:** Serena's README warns against installing **Serena itself** via a plugin/marketplace entry (those snippets are outdated). It does **not** warn against `claude mcp add` — registering the `serena start-mcp-server` launch command as above is Serena's own documented Claude Code setup. Note the `--context claude-code` flag: the deprecated `--context ide-assistant` and the `uvx --from git+https://github.com/oraios/serena …` variant still work but are slower/older.

**Verify:**
```bash
which serena          # installed CLI on PATH
claude mcp list        # serena listed; also /mcp inside a session
```

**Notes:** First symbol indexing per project is slow. Subsequent queries are fast.

---

## Option: claude-context (Zilliz)

**One-line pitch:** Vector + AST hybrid semantic code search. Vendor-backed by Zilliz.

**When to pick:** Comfortable with cloud vector DB (Milvus on Zilliz Cloud) and OpenAI embeddings. Want vendor-supported tooling. No Terraform requirement.

**Prereqs:** OpenAI API key. Zilliz Cloud account with a Milvus instance (endpoint and API key). Node.js / npm.

**Install (auto-runnable):**
```bash
claude mcp add --scope user claude-context \
  -e OPENAI_API_KEY="sk-<YOUR_KEY>" \
  -e MILVUS_ADDRESS="<your-zilliz-cloud-endpoint>" \
  -e MILVUS_TOKEN="<your-zilliz-cloud-api-key>" \
  -- npx @zilliz/claude-context-mcp@latest
```

**Verify:**
```bash
claude mcp list | grep claude-context
```

**Notes:** Setup must prompt for three secrets. The cloud dependencies and OpenAI cost make this the heaviest option in this menu.

---

## Option: code-graph-mcp

**One-line pitch:** AST knowledge graph via tree-sitter + sqlite-vec hybrid search. No cloud dependencies.

**When to pick:** Want a local, self-contained code graph without external accounts. Stack doesn't include Scala or Terraform.

**Prereqs:** Node.js / npm.

**Install (auto-runnable):**
```bash
claude mcp add --scope user code-graph-mcp -- npx -y @sdsrs/code-graph
```

**Verify:**
```bash
claude mcp list | grep code-graph-mcp
```

**Notes:** Uses BM25 full-text plus vector embeddings with Reciprocal Rank Fusion. Indexes call graphs, imports, exports, and HTTP route bindings.

---

## Option: Cognee MCP

**One-line pitch:** Knowledge-graph memory that doubles as a code semantic layer.

**When to pick:** Want memory and code understanding from one tool. Comfortable with the cognee-cli.

**Prereqs:** Python with `uv`. A local checkout or `cognee-cli` installed.

**Install (manual config required):**
Add this block to `~/.claude/config.json` (the setup wizard prints it and waits for the user to confirm):

```json
{
  "mcpServers": {
    "cognee": {
      "command": "uv",
      "args": ["--directory", "/path/to/cognee-mcp", "run", "cognee-mcp"]
    }
  }
}
```

Alternative (cognee v0.3.5+):
```bash
cognee-cli -ui
```

**Verify:**
```bash
claude mcp list | grep cognee
```

**Notes:** Cognee doesn't ship a simple `claude mcp add` command. Setup must show the config block and wait for user confirmation.

---

## Option: Skip

No code-graph search installed. Claude will fall back to `Grep` / `Glob` / `Read` for code navigation, which is fine for small repos. Re-run `/hooop:setup` later to add one when the repo grows.
