# Catalog: design / whiteboard

Read by `/hooop:setup`. Yes/no category. Default No.

This catalog covers Excalidraw and any future open whiteboard MCPs.

---

## Option: Excalidraw

**One-line pitch:** Let Claude create, edit, and export Excalidraw diagrams programmatically. Useful for architecture docs and quick sketches in RFCs.

**Prereqs:** Node.js (for `npx`). No account needed (diagrams are local).

**Install (auto-runnable):**
```bash
claude mcp add --scope user excalidraw -- npx -y @cmd8/excalidraw-mcp
```

Alternative packages with the same surface area: `@scofieldfree/excalidraw-mcp`, `yctimlin/mcp_excalidraw`. The wizard uses `@cmd8/excalidraw-mcp` as the default (most-installed in late 2026); user can pick a different one from the menu.

**Verify:**
```bash
claude mcp list | grep excalidraw
```

**Notes:** Some packages support real-time canvas sync with an open Excalidraw browser tab; others are file-based. Read the package README after install to understand its mode.

---

## Option: Skip

No design / whiteboard MCP. You can always add one later by re-running `/hooop:setup`.
