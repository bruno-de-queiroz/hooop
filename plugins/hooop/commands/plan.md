---
description: Propose a plan for approval — the session goes hard read-only until you approve it
---

`/plan <task>` runs the current turn in **plan mode**. Unlike a normal turn, the
sandbox enforces this mechanically rather than by asking the model nicely:

- **Hard read-only.** While planning, the permission gate DENIES every mutating
  tool — Write, Edit, MultiEdit, NotebookEdit, Bash, subagents (Task), and MCP
  writes. Only read-only investigation (Read, Grep, Glob, ToolSearch, web
  search/fetch) is allowed. The agent physically cannot touch the repo.
- **Deterministic capture.** When the agent calls `ExitPlanMode` with its plan,
  the sandbox captures it and opens it for review — the tool is denied so the
  turn stops and holds.
- **Collaborative review.** The plan appears in the dashboard's plan panel. You
  and any co-driving peers can add inline comments/annotations, then approve or
  reject.
  - **Approve** → the session leaves read-only and runs a follow-up turn that
    implements the approved plan (normal permission gating resumes).
  - **Reject** (with feedback) → the session stays read-only and the agent
    revises the plan against your comments.

The task is forwarded to the model verbatim (just the `/plan` prefix stripped).
Steering to finish via `submit_plan` rather than prose lives in the session's
appended system prompt (`PLAN_SYSTEM_PROMPT` in `sandbox/lib/active-sessions.ts`,
passed via `--append-system-prompt`) — a standing rule that never appears in the
transcript and is inert outside plan mode. Enforcement is separate and does not
depend on the model cooperating: it lives in the sandbox permission policy + the
PreToolUse gate (`hooks/scripts/permission-gate.sh`), which holds the session
read-only and captures the plan deterministically.

Usage: `/plan add rate limiting to the login endpoint`
