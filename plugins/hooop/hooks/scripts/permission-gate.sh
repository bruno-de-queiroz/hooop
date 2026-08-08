#!/usr/bin/env bash
# permission-gate.sh — sole permission gate for the hooop sandbox.
#
# Context: claude is spawned with `--permission-mode bypassPermissions`,
# which disables Claude's built-in permission system entirely. This hook
# is therefore the only thing standing between the model and tool execution.
#
# Decisions:
#   - Known-safe read/inspection tools auto-allow without UI prompt.
#   - Write/Edit and anything else long-poll the dashboard for an
#     explicit user decision.
#   - On any failure (no sandbox, no token, timeout, malformed response)
#     the gate defaults to DENY — never pass-through, since pass-through
#     in bypassPermissions mode equals unconditional allow.
#
# Output protocol (stdout): Claude Code's hookSpecificOutput shape:
#   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
#                          "permissionDecision":"allow|deny",
#                          "permissionDecisionReason":"..."}}
#
# Exit code is always 0 — the decision flows through stdout JSON.

set -u

# Resolve helpers from system directories only. This hook runs UNCONFINED (it
# has to — it reads a token the model's Landlock profile denies), and it
# inherits claude's PATH, which leads with ~/.local/bin. If anything the model
# can write to is on that PATH, planting a fake `grep`/`sed`/`curl`/`node`
# turns the next tool call into unconfined code execution — a full escape from
# the Bash sandbox. The Landlock "dev" profile already refuses write access to
# ~/.local for exactly this reason; pinning PATH here is the second lock, and
# it also covers whatever ends up on PATH in future.
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH

STATE_DIR="$HOME/.claude/hooop"
# Next to the hook socket rather than in the profile — written by the server as
# hooopd, read here as `agent` via the shared `hooop` group. See lib/paths.ts for
# why the profile is the wrong home for a token on macOS.
HOOK_TOKEN_FILE="${HOOOP_HOOK_TOKEN_FILE:-/run/hooop-hooks/hook.token}"
SANDBOX_SOCKET="${HOOOP_SANDBOX_SOCKET:-/var/run/hooop/sandbox.sock}"
GATE_TIMEOUT="${HOOOP_PERMISSION_GATE_TIMEOUT_SECONDS:-120}"

# Tools allowed with NO round trip at all. Keep this list NARROW: anything that
# can write to disk, change config, hit the network with side effects, run a
# shell, drive the plan lifecycle, or NAME A FILESYSTEM PATH must route to the
# sandbox (/permission-ask) so the sandbox is the single policy authority.
#
# What's left here is exactly the set with nothing to check: ToolSearch reads
# deferred tool schemas, TodoWrite touches an in-memory list, and WebFetch /
# WebSearch don't take a local path.
#
# Deliberately NOT auto-allowed (they route to the sandbox):
#   - Read/Glob/Grep/NotebookRead: these take a PATH, and fast-allowing them
#     here meant the sandbox never saw them — so `Read` was an unlogged,
#     unprompted way to pull ~/.claude/.credentials.json or the sandbox token
#     out of a session. The sandbox answers immediately (no dashboard card) for
#     a path inside the session's workdir; only an escape prompts.
#   - Bash: frictionless in normal mode, but the sandbox must be able to DENY it
#     during a plan turn (read-only) and escalate `git push` to the host. The
#     sandbox answers immediately for the normal case (no dashboard card).
#   - ExitPlanMode: the sandbox captures the plan from its input and opens the
#     review deterministically (replacing the old heuristic), then denies the
#     tool so the turn holds for approval.
#   - AskUserQuestion: in headless mode it would resolve empty ("dismissed"); it
#     flows through the dashboard so the operator's answer is relayed back.
#
# NOTE on cost: routing reads through the sandbox adds one UDS round trip to a
# frequent operation. That's paid for by /permission-ask answering inline when
# the decision is already known (see below), which removes the /permission-wait
# call for every fast-lane decision — reads AND Bash — so the common path is
# one request rather than the two it used to take.
AUTO_ALLOW='^(WebFetch|WebSearch|TodoWrite|ToolSearch)$'

emit_allow() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"approved by user via dashboard"}}'
  exit 0
}

emit_allow_auto() {
  printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"auto-allowed (safe tool)"}}'
  exit 0
}

emit_deny() {
  local reason="${1:-denied}"
  # Reason is a fixed literal — no shell interpolation into JSON.
  case "$reason" in
    no-dashboard) printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"permission gate unreachable; dashboard offline"}}' ;;
    timeout)      printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no response from dashboard within timeout"}}' ;;
    user)         printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied by user via dashboard"}}' ;;
    policy)       printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"blocked by hooop policy: browser_run_code_unsafe (arbitrary-code browser tool) is permanently disabled"}}' ;;
    *)            printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"denied"}}' ;;
  esac
  exit 0
}

# Hard-deny list: tools that are NEVER allowed — not even via a dashboard
# approval. @playwright/mcp ships `browser_run_code_unsafe` (arbitrary JS in the
# Playwright process, RCE-equivalent) as a non-removable "core" capability, and
# under `--permission-mode bypassPermissions` claude's own permissions.deny is
# inert — so THIS gate is the only reliable place to block it on the dashboard.
# (The settings.json deny still covers `hooop open`, which uses normal perms.)
# Relay the sandbox's decision reason (e.g. plan-rejection feedback) back to the
# model as permissionDecisionReason. The reason is arbitrary host text — quotes,
# newlines, markdown — so it MUST be JSON-encoded, not shell-interpolated. node
# ships in the sandbox image; if it's somehow absent or the payload won't parse,
# fall back to the fixed literals.
#
# Reads $WAIT_RES from the environment, so callers set it first. Defined up here
# with the other emitters because the inline-decision fast path below calls it
# well before the long-poll section.
emit_from_wait() {
  local decision="$1"
  if command -v node >/dev/null 2>&1; then
    WAIT_RES="$WAIT_RES" DEC="$decision" node -e '
      try {
        const w = JSON.parse(process.env.WAIT_RES || "{}");
        const dec = process.env.DEC;
        const fallback = dec === "allow" ? "approved by user via dashboard" : "denied by user via dashboard";
        const reason = (typeof w.reason === "string" && w.reason.trim()) ? w.reason : fallback;
        process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: dec, permissionDecisionReason: reason } }) + "\n");
      } catch (e) { process.exit(3); }
    ' && exit 0
  fi
  if [ "$decision" = "allow" ]; then emit_allow; else emit_deny user; fi
}

HARD_DENY='^mcp__playwright__browser_run_code_unsafe$'

# 1. Read hook context. Extract the tool_name.
PAYLOAD=$(cat 2>/dev/null)
if [ -z "$PAYLOAD" ]; then
  emit_deny no-dashboard
fi
TOOL_NAME=$(printf '%s' "$PAYLOAD" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')

# 1a. Hard-deny: never routed to the dashboard, never approvable.
if printf '%s' "$TOOL_NAME" | grep -qE "$HARD_DENY"; then
  emit_deny policy
fi

# 2. Fast-path: read-only tools allow without a round trip. Everything else
#    (Bash, ExitPlanMode, writes, AskUserQuestion, MCP, …) routes to the sandbox,
#    which is the single policy authority — it enforces plan-mode read-only,
#    captures plans, escalates `git push`, and prompts the dashboard as needed.
if printf '%s' "$TOOL_NAME" | grep -qE "$AUTO_ALLOW"; then
  emit_allow_auto
fi

# 3. Everything else needs an explicit dashboard approval. Bail to DENY if
#    sandbox plumbing is missing.
command -v curl >/dev/null 2>&1 || emit_deny no-dashboard
[ -S "$SANDBOX_SOCKET" ] || emit_deny no-dashboard
[ -r "$HOOK_TOKEN_FILE" ] || emit_deny no-dashboard
TOKEN=$(cat "$HOOK_TOKEN_FILE" 2>/dev/null) || emit_deny no-dashboard
[ -n "$TOKEN" ] || emit_deny no-dashboard

ASK_RES=$(curl -fsS --max-time 5 --unix-socket "$SANDBOX_SOCKET" \
  -H "X-Hook-Token: $TOKEN" \
  -H "Content-Type: application/json" \
  --data "$PAYLOAD" \
  "http://sandbox/permission-ask" 2>/dev/null) || emit_deny no-dashboard
[ -n "$ASK_RES" ] || emit_deny no-dashboard

REQUEST_ID=$(printf '%s' "$ASK_RES" | grep -o '"requestId":"[^"]*"' | head -1 | sed 's/.*"requestId":"\([^"]*\)"/\1/')
[ -n "$REQUEST_ID" ] || emit_deny no-dashboard

# Fast path: when the sandbox already decided (a read inside the workdir, a
# non-critical Bash, a plan-mode deny) it returns the decision inline and there
# is nothing to long-poll for. Skipping /permission-wait halves the round trips
# on every no-card decision, which is what keeps routing reads through the
# sandbox affordable.
INLINE_DECISION=$(printf '%s' "$ASK_RES" | grep -o '"decision":"[^"]*"' | head -1 | sed 's/.*"decision":"\([^"]*\)"/\1/')
if [ -n "$INLINE_DECISION" ]; then
  WAIT_RES="$ASK_RES"
  case "$INLINE_DECISION" in
    allow) emit_from_wait allow ;;
    deny)  emit_from_wait deny ;;
  esac
fi

WAIT_RES=$(curl -fsS --max-time "$(( GATE_TIMEOUT + 5 ))" --unix-socket "$SANDBOX_SOCKET" \
  -H "X-Hook-Token: $TOKEN" \
  "http://sandbox/permission-wait?requestId=${REQUEST_ID}&timeout=${GATE_TIMEOUT}" 2>/dev/null) || emit_deny timeout
[ -n "$WAIT_RES" ] || emit_deny timeout

DECISION=$(printf '%s' "$WAIT_RES" | grep -o '"decision":"[^"]*"' | head -1 | sed 's/.*"decision":"\([^"]*\)"/\1/')

case "$DECISION" in
  allow) emit_from_wait allow ;;
  deny)  emit_from_wait deny ;;
  *)     emit_deny timeout ;;
esac
