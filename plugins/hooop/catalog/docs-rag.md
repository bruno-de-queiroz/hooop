# Catalog: docs RAG

Read by `/hooop:setup`. Yes/no category. Default Yes when the user said they do engineering work; default No otherwise.

---

## Option: Context7 (Upstash)

**One-line pitch:** Live, version-specific documentation for thousands of open-source libraries injected into Claude's context. No more hallucinated API methods.

**When to pick:** You write code against external libraries (npm, PyPI, Maven, etc.) and want Claude to consult current docs instead of guessing from training data.

**Prereqs:** Node.js (for `npx`).

**Install (auto-runnable, no API key needed for the free tier):**
```bash
claude mcp add --scope user context7 -- npx -y @upstash/context7-mcp@latest
```

**Install with API key (higher rate limits):**
```bash
claude mcp add --scope user context7 -- npx -y @upstash/context7-mcp --api-key YOUR_API_KEY
```

Setup asks: "Provide a Context7 API key (free tier works without one)?" Multi-select between "Use free tier" and "Provide key" (prompts for value). Get a free key at https://context7.com/dashboard.

**Verify:**
```bash
claude mcp list | grep context7
```

**Notes:** Provides two tools: `resolve-library-id` (matches a library name to a Context7 identifier) and `query-docs` (returns scoped docs for a specific library + optional version). Mention the library version in your prompt for version-specific lookups.

---

## Option: Skip

No docs RAG installed. Claude falls back to web search and training-data knowledge of library APIs.
