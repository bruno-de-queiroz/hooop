#!/bin/bash
#@module Setup - interactive wizard to configure the sandbox Claude Code stack (native /hooop:setup)

#import oo.sh
. ${MODULES_DIR}/../oo.sh
# Shared runtime engine (HS_* paths, sandbox-exec helpers, env-file writers,
# host guards) + the interactive prompt helpers the wizard needs. Both are
# side-effect-free to source, so completion stays fast.
. ${MODULES_DIR}/../lib/stack.sh
. ${MODULES_DIR}/../lib/prompt.sh
. ${MODULES_DIR}/../lib/progress.sh

# =============================================================================
# hooop setup — the interactive stack wizard (native port of /hooop:setup)
#
# Configures the sandbox's full Claude Code stack from a plain terminal, with no
# host Claude Code required. It runs BEFORE `hooop login` (writing MCP config
# needs no auth) and reuses the runtime engine in lib/stack.sh: it boots the
# sandbox, then routes every `claude mcp add` through the live container so the
# config lands in the bind-mounted sandbox profile (durable across rebuilds and
# shared with `hooop open`). Auto-runnable + secret-taking MCPs are installed
# directly; browser-OAuth / plugin-marketplace / host-CLI options are printed as
# guided steps (they can't be scripted head-less). Secrets are passed straight
# to `claude mcp add -e` or the 0600 env file and are NEVER written to the log.
# =============================================================================

# Wizard state (module-scoped globals so the step helpers can accumulate).
SETUP_CMDLOG=""     # markdown lines: `label` -> exit N
SETUP_ERRORS=""     # failed steps, surfaced in the summary
SETUP_NOTES=""      # manual follow-ups the user still needs to do
SETUP_MCP_LIST=""   # cached `claude mcp list` output for detection
PICK_MEMORY="" PICK_CODEGRAPH="" PICK_LANGS="" PICK_N8N="" PICK_PLATFORM=""
PICK_DOCSRAG="" PICK_SEMANTIC="" PICK_OBS="" PICK_DESIGN="" PICK_BRAIN="" PICK_TELEMETRY="leave as-is"

_setup_sandbox_running() {
  local id; id="$("${HS_COMPOSE[@]}" ps -q "$HS_SVC_SANDBOX" 2>/dev/null | head -1)"
  [ -n "$id" ]
}

# True if `claude mcp list` (cached) already shows a server matching $1.
_setup_has_mcp() { printf '%s' "$SETUP_MCP_LIST" | grep -qi "$1"; }

# _setup_exec "safe-label" cmd args…  — run a command inside the sandbox under
# the progress spinner, logging it by its SAFE label (never the raw args, which
# may hold secrets). _prog_run owns the on-screen rendering (spinner + ✔/✘ + log
# tail on failure); here we only keep the audit bookkeeping. When called inside
# an outer _prog_run step (the default stack path) it runs inline and stays
# silent; standalone (the wizard) it gets its own spinner line.
_setup_exec() {
  local label="$1"; shift
  if _prog_run "$label" "$@"; then
    SETUP_CMDLOG+="- \`${label}\` -> exit 0"$'\n'
    return 0
  fi
  local rc=$?
  SETUP_CMDLOG+="- \`${label}\` -> exit ${rc} (FAILED)"$'\n'
  SETUP_ERRORS+="- ${label} (exit ${rc})"$'\n'
  return $rc
}

# _setup_exec_live "safe-label" cmd args…  — like _setup_exec but for commands
# that are THEMSELVES interactive/blocking on the user (OAuth device-code
# flows, paste-the-redirect-URL logins): gh device flow and `claude mcp login`
# both print a one-time code/URL and then block waiting for the user to act on
# it, sometimes reading a pasted value back from stdin. _prog_run's spinner
# path would hide exactly that code/URL in a temp log (only shown on FAILURE)
# and redirect stdin from /dev/null — which also flips _hs_exec_sandbox's TTY
# detection to pass `-T` (no pty), breaking any prompt the command needs to
# read. So these run fully live: no spinner, no capture, real stdin/tty —
# same audit bookkeeping as _setup_exec, just without _prog_run in the middle.
_setup_exec_live() {
  local label="$1"; shift
  "$@"
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    SETUP_CMDLOG+="- \`${label}\` -> exit 0"$'\n'
  else
    SETUP_CMDLOG+="- \`${label}\` -> exit ${rc} (FAILED)"$'\n'
    SETUP_ERRORS+="- ${label} (exit ${rc})"$'\n'
  fi
  return $rc
}

# _setup_mcp <name> <claude-mcp-add-args…>  — `claude mcp add --scope user …`
# in the sandbox, logged as just "claude mcp add <name>" (no secret leakage).
_setup_mcp() {
  local name="$1"
  _setup_exec "claude mcp add ${name}" _hs_exec_sandbox claude mcp add --scope user "$@"
}

_setup_note() { SETUP_NOTES+="- $1"$'\n'; }

# Print a guided (non-scriptable) block and wait for the user to confirm.
_setup_guided() {
  printf '\n  %s%s%s\n' "$_YL" "$1" "$_RST" >&2; shift
  local line; for line in "$@"; do printf '      %s\n' "$line" >&2; done
  _p_pause "Press Enter once done (or to skip)"
}

# --- Steps -------------------------------------------------------------------

_setup_consent() {
  cat >&2 <<EOF

  ${_B}hooop setup${_RST} — configure your Claude Code stack in the sandbox.

  Memory (claude-mem) installs automatically — it powers the dashboard summaries,
  so there's no menu for it. I'll then walk through 8 short menus (code-graph,
  automation, platform MCPs, docs RAG, semantic search, observability, design,
  second-brain) and install each pick into the sandbox profile. Auto-installable
  tools run now; browser/OAuth and gh sign-ins are queued and completed at the end
  inside the sandbox; a few marketplace/manual steps may be printed for you to
  finish. I will NOT touch your ~/.claude/CLAUDE.md or settings.json.
  Secrets go straight to the tool config or a 0600 env file — never the log.
EOF
  _p_confirm "Proceed?" y
}

_setup_bootstrap() {
  if ! _setup_sandbox_running; then
    _prog_run "Building the sandbox image (first run ~2-3 min)" \
      hooop_stack_start sandbox || { _error "failed to start the sandbox"; return 1; }
  fi
  _setup_sandbox_running || { _error "sandbox still not running — inspect: hooop logs"; return 1; }
  SETUP_MCP_LIST="$(_hs_exec_sandbox claude mcp list 2>/dev/null || true)"
  mkdir -p "$HS_SANDBOX_STATE"
}

_setup_telemetry() {
  local cur="leave as-is"
  grep -q '^HOOOP_DISABLE_TELEMETRY=1' "$HS_ENV_FILE" 2>/dev/null && cur="already isolated"
  printf '\n  %sTelemetry & privacy.%s Various tools in the stack emit analytics/telemetry by\n  default. hooop can keep the sandbox quiet by disabling nonessential outbound\n  traffic at boot.\n  Current: %s\n' \
    "$_B" "$_RST" "$cur" >&2
  local pick; pick="$(_p_select_skip "Telemetry" "Isolate fully (recommended)")"
  case "$pick" in
    Isolate*) hooop_stack_set_env HOOOP_DISABLE_TELEMETRY 1
              PICK_TELEMETRY="isolated"; _info "telemetry isolation enabled (applied on next start)" ;;
    *)        PICK_TELEMETRY="leave as-is" ;;
  esac
}

# claude-mem is the ONLY supported memory backend, so there's no menu — it's
# installed unconditionally. Rationale: it is the sole store the dashboard
# Summary rail reads (~/.claude-mem/claude-mem.db, tables session_summaries +
# sdk_sessions). Mem0 / mcp-memory-service / MemPalace don't feed the dashboard
# at all, so offering them here only produced a silently-degraded experience.
_setup_memory() {
  PICK_MEMORY="claude-mem"
  # Idempotent: claude-mem's installer creates ~/.claude-mem in the sandbox.
  if _hs_exec_sandbox test -d /home/agent/.claude-mem 2>/dev/null; then
    _info "claude-mem is already installed in the sandbox — skipping."
    SETUP_CMDLOG+="- \`claude-mem (already installed)\` -> exit 0"$'\n'
    return 0
  fi
  _info "installing claude-mem (powers the dashboard session summaries)…"
  # Non-interactive: every claude-mem installer prompt (IDE multi-select,
  # provider, runtime, and the end telemetry ask) is guarded by `isInteractive`
  # (== `process.stdin.isTTY`). _hs_exec_sandbox allocates a TTY whenever the
  # caller has one, so the reliable way to skip ALL prompts is to feed the exec
  # a non-TTY stdin (`</dev/null` → _hs_exec_sandbox passes `-T`); the installer
  # then defaults to the Claude Code IDE + worker runtime with no prompts. We
  # deliberately DON'T pass `--ide claude-code`: that flag path runs a detection
  # check and `process.exit(1)`s on a miss, whereas the non-interactive default
  # selects claude-code unconditionally. `--provider claude --runtime worker
  # --no-auto-start` pin the rest, and CLAUDE_MEM_TELEMETRY=0 forces telemetry
  # off (belt-and-suspenders on top of the non-interactive skip).
  _setup_exec "npx -y claude-mem install (non-interactive)" \
    _hs_exec_sandbox env CLAUDE_MEM_TELEMETRY=0 \
    npx -y claude-mem install --provider claude --runtime worker --no-auto-start </dev/null
}

# Serena is uv-managed (uv is baked into the sandbox image). Install the CLI,
# then register its launch command with Claude Code. Serena's README only warns
# against installing Serena *itself* via a plugin/marketplace entry — the
# documented Claude Code wiring IS this `claude mcp add` +
# `serena start-mcp-server --context claude-code` form. The older
# `--context ide-assistant` / `uvx --from git+…` variants are deprecated.
# Shared by the wizard's code-graph menu and the non-interactive default stack.
_setup_serena() {
  if _setup_exec "uv tool install serena-agent" \
       _hs_exec_sandbox uv tool install -p 3.13 serena-agent; then
    _setup_mcp serena -- serena start-mcp-server --context claude-code --project-from-cwd
    _setup_note "Serena: installed via uv + registered (--scope user, --context claude-code). First launch resolves the language server (can be slow); verify with /mcp."
    _setup_note "Serena hooks (activate/remind/cleanup) wire automatically inside the sandbox on next boot — auto-approve is intentionally not installed."
  else
    _setup_note "Serena: 'uv tool install serena-agent' failed in the sandbox — check egress/network and re-run 'hooop setup'."
  fi
}

# Deterministic port of the code-graph recommendation logic.
_setup_codegraph_reco() {
  case "$PICK_LANGS" in
    *Scala*|*Terraform*) echo "Serena" ;;
    *) echo "code-graph-mcp" ;;
  esac
}

_setup_codegraph() {
  if ! _p_confirm "Do you do engineering (coding) work in Claude sessions?" y; then
    PICK_CODEGRAPH="n/a (non-coding)"; return 0
  fi
  PICK_LANGS="$(_p_multiselect "Languages (for the recommendation)" \
    Scala Java/JVM Node.js/JS TypeScript React Python Go Rust Terraform/HCL C/C++ C# Kotlin Swift Other | tr '\n' ',' )"
  PICK_LANGS="${PICK_LANGS%,}"
  local reco; reco="$(_setup_codegraph_reco)"
  printf '  %srecommended for your languages: %s%s\n' "$_DIM" "$reco" "$_RST" >&2
  local pick; pick="$(_p_select_skip "Code-graph engine (recommended: ${reco})" \
    "Serena" "code-graph-mcp" "claude-context" "Cognee")"
  PICK_CODEGRAPH="$pick"
  case "$pick" in
    code-graph-mcp)
      _setup_mcp code-graph-mcp -- npx -y @sdsrs/code-graph ;;
    claude-context)
      local ok key milvus token
      key="$(_p_input 'OpenAI API key (sk-…):')"
      milvus="$(_p_input 'Zilliz/Milvus endpoint (MILVUS_ADDRESS):')"
      token="$(_p_input 'Milvus token (MILVUS_TOKEN):')"
      _setup_mcp claude-context \
        -e OPENAI_API_KEY="$key" -e MILVUS_ADDRESS="$milvus" -e MILVUS_TOKEN="$token" \
        -- npx -y @zilliz/claude-context-mcp@latest ;;
    Serena)
      _setup_serena ;;
    Cognee)
      _setup_guided "Cognee has no simple 'claude mcp add' — add this to ~/.claude/config.json:" \
        '{ "mcpServers": { "cognee": { "command": "uv", "args": ["--directory","/path/to/cognee-mcp","run","cognee-mcp"] } } }'
      _setup_note "Cognee: add the mcpServers.cognee block per catalog/code-graph.md" ;;
  esac
}

_setup_n8n() {
  local pick; pick="$(_p_select_skip "Automation (n8n)" "Yes — docs-only mode" "Yes — with credentials")"
  PICK_N8N="$pick"
  case "$pick" in
    "Yes — docs-only mode")
      _setup_mcp n8n-mcp \
        -e MCP_MODE=stdio -e LOG_LEVEL=error -e DISABLE_CONSOLE_OUTPUT=true \
        -- npx -y n8n-mcp ;;
    "Yes — with credentials")
      local url key
      url="$(_p_input 'N8N_API_URL (e.g. http://localhost:5678):')"
      _p_secret 'N8N_API_KEY:' key
      _setup_mcp n8n-mcp \
        -e MCP_MODE=stdio -e LOG_LEVEL=error -e DISABLE_CONSOLE_OUTPUT=true \
        -e N8N_API_URL="$url" -e N8N_API_KEY="$key" \
        -- npx -y n8n-mcp ;;
  esac
}

_setup_platform() {
  local sel; sel="$(_p_multiselect "Platform MCPs" \
    "Atlassian (Jira+Confluence)" "Google Workspace (gws)" "GitHub (gh)" "incident.io" "Slack")"
  [ -z "$sel" ] && { PICK_PLATFORM="skipped"; return 0; }
  PICK_PLATFORM="$(printf '%s' "$sel" | paste -sd ',' - 2>/dev/null || printf '%s' "$sel" | tr '\n' ',')"
  # Iterate via an array, NOT `while read <<< "$sel"`: a here-string redirects the
  # loop body's stdin, so interactive prompts inside (e.g. the gws key) would read
  # the next selected line instead of the terminal.
  local -a items=(); local line item
  while IFS= read -r line; do [ -n "$line" ] && items+=("$line"); done <<< "$sel"
  for item in "${items[@]}"; do
    case "$item" in
      Atlassian*)
        # Rovo remote MCP. /v1/sse is retired (June 2026) and /v1/mcp/authv2 has
        # an OAuth bug in Claude Code (issue #69035); /v1/mcp is the working one.
        if _setup_mcp atlassian --transport http https://mcp.atlassian.com/v1/mcp; then
          _setup_queue_login atlassian
          _setup_note "Atlassian (Jira+Confluence): OAuth sign-in runs at the end of setup."
        fi ;;
      Google*)
        _setup_gws ;;
      GitHub*)
        SETUP_AUTH_GH=1
        _info "GitHub: will sign in inside the sandbox at the end of setup (device flow)." ;;
      incident.io)
        if _setup_mcp incident-io --transport http https://mcp.incident.io/mcp; then
          _setup_queue_login incident-io
          _setup_note "incident.io: OAuth sign-in runs at the end of setup."
        fi ;;
      Slack)
        if _setup_mcp slack --transport http https://slack.com/mcp; then
          _setup_queue_login slack
          _setup_note "Slack: OAuth sign-in runs at the end of setup."
        fi ;;
    esac
  done
}

# Google Workspace: the `gws` CLI is baked into the sandbox image, so only the
# credentials need wiring — nothing is installed on the host. gws has NO headless
# browser-callback flow (localhost-only; upstream issue #210), so we use a GCP
# service-account key: copy it into the mounted profile (0600) and point the
# baked gws at it via GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE (forwarded by compose).
_setup_gws() {
  local src; src="$(_p_input 'Path to a GCP service-account JSON key for gws (Enter to skip):')"
  if [ -z "$src" ]; then
    _setup_note "Google Workspace: skipped — re-run setup with a service-account key (needs domain-wide delegation + enabled Workspace APIs). See catalog/platform.md."
    return 0
  fi
  src="${src/#\~/$HOME}"
  if [ ! -f "$src" ]; then
    _error "no file at: $src"
    _setup_note "Google Workspace: service-account key not found at '$src' — skipped."
    return 0
  fi
  local dst_dir="$HS_SANDBOX_PROFILE/.config/gws"
  mkdir -p "$dst_dir"
  if install -m 600 "$src" "$dst_dir/service-account.json" 2>/dev/null \
     || { cp "$src" "$dst_dir/service-account.json" && chmod 600 "$dst_dir/service-account.json"; }; then
    hooop_stack_set_env GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE /home/agent/.config/gws/service-account.json
    _info "gws service-account key copied into the sandbox profile (0600); active on next start."
    _setup_note "Google Workspace: uses a service-account key. Ensure domain-wide delegation + the Workspace APIs/scopes it needs are enabled."
    SETUP_CMDLOG+="- \`configure gws service-account credentials\` -> exit 0"$'\n'
  else
    _error "failed to copy the service-account key into the profile"
    _setup_note "Google Workspace: couldn't copy the key — check permissions on $dst_dir."
  fi
}

# Queue a remote MCP for OAuth sign-in in the end-of-setup auth phase. Called
# right after a successful `claude mcp add` for an OAuth-backed HTTP server.
_setup_queue_login() { SETUP_AUTH_MCP="${SETUP_AUTH_MCP:-}${SETUP_AUTH_MCP:+ }$1"; }

# GitHub: OAuth *device* flow inside the sandbox (one-time code at
# github.com/login/device) — no localhost callback, completes headlessly.
_setup_login_gh() {
  printf '\n  %sGitHub sign-in — device flow, inside the sandbox%s\n' "$_B" "$_RST" >&2
  if _hs_exec_sandbox gh auth status >/dev/null 2>&1; then
    _info "sandbox gh is already authenticated — skipping."
    SETUP_CMDLOG+="- \`gh auth (already authenticated)\` -> exit 0"$'\n'
    return 0
  fi
  printf '  %sA one-time code + URL will appear — open the URL in your browser and enter the code.%s\n' \
    "$_DIM" "$_RST" >&2
  _setup_exec_live "gh auth login (device flow)" \
    _hs_exec_sandbox gh auth login --hostname github.com --git-protocol https --web \
    || _setup_note "GitHub: sign-in didn't finish — run 'hooop open' then 'gh auth login --web' in the sandbox."
}

# Remote MCP OAuth via `claude mcp login <name> --no-browser`. In the headless
# sandbox this prints the auth URL and waits: you open it in any browser, approve,
# and — since the localhost redirect can't reach the container — paste the full
# redirect URL from the address bar back at the prompt. No reachable callback
# needed, so it works where a plain browser-callback flow (e.g. gws) cannot.
_setup_login_mcp() {
  local name="$1"
  printf '\n  %sSign in: %s%s %s(open the printed URL; if the redirect errors, paste the address-bar URL back here)%s\n' \
    "$_B" "$name" "$_RST" "$_DIM" "$_RST" >&2
  _setup_exec_live "claude mcp login ${name}" \
    _hs_exec_sandbox claude mcp login "$name" --no-browser \
    || _setup_note "${name}: sign-in didn't finish — run 'claude mcp login ${name} --no-browser' in the sandbox (hooop open)."
}

# Claude Code sign-in for the sandbox (its OWN account, host-decoupled). Runs
# right AFTER the gh login and BEFORE the MCP OAuth logins + profile write:
# `claude mcp login` needs a signed-in session, and _setup_write_profile (right
# after _setup_auth) reads .claude.json.oauthAccount — both require this to have
# happened, while gh (device flow) has no such dependency so it goes first.
# Reuses hooop_stack_login: drops into `claude` in the sandbox for the /login
# paste-code flow (the container's localhost callback is unreachable).
_setup_login_claude() {
  if _hs_sandbox_authenticated; then
    _info "sandbox is already signed in to Claude — skipping login."
    SETUP_CMDLOG+="- \`claude login (already signed in)\` -> exit 0"$'\n'
    return 0
  fi
  printf '\n  %sClaude Code sign-in%s — the sandbox needs its own Claude account.\n' "$_B" "$_RST" >&2
  printf '  %sYou will drop into a claude session: type /login, approve the URL, paste the code, then /exit.%s\n' \
    "$_DIM" "$_RST" >&2
  _p_pause "Press Enter to open the sandbox Claude login (or Ctrl-C to skip)"
  hooop_stack_login || true
  if _hs_sandbox_authenticated; then
    SETUP_CMDLOG+="- \`claude login (sandbox)\` -> exit 0"$'\n'
  else
    _setup_note "Claude: sandbox not signed in — run 'hooop login' before using the stack (MCP OAuth logins below may fail without it)."
  fi
}

# End-of-setup interactive sign-ins. Everything runs INSIDE the sandbox so the
# host stays docker-only: Claude Code (/login paste-code) first, then gh (device
# flow) + every OAuth remote MCP queued during the menus
# (Atlassian/Slack/incident.io/Sentry/Notion) via claude mcp login.
_setup_auth() {
  printf '\n  %sSign-ins%s — completing auth now so nothing is deferred to first use.\n' "$_B" "$_RST" >&2
  # Order is dependency-driven and ends right before _setup_write_profile:
  #  1. gh (device flow) — no deps; profile.md reads `gh api user`.
  #  2. Claude /login — the sandbox's own account. MUST precede `claude mcp login`
  #     (MCP OAuth needs a signed-in session) and the profile write (reads
  #     .claude.json.oauthAccount). Runs right AFTER gh so both identities exist.
  #  3. queued MCP OAuth logins (need the Claude session from step 2).
  [ -n "${SETUP_AUTH_GH:-}" ] && _setup_login_gh
  _setup_login_claude
  local name
  for name in ${SETUP_AUTH_MCP:-}; do
    _setup_login_mcp "$name"
  done
}

_setup_docsrag() {
  local pick; pick="$(_p_select_skip "Docs RAG (Context7)" "Context7 (free tier)" "Context7 (with API key)")"
  PICK_DOCSRAG="$pick"
  case "$pick" in
    "Context7 (free tier)")
      _setup_mcp context7 -- npx -y @upstash/context7-mcp@latest ;;
    "Context7 (with API key)")
      local key; _p_secret "Context7 API key:" key
      _setup_mcp context7 -- npx -y @upstash/context7-mcp --api-key "$key" ;;
  esac
}

# Semantic search backend for the dashboard (embeddings). We FAVOR Docker Model
# Runner (DMR): choosing it appends the embedding model to the compose stack via
# Compose's `models:` element (hooop_stack_write_dmr_model), so `hooop start`
# auto-pulls it and injects the endpoint into the sandbox. DMR must be enabled on
# the host (Docker Desktop AI, or the docker-model-plugin on Engine) — the models
# provider requires it — so we confirm before enabling. Ollama/OpenAI/Custom
# remain as secondary options.
_setup_semantic() {
  # Zero-config: DMR already up AND the embedding model already pulled → use it.
  if curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1 \
     && docker model ls 2>/dev/null | grep -q 'nomic-embed-text-v1.5'; then
    hooop_stack_unset_env EMBEDDING_BASE_URL EMBEDDING_MODEL OPENAI_API_KEY HOOOP_EMBED_HOSTED_CONSENT
    hooop_stack_set_env EMBED_DIM 768
    hooop_stack_write_dmr_model "ai/nomic-embed-text-v1.5"
    _info "Docker Model Runner ready on :12434 — added ai/nomic-embed-text-v1.5 to the compose stack; semantic search auto-enables."
    PICK_SEMANTIC="Docker Model Runner"; return 0
  fi
  local pick; pick="$(_p_select_skip "Semantic search backend (skip = BM25-only)" \
    "Docker Model Runner (recommended, local)" \
    "Ollama (local)" "OpenAI (hosted)" "Custom OpenAI-compatible endpoint")"
  PICK_SEMANTIC="$pick"
  case "$pick" in
    "Docker Model Runner"*)
      _setup_dmr ;;
    "Ollama"*)
      hooop_stack_clear_dmr_model
      hooop_stack_unset_env OPENAI_API_KEY HOOOP_EMBED_HOSTED_CONSENT
      hooop_stack_set_env EMBEDDING_BASE_URL "http://host.docker.internal:11434/v1"
      hooop_stack_set_env EMBEDDING_MODEL "nomic-embed-text"
      hooop_stack_set_env EMBED_DIM 768
      _setup_note "Ollama: ensure 'ollama serve' is running on the host and 'ollama pull nomic-embed-text' is done." ;;
    "OpenAI"*)
      hooop_stack_clear_dmr_model
      local key; _p_secret "OPENAI_API_KEY:" key
      hooop_stack_unset_env EMBEDDING_BASE_URL
      hooop_stack_set_env OPENAI_API_KEY "$key"
      hooop_stack_set_env HOOOP_EMBED_HOSTED_CONSENT yes
      hooop_stack_set_env EMBEDDING_MODEL "text-embedding-3-small"
      hooop_stack_set_env EMBED_DIM 1536 ;;
    "Custom"*)
      hooop_stack_clear_dmr_model
      local url model
      url="$(_p_input 'EMBEDDING_BASE_URL (OpenAI-compatible /v1):')"
      model="$(_p_input 'EMBEDDING_MODEL (optional):')"
      hooop_stack_unset_env OPENAI_API_KEY HOOOP_EMBED_HOSTED_CONSENT
      [ -n "$url" ] && hooop_stack_set_env EMBEDDING_BASE_URL "$url"
      [ -n "$model" ] && hooop_stack_set_env EMBEDDING_MODEL "$model"
      _setup_note "Custom embedder: if its vector width isn't 768, set EMBED_DIM in $HS_ENV_FILE and re-run setup." ;;
    *)
      # Skipped (Enter/none) → BM25-only. Drop any prior DMR compose-models dep.
      hooop_stack_clear_dmr_model ;;
  esac
}

# Set up Docker Model Runner ON THE HOST (with explicit consent): make an
# embedding endpoint live on :12434 and pull the model. Works with three
# runners — Docker Desktop (`docker model`), Docker Engine (`docker model` via
# the docker-model-plugin), or the standalone `dmr` binary (no Docker
# Desktop/Engine). DMR runs models as native host processes, so this is the one
# embedding path that touches the host beyond docker itself — hence the confirm.
_setup_dmr() {
  local model="ai/nomic-embed-text-v1.5"
  # Drop any stale DMR compose-models override up front; only a fully successful
  # setup re-writes it, so a failed/aborted run never leaves a dangling model dep.
  hooop_stack_clear_dmr_model
  if ! command -v docker >/dev/null 2>&1; then
    _error "docker not found on the host — DMR is unavailable."
    _setup_note "DMR: install Docker (with Model Runner) or pick Ollama/OpenAI."
    PICK_SEMANTIC="skipped"; return 1
  fi
  printf '\n  %sDocker Model Runner runs on the HOST.%s It serves the embedding model on\n  :12434 as a native host process; the sandbox connects to it. This enables\n  host-side TCP (if needed) and pulls %s onto your host (one-time download).\n' \
    "$_B" "$_RST" "$model" >&2
  if ! _p_confirm "Set up Docker Model Runner on the host now?" y; then
    _setup_note "DMR: declined host setup — semantic search left BM25-only. Re-run 'hooop setup' to enable."
    PICK_SEMANTIC="skipped"; return 1
  fi
  # Bring up a runner + host TCP on :12434 if nothing is serving yet. On Docker
  # Desktop this one call also provisions the `docker model` CLI plugin.
  if ! curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1; then
    docker desktop enable model-runner --tcp 12434 >/dev/null 2>&1 \
      && _info "enabled Docker Model Runner (TCP :12434)." || true
  fi
  # Resolve a usable Model Runner CLI. `docker model` ships with Docker
  # Desktop/Engine; `dmr` is the standalone binary (no Docker Desktop/Engine
  # required — its daemon is started with `dmr serve`). We probe with `... ls`
  # because it actually exercises the tool: `docker model --help` is unreliable
  # (it can exit 0 even when real subcommands report "unknown command").
  local -a mr=()
  if docker model ls >/dev/null 2>&1; then mr=(docker model)
  elif command -v dmr >/dev/null 2>&1 && dmr ls >/dev/null 2>&1; then mr=(dmr)
  fi
  if [ ${#mr[@]} -eq 0 ]; then
    if command -v dmr >/dev/null 2>&1; then
      _setup_guided "The standalone 'dmr' binary is installed but no daemon is serving on :12434 — start it, then re-run 'hooop setup':" \
        "dmr serve &        # runs the inference daemon on :12434"
    else
      local os arch
      os="$(uname -s | tr '[:upper:]' '[:lower:]')"; arch="$(uname -m)"
      case "$arch" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; esac
      _setup_guided "Docker Model Runner isn't available. Pick ONE, then re-run 'hooop setup':" \
        "Docker Desktop:        docker desktop enable model-runner --tcp 12434   (or Settings -> AI -> Enable Model Runner + host-side TCP)" \
        "Docker Engine (Linux): sudo apt-get install docker-model-plugin   (or: sudo dnf install docker-model-plugin) — TCP :12434 on by default" \
        "Standalone (no Docker Desktop/Engine): download dmr-${os}-${arch}.tar.gz from https://github.com/docker/model-runner/releases/latest, extract, then: ./dmr serve &" \
        "  …or build from source: brew install go git make && git clone https://github.com/docker/model-runner && cd model-runner && make && ./dmr serve &"
    fi
    _setup_note "DMR: nothing serving on :12434 — see the printed options (Docker Desktop / Docker Engine / standalone dmr), then re-run 'hooop setup'."
    PICK_SEMANTIC="skipped"; return 1
  fi
  if "${mr[@]}" ls 2>/dev/null | grep -q 'nomic-embed-text-v1.5'; then
    _info "DMR embedding model already present: $model"
  elif ! _setup_exec "${mr[*]} pull ${model}" "${mr[@]}" pull "$model"; then
    _setup_note "DMR: '${mr[*]} pull ${model}' failed — pull it manually, then re-run setup."
    PICK_SEMANTIC="skipped"; return 1
  fi
  hooop_stack_unset_env EMBEDDING_BASE_URL EMBEDDING_MODEL OPENAI_API_KEY HOOOP_EMBED_HOSTED_CONSENT
  hooop_stack_set_env EMBED_DIM 768
  # Append the embedding model to the compose stack via Compose's `models:`
  # element: `docker compose up` pulls it and injects the endpoint into the
  # sandbox. (Requires DMR enabled on the host + Compose v2.38+.)
  hooop_stack_write_dmr_model "$model"
  PICK_SEMANTIC="Docker Model Runner"
  _setup_note "Docker Model Runner: ${model} added to the compose stack (Compose 'models:'). 'hooop start' provisions + connects it; requires DMR enabled on the host."
}

_setup_observability() {
  local sel; sel="$(_p_multiselect "Observability" \
    "Sentry (plugin)" "Sentry (hosted MCP)" "Sentry (self-hosted stdio)" "Datadog")"
  [ -z "$sel" ] && { PICK_OBS="skipped"; return 0; }
  PICK_OBS="$(printf '%s' "$sel" | tr '\n' ',')"; PICK_OBS="${PICK_OBS%,}"
  # Array iteration (not `while read <<< "$sel"`) so the Datadog key prompts read
  # the terminal, not the selected lines. See _setup_platform for the rationale.
  local -a items=(); local line item
  while IFS= read -r line; do [ -n "$line" ] && items+=("$line"); done <<< "$sel"
  for item in "${items[@]}"; do
    case "$item" in
      "Sentry (plugin)")
        _setup_guided "Sentry plugin — run in a sandbox session (installs MCP + subagent):" \
          "/plugin marketplace add getsentry/sentry-mcp" \
          "/plugin install sentry-mcp@sentry-mcp"
        _setup_note "Sentry: finish plugin install in a sandbox session" ;;
      "Sentry (hosted MCP)")
        if _setup_mcp sentry --transport http https://mcp.sentry.dev/mcp; then
          _setup_queue_login sentry
          _setup_note "Sentry: OAuth sign-in runs at the end of setup."
        fi ;;
      "Sentry (self-hosted stdio)")
        _setup_mcp sentry -- npx -y @sentry/mcp-server ;;
      Datadog)
        local api app site
        _p_secret 'DD_API_KEY:' api
        _p_secret 'DD_APP_KEY:' app
        site="$(_p_input 'DD_SITE:' 'datadoghq.com')"
        _setup_mcp datadog \
          -e DD_API_KEY="$api" -e DD_APP_KEY="$app" -e DD_SITE="$site" \
          -- npx -y @datadog/mcp-server@latest
        _setup_note "Datadog: if @datadog/mcp-server fails, retry with datadog-mcp-server or @ddog/mcp-server" ;;
    esac
  done
}

_setup_design() {
  local pick; pick="$(_p_select_skip "Design / whiteboard" "Excalidraw")"
  PICK_DESIGN="$pick"
  case "$pick" in
    Excalidraw) _setup_mcp excalidraw -- npx -y @cmd8/excalidraw-mcp ;;
  esac
}

_setup_secondbrain() {
  local pick; pick="$(_p_select_skip "Second brain" "Obsidian" "Notion" "Logseq" "NotebookLM")"
  PICK_BRAIN="$pick"
  case "$pick" in
    Obsidian)
      local flavor; flavor="$(_p_select "Obsidian integration" \
        "mcp-obsidian (REST API)" "obsidian-second-brain (skill)" "obsidian-claude-code-mcp (plugin + /ide)")"
      case "$flavor" in
        "mcp-obsidian"*)
          local key; _p_secret "Obsidian Local REST API key:" key
          _setup_mcp mcp-obsidian \
            -e OBSIDIAN_API_KEY="$key" -e OBSIDIAN_HOST="127.0.0.1" -e OBSIDIAN_PORT="27124" \
            -- uvx mcp-obsidian
          PICK_BRAIN="Obsidian (mcp-obsidian)" ;;
        "obsidian-second-brain"*)
          _setup_guided "obsidian-second-brain is a skill installer (run in a sandbox session — hooop open):" \
            "curl -fsSL https://raw.githubusercontent.com/eugeniughelbur/obsidian-second-brain/main/scripts/quick-install.sh | bash" \
            "then run /obsidian-init in the same session"
          PICK_BRAIN="Obsidian (skill)"
          _setup_note "Obsidian skill: run the quick-install script + /obsidian-init" ;;
        *)
          _setup_guided "obsidian-claude-code-mcp is Obsidian-side + /ide (not scriptable):" \
            "install the 'Claude Code MCP' community plugin in Obsidian, enable it," \
            "then run 'claude' and '/ide' → pick Obsidian"
          PICK_BRAIN="Obsidian (/ide)"
          _setup_note "Obsidian /ide: enable the community plugin, then /ide in a session" ;;
      esac ;;
    Notion)
      local path; path="$(_p_select "Notion integration" "Official MCP (HTTP)" "Official plugin")"
      case "$path" in
        "Official MCP (HTTP)")
          if _setup_mcp notion --transport http https://mcp.notion.com/mcp; then
            _setup_queue_login notion
            _setup_note "Notion: OAuth sign-in runs at the end of setup."
          fi ;;
        *)
          _setup_guided "Notion plugin — run in a sandbox session, then /mcp OAuth:" \
            "/plugin marketplace add makenotion/claude-code-notion-plugin" \
            "/plugin install claude-code-notion-plugin@makenotion" "/mcp  → complete OAuth"
          _setup_note "Notion: finish plugin install + /mcp OAuth in a session" ;;
      esac ;;
    Logseq)
      local token; _p_secret "Logseq API token:" token
      _setup_mcp mcp-logseq \
        -e LOGSEQ_API_TOKEN="$token" -e LOGSEQ_API_URL="http://localhost:12315" \
        -- uv run --with mcp-logseq mcp-logseq
      _setup_note "Logseq: the Logseq HTTP server must be running for the MCP to work" ;;
    NotebookLM)
      _setup_guided "NotebookLM (run in a sandbox session — hooop open; pipx is baked into the image):" \
        "pipx install notebooklm-mcp-cli && nlm setup add claude-code" \
        "then 'nlm login' (browser/code flow) when you're ready"
      _setup_note "NotebookLM: in a sandbox session — pipx install + 'nlm login' (auth is a separate one-time step)" ;;
  esac
}

# Per-component telemetry isolation — only the deterministic, known opt-outs.
# The old wizard's "discover an UNKNOWN tool's telemetry host" is LLM work; we
# ship the known table + the manual HOOOP_OTEL_COLLECTOR_URL escape hatch.
_setup_telemetry_components() {
  grep -q '^HOOOP_DISABLE_TELEMETRY=1' "$HS_ENV_FILE" 2>/dev/null || return 0
  case "$PICK_CODEGRAPH" in
    Serena) hooop_stack_set_env SERENA_USAGE_REPORTING false
            hooop_stack_blackhole_host oraios-software.de ;;
  esac
  case "$PICK_N8N" in
    Yes*) hooop_stack_set_env N8N_DIAGNOSTICS_ENABLED false ;;
  esac
  _info "telemetry: master switch + known opt-outs applied. For a tool not covered here,"
  _info "  blackhole its host manually: add HOOOP_OTEL_COLLECTOR_URL=host to $HS_ENV_FILE"
}

# Escape a value for use as a sed replacement (RHS): backslash, the `|`
# delimiter, and `&` (whole-match ref) — free-text identity fields like a
# company "AT&T" would otherwise corrupt the output.
_sed_rep() { printf '%s' "${1:-}" | sed -e 's/[\\&|]/\\&/g'; }

_setup_write_profile() {
  local tmpl="$SETUP_TEMPLATES/profile.md.tmpl" out="$HS_SANDBOX_STATE/profile.md"
  [ -f "$tmpl" ] || { _setup_note "profile.md template missing — skipped"; return 0; }
  local cj="$HS_SANDBOX_PROFILE/.claude.json" name email company role github gh_json gh_login
  # GitHub identity. This is ONLY available after `gh auth login` ran in
  # _setup_auth — which is exactly why the whole profile block runs after auth.
  # Best-effort: empty JSON if gh isn't signed in, so fields fall back cleanly.
  gh_json="$(_hs_exec_sandbox gh api user 2>/dev/null || true)"
  gh_login="$(printf '%s' "$gh_json" | jq -r '.login // empty' 2>/dev/null)"
  # Name: GitHub's profile carries the FULL name, whereas Claude's
  # oauthAccount.displayName is frequently just the first name — so prefer gh
  # .name, then fall back to Claude's displayName/email.
  name="$(printf '%s' "$gh_json" | jq -r '.name // empty' 2>/dev/null)"
  [ -z "$name" ] && name="$(jq -r '.oauthAccount.displayName // .oauthAccount.emailAddress // empty' "$cj" 2>/dev/null)"
  # Email/company: Claude's account is the better source (real account email),
  # then fall back to the gh public profile.
  email="$(jq -r '.oauthAccount.emailAddress // empty' "$cj" 2>/dev/null)"
  [ -z "$email" ] && email="$(printf '%s' "$gh_json" | jq -r '.email // empty' 2>/dev/null)"
  company="$(jq -r '.oauthAccount.organizationName // empty' "$cj" 2>/dev/null)"
  [ -z "$company" ] && company="$(printf '%s' "$gh_json" | jq -r '.company // empty' 2>/dev/null)"
  github="${gh_login:+@${gh_login}}"; github="${github:-not signed in}"
  # When there's no Claude/gh login to derive identity from (e.g. setup ran
  # without signing in), the fields above are empty — ask so profile.md isn't
  # left blank. Only the ones login didn't already fill are prompted. Guarded by
  # a TTY check: the non-interactive default path can run head-less (e.g. from
  # `hooop install` in CI), where a blocking `read` would hang — fall back to the
  # "(not provided)" markers below instead.
  if [ -t 0 ]; then
    [ -z "$name" ]    && name="$(_p_input 'Your name for the profile (optional):')"
    [ -z "$email" ]   && email="$(_p_input 'Your work email for the profile (optional):')"
    [ -z "$company" ] && company="$(_p_input 'Your company / org for the profile (optional):')"
  fi
  # Neither gh nor Claude expose a job title/role, so we never ask for one —
  # default to a neutral marker.
  role="Human"
  # Never render a blank value — fall back to an explicit marker.
  name="${name:-(not provided)}"; email="${email:-(not provided)}"; company="${company:-(not provided)}"
  local langs="${PICK_LANGS:-(not asked)}"
  sed \
    -e "s|{{SETUP_DATE}}|$(date -u +%Y-%m-%d)|g" \
    -e "s|{{NAME}}|$(_sed_rep "$name")|g" \
    -e "s|{{EMAIL}}|$(_sed_rep "$email")|g" \
    -e "s|{{ROLE}}|$(_sed_rep "$role")|g" \
    -e "s|{{COMPANY}}|$(_sed_rep "$company")|g" \
    -e "s|{{GITHUB}}|$(_sed_rep "$github")|g" \
    -e "s|{{CWD}}|$(_sed_rep "$(pwd)")|g" \
    -e "s|{{LANGUAGES}}|$(_sed_rep "$langs")|g" \
    -e "s|{{MEMORY}}|${PICK_MEMORY:-skipped}|g" \
    -e "s|{{CODE_GRAPH}}|${PICK_CODEGRAPH:-skipped}|g" \
    -e "s|{{N8N}}|${PICK_N8N:-skipped}|g" \
    -e "s|{{PLATFORM}}|${PICK_PLATFORM:-skipped}|g" \
    -e "s|{{DOCS_RAG}}|${PICK_DOCSRAG:-skipped}|g" \
    -e "s|{{OBSERVABILITY}}|${PICK_OBS:-skipped}|g" \
    -e "s|{{DESIGN}}|${PICK_DESIGN:-skipped}|g" \
    -e "s|{{SECOND_BRAIN}}|${PICK_BRAIN:-skipped}|g" \
    "$tmpl" > "$out" 2>/dev/null && _info "wrote $out" || _setup_note "failed to render profile.md"
}

_setup_write_log() {
  local out="$HS_SANDBOX_STATE/install-log.md" tmpl="$SETUP_TEMPLATES/install-log.md.tmpl"
  [ -f "$out" ] || { [ -f "$tmpl" ] && cp "$tmpl" "$out" 2>/dev/null || printf '# hooop install log\n' > "$out"; }
  {
    printf '\n## Run: %s (hooop setup)\n\n' "$(date -u '+%Y-%m-%d %H:%M:%S') UTC"
    printf '**Choices:**\n'
    printf -- '- Telemetry: %s\n' "$PICK_TELEMETRY"
    printf -- '- Memory: %s\n' "${PICK_MEMORY:-skip}"
    printf -- '- Code graph: %s\n' "${PICK_CODEGRAPH:-skip}"
    printf -- '- n8n: %s\n' "${PICK_N8N:-skip}"
    printf -- '- Platform: %s\n' "${PICK_PLATFORM:-skip}"
    printf -- '- Docs RAG: %s\n' "${PICK_DOCSRAG:-skip}"
    printf -- '- Semantic search: %s\n' "${PICK_SEMANTIC:-skip}"
    printf -- '- Observability: %s\n' "${PICK_OBS:-skip}"
    printf -- '- Design: %s\n' "${PICK_DESIGN:-skip}"
    printf -- '- Second brain: %s\n' "${PICK_BRAIN:-skip}"
    printf '\n**Commands executed:**\n'
    printf '%s' "${SETUP_CMDLOG:-- (none)
}"
    printf '\n**Errors / notes:**\n%s%s' "${SETUP_ERRORS:-}" "${SETUP_NOTES:-- none}"
    printf '\n'
  } >> "$out"
  _info "appended audit entry to $out"
}

_setup_summary() {
  cat >&2 <<EOF

  ${_B}hooop setup complete.${_RST}

  Memory:        ${PICK_MEMORY:-skipped}
  Code graph:    ${PICK_CODEGRAPH:-skipped}
  n8n:           ${PICK_N8N:-skipped}
  Platform:      ${PICK_PLATFORM:-skipped}
  Docs RAG:      ${PICK_DOCSRAG:-skipped}
  Semantic:      ${PICK_SEMANTIC:-skipped}
  Observability: ${PICK_OBS:-skipped}
  Design:        ${PICK_DESIGN:-skipped}
  Second brain:  ${PICK_BRAIN:-skipped}

  Audit trail: $HS_SANDBOX_STATE/install-log.md
EOF
  [ -n "$SETUP_ERRORS" ] && printf '\n  %s✘ Some installs failed:%s\n%s' "$_RD" "$_RST" "$SETUP_ERRORS" >&2
  [ -n "$SETUP_NOTES" ]  && printf '\n  %sManual follow-ups:%s\n%s' "$_YL" "$_RST" "$SETUP_NOTES" >&2

  if ! _hs_sandbox_authenticated; then
    printf '\n  %sNext: authenticate the sandbox (one-time):%s  hooop login\n' "$_B" "$_RST" >&2
  fi
  printf '\n  Restart so new MCPs load:  hooop sandbox restart\n' >&2
  if _p_confirm "Launch the dashboard now (http://localhost:$HS_PORT/)?" y; then
    _prog_run "Building the dashboard + starting the stack" hooop_stack_start all
    _setup_handoff_banner
  else
    printf '  Run `hooop start` any time.\n' >&2
  fi
}

# =============================================================================
# Non-interactive default stack (`hooop setup` with no flags / positionals).
#
# The one-liner path: `hooop install` chains straight into this. It installs an
# opinionated default set with ZERO menus — claude-mem, Serena, Context7 (free),
# semantic search via Docker Model Runner, the GitHub CLI, and telemetry
# isolation — then (if a TTY is present) runs the sign-ins and starts the stack.
# Everything else (n8n, other platform MCPs, observability, design, second-brain)
# stays off; reach it with `hooop setup --wizard` or `hooop setup <section>`.
# =============================================================================

# Code-graph default: Serena (no language questionnaire).
_setup_defaults_codegraph() {
  PICK_CODEGRAPH="Serena"; PICK_LANGS="(default)"
  _setup_serena
}

# Docs RAG default: Context7 anonymous free tier (no API key).
_setup_defaults_docsrag() {
  PICK_DOCSRAG="Context7 (free tier)"
  _setup_mcp context7 -- npx -y @upstash/context7-mcp@latest
}

# Semantic-search default: Docker Model Runner, wired non-interactively. Never
# blocks — if DMR is already serving with the model pulled we use it as-is; else
# we try to enable it (Docker Desktop) and defer the model pull to `hooop start`
# via the compose `models:` override; if DMR can't be brought up we fall back to
# BM25 with a note. Mirrors _setup_semantic's DMR branch minus the prompts.
_setup_defaults_semantic() {
  if curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1 \
     && docker model ls 2>/dev/null | grep -q 'nomic-embed-text-v1.5'; then
    hooop_stack_unset_env EMBEDDING_BASE_URL EMBEDDING_MODEL OPENAI_API_KEY HOOOP_EMBED_HOSTED_CONSENT
    hooop_stack_set_env EMBED_DIM 768
    hooop_stack_write_dmr_model "ai/nomic-embed-text-v1.5"
    PICK_SEMANTIC="Docker Model Runner"
    _info "Docker Model Runner ready — added ai/nomic-embed-text-v1.5 to the compose stack; semantic search auto-enables."
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1 \
      || docker desktop enable model-runner --tcp 12434 >/dev/null 2>&1 || true
    if curl -fsS --connect-timeout 1 "$HS_DMR_PROBE_URL" >/dev/null 2>&1; then
      hooop_stack_unset_env EMBEDDING_BASE_URL EMBEDDING_MODEL OPENAI_API_KEY HOOOP_EMBED_HOSTED_CONSENT
      hooop_stack_set_env EMBED_DIM 768
      hooop_stack_write_dmr_model "ai/nomic-embed-text-v1.5"
      PICK_SEMANTIC="Docker Model Runner"
      _info "enabled Docker Model Runner (:12434) — ai/nomic-embed-text-v1.5 added to the compose stack; pulled on 'hooop start'."
      return 0
    fi
  fi
  hooop_stack_clear_dmr_model
  PICK_SEMANTIC="skipped (BM25)"
  _setup_note "Semantic search: Docker Model Runner unavailable — left BM25-only. Enable DMR, then re-run 'hooop setup model-runner'."
}

# GitHub default: queue the sandbox gh device-flow sign-in (run in _setup_auth
# when a TTY is present). GitHub is the baked `gh` CLI — no `claude mcp add`.
_setup_defaults_github() {
  SETUP_AUTH_GH=1
  PICK_PLATFORM="GitHub (gh)"
  _info "GitHub: queued the sandbox 'gh' device-flow sign-in for the end of setup."
}

# Telemetry default: isolate. Sets the master switch; _setup_telemetry_components
# then applies the known per-tool opt-outs (Serena etc.).
_setup_defaults_telemetry() {
  hooop_stack_set_env HOOOP_DISABLE_TELEMETRY 1
  PICK_TELEMETRY="isolated"
  _info "telemetry isolation enabled (applied on next start)."
}

# Shared "you're done" hand-off banner, printed once the stack is up. Boxed
# title + the dashboard URL + a compact stack list + next steps, with any
# errors/notes appended. Unicode box art when colour is on, ASCII otherwise
# (NO_COLOR / dumb terminals). Used by BOTH the default flow and the wizard.
_setup_handoff_banner() {
  local url="http://localhost:$HS_PORT/"
  local tl tr bl br hz vt
  if [ -n "$_B" ]; then tl='┌' tr='┐' bl='└' br='┘' hz='─' vt='│'
  else                  tl='+' tr='+' bl='+' br='+' hz='-' vt='|'; fi
  local title="  hooop is ready  " bar
  bar="$(printf '%*s' "${#title}" '' | tr ' ' "$hz")"

  # Compact stack list from the picks that actually landed.
  local -a bits=(); local b stack=""
  [ -n "$PICK_MEMORY" ]                                        && bits+=("$PICK_MEMORY")
  [ -n "$PICK_CODEGRAPH" ] && [ "$PICK_CODEGRAPH" != "n/a (non-coding)" ] && bits+=("$PICK_CODEGRAPH")
  [ -n "$PICK_DOCSRAG" ]                                       && bits+=("$PICK_DOCSRAG")
  [ -n "$PICK_SEMANTIC" ]                                      && bits+=("semantic: $PICK_SEMANTIC")
  [ -n "$PICK_PLATFORM" ]                                      && bits+=("$PICK_PLATFORM")
  [ -n "$PICK_N8N" ]                                           && bits+=("$PICK_N8N")
  [ -n "$PICK_OBS" ]                                           && bits+=("$PICK_OBS")
  [ -n "$PICK_DESIGN" ]                                        && bits+=("$PICK_DESIGN")
  [ -n "$PICK_BRAIN" ]                                         && bits+=("$PICK_BRAIN")
  bits+=("telemetry: ${PICK_TELEMETRY}")
  for b in "${bits[@]}"; do stack+="${stack:+  ·  }$b"; done

  {
    printf '\n  %s%s%s%s%s\n' "$_AC" "$tl" "$bar" "$tr" "$_RST"
    printf '  %s%s%s%s%s%s%s%s%s\n' "$_AC" "$vt" "$_RST" "$_B$_AC" "$title" "$_RST" "$_AC" "$vt" "$_RST"
    printf '  %s%s%s%s%s\n' "$_AC" "$bl" "$bar" "$br" "$_RST"
    printf '\n  Dashboard:  %s%s%s\n' "$_B$_AC" "$url" "$_RST"
    printf '  %shooop recognizes your own machine automatically — nothing to paste.%s\n' "$_DIM" "$_RST"
    printf '\n  Stack:  %s\n' "$stack"
    printf '\n  Next:\n'
    _hs_sandbox_authenticated || \
      printf '    %s•%s hooop login             sign the sandbox in (one-time)\n' "$_CY" "$_RST"
    printf '    %s•%s hooop setup <section>   add or adjust one layer\n' "$_CY" "$_RST"
    printf '    %s•%s hooop open              a throwaway sandbox shell over any folder\n' "$_CY" "$_RST"
    printf '\n  Audit trail: %s/install-log.md\n' "$HS_SANDBOX_STATE"
    [ -n "$SETUP_ERRORS" ] && printf '\n  %s✘ Some installs failed:%s\n%s' "$_RD" "$_RST" "$SETUP_ERRORS"
    [ -n "$SETUP_NOTES" ]  && printf '\n  %sManual follow-ups:%s\n%s' "$_YL" "$_RST" "$SETUP_NOTES"
  } >&2
}

# Telemetry as ONE counted step: flip the master switch, then apply the per-tool
# opt-outs that depend on the other picks. Wrapped by _prog_run in _setup_defaults.
_setup_defaults_telemetry_all() {
  _setup_defaults_telemetry
  _setup_telemetry_components
}

# The non-interactive default flow. Installs the default stack under a numbered
# progress bar ([n/N] spinner per step), runs the sign-ins only when a TTY is
# present (so `hooop install` still succeeds head-less / in CI), writes the
# profile + audit log, brings the whole stack up, then prints the hand-off banner.
#
# The step count is fixed and every step is exactly ONE _prog_run call — even the
# "already installed" / no-op branches run inside their step — so [n/N] never
# drifts. Sign-ins + profile/log writes aren't spinner steps (interactive /
# instant), so they sit between the counted steps.
_setup_defaults() {
  _info "hooop setup — installing the default stack (no menus). Use 'hooop setup --wizard' to choose each layer."
  _prog_begin 8
  _prog_run "Preparing the sandbox (first run builds the image ~2-3 min)" _setup_bootstrap || { _prog_end; return 1; }
  _prog_run "Installing claude-mem (memory)"   _setup_memory
  _prog_run "Installing Serena (code-graph)"   _setup_defaults_codegraph
  _prog_run "Installing Context7 (docs)"       _setup_defaults_docsrag
  _prog_run "Configuring semantic search"      _setup_defaults_semantic
  _prog_run "Enabling GitHub access"           _setup_defaults_github
  _prog_run "Applying telemetry isolation"     _setup_defaults_telemetry_all
  if [ -t 0 ]; then
    _setup_auth
  else
    _setup_note "Sign-in skipped (no TTY): run 'hooop login' to authenticate the sandbox; for GitHub, run 'gh auth login --web' inside 'hooop open'."
  fi
  _setup_write_profile
  _setup_write_log
  _prog_run "Building the dashboard + starting the stack" hooop_stack_start all
  _prog_end
  _setup_handoff_banner
}

# =============================================================================
# Selective sections (`hooop setup <section> [<section>…]`).
#
# Runs ONLY the named wizard steps, interactively, in the order given — for
# reconfiguring one layer without the whole wizard. Bootstraps first, completes
# any sign-ins a selected step queued, then writes the profile + audit log.
# =============================================================================

# Map a section token (canonical or alias) to its step function, or empty if
# unknown. Kept as a function so both the runner and validation share it.
_setup_section_fn() {
  case "$1" in
    code-graph|codegraph)  echo _setup_codegraph ;;
    automation|n8n)        echo _setup_n8n ;;
    mcps|platform)         echo _setup_platform ;;
    rag|docs)              echo _setup_docsrag ;;
    model-runner|semantic) echo _setup_semantic ;;
    telemetry)             echo _setup_telemetry ;;
    observability|obs)     echo _setup_observability ;;
    design)                echo _setup_design ;;
    second-brain|brain)    echo _setup_secondbrain ;;
    memory)                echo _setup_memory ;;
    *)                     echo "" ;;
  esac
}

_setup_sections() {
  # Resolve + validate every token up front so a typo aborts before we touch the
  # sandbox (no half-run).
  local tok fn; local -a fns=()
  for tok in "$@"; do
    fn="$(_setup_section_fn "$tok")"
    [ -n "$fn" ] || _die "unknown setup section: '$tok' (valid: code-graph automation mcps rag model-runner telemetry observability design second-brain memory)"
    fns+=("$fn")
  done
  _setup_bootstrap || return 1
  local ran_telemetry=false
  for fn in "${fns[@]}"; do
    "$fn"
    [ "$fn" = "_setup_telemetry" ] && ran_telemetry=true
  done
  # Telemetry's per-tool opt-outs depend on other picks, so apply them after the
  # selected steps ran (only meaningful if telemetry isolation is/was enabled).
  $ran_telemetry && _setup_telemetry_components
  # Finish any sign-ins a selected section queued (platform/observability/brain
  # OAuth, GitHub device flow). Skipped when nothing needs auth.
  if [ -n "${SETUP_AUTH_MCP:-}" ] || [ -n "${SETUP_AUTH_GH:-}" ]; then
    _setup_auth
  fi
  _setup_write_profile
  _setup_write_log
  printf '\n  %shooop setup complete — sections: %s%s\n' "$_B" "$*" "$_RST" >&2
  [ -n "$SETUP_ERRORS" ] && printf '\n  %s✘ Some installs failed:%s\n%s' "$_RD" "$_RST" "$SETUP_ERRORS" >&2
  [ -n "$SETUP_NOTES" ]  && printf '\n  %sManual follow-ups:%s\n%s' "$_YL" "$_RST" "$SETUP_NOTES" >&2
  printf '\n  Restart so new MCPs load:  hooop sandbox restart\n' >&2
}

# DESTRUCTIVE full reset (--reset-first). Returns the stack + host state to a
# blank slate — as if the repo were freshly cloned and only the CLI installed:
#   • stops + removes containers, the compose network, and the hooop-run volume
#   • removes the built images (hooop-sandbox, hooop-dashboard) → rebuilt next start
#   • deletes the sandbox profile: Claude credentials, MCP config, installed
#     plugins & skills, chat sessions, and the events DB
#   • deletes hooop.env (embedding/telemetry/gh config) + the token/cache files
# Scoped strictly to hooop's own dirs — the HOST ~/.claude (real Claude Code) is
# never touched. Confirmed interactively; the flow then rebuilds via bootstrap.
_setup_reset() {
  cat >&2 <<EOF

  ${_RD}${_B}--reset-first: full blank slate${_RST}
  This PERMANENTLY deletes the hooop sandbox and its state, then rebuilds:
    • stop + remove containers, network, and the hooop-run volume
    • remove images hooop-sandbox / hooop-dashboard (rebuilt on next start, ~2-3 min)
    • sandbox profile — Claude credentials, MCP config, installed plugins &
      skills, chat sessions, and the events database
    • hooop.env (embedding / telemetry / gh config) + token & cache files
    • any leftover host temp files from an interrupted setup/login run
  Your host ${_B}~/.claude${_RST} (real Claude Code) is NOT touched.
EOF
  _p_confirm "Wipe everything and start from a blank slate?" n || {
    echo "  Reset cancelled — nothing was deleted." >&2; return 1
  }
  # Shared destructive teardown (containers, network, volume, images, profile,
  # hooop.env, tokens, caches) lives in lib/stack.sh so `hooop uninstall` reuses it.
  hooop_stack_purge
  _info "blank slate ready — continuing with a fresh setup."
  return 0
}

# Canonical section tokens, for validation help + tab-completion.
_SETUP_SECTIONS="code-graph automation mcps rag model-runner telemetry observability design second-brain memory"

#@flag --wizard SETUP_WIZARD "false" boolean ~ run the full interactive wizard (all menus) instead of installing the non-interactive default stack
#@flag --reset-first SETUP_RESET "false" boolean ~ wipe ALL sandbox state (profile, credentials, MCPs, plugins, skills, images) for a blank slate before configuring
#@protected ~ default entrypoint: install the default stack, or run the wizard / named sections
function _run_setup() {
  _hs_require_host || return $?
  command -v jq >/dev/null 2>&1 || _die "jq is required for setup — install: brew install jq"
  SETUP_TEMPLATES="$HS_PLUGIN_ROOT/templates"
  SETUP_CATALOG="$HS_PLUGIN_ROOT/catalog"

  # Validate any section tokens BEFORE the (destructive) reset, so a typo can't
  # wipe all state and then abort. _setup_sections re-checks defensively.
  local _t
  for _t in "$@"; do
    [ -n "$(_setup_section_fn "$_t")" ] || _die "unknown setup section: '$_t' (valid: $_SETUP_SECTIONS)"
  done

  # Reset (if requested) runs first in every mode; it confirms interactively and
  # degrades to "cancelled" without a TTY, so it's safe to gate here uniformly.
  if [[ "${SETUP_RESET:-false}" == true ]]; then
    _setup_reset || { echo "Exited. Re-run 'hooop setup' any time."; return 0; }
  fi

  # Mode 1 — named sections: run only those steps, interactively.
  if [[ $# -gt 0 ]]; then
    _p_require_tty || return 1
    _setup_sections "$@"
    return $?
  fi

  # Mode 2 — full interactive wizard.
  if [[ "${SETUP_WIZARD:-false}" == true ]]; then
    _p_require_tty || return 1
    _setup_consent || { echo "Exited. Re-run 'hooop setup' any time."; return 0; }
    _setup_bootstrap || return 1
    # Memory (claude-mem) isn't a prompt — install it right after the image is
    # built + the sandbox is up, before the interactive menus begin.
    _setup_memory
    _setup_telemetry
    _setup_codegraph
    _setup_n8n
    _setup_platform
    _setup_docsrag
    _setup_semantic
    _setup_observability
    _setup_design
    _setup_secondbrain
    _setup_telemetry_components
    _setup_auth
    _setup_write_profile
    _setup_write_log
    _setup_summary
    return 0
  fi

  # Mode 3 (default) — non-interactive default stack. Only the sign-in step needs
  # a TTY, and it's gated inside _setup_defaults, so this runs head-less too.
  _setup_defaults
}

# Complete section tokens + flags for `hooop setup <TAB>`. The canonical tokens
# (aliases still work when typed) are offered whenever we're not completing a
# flag value; _default_shortlist adds --wizard / --reset-first / help.
function _shortlist() {
  local last="${@: -1}"
  [[ "$last" =~ ^- ]] || echo "$_SETUP_SECTIONS"
  _default_shortlist "$@"
}

# Forward everything that isn't a built-in straight to the runner, so `hooop
# setup`, `hooop setup --wizard`, and `hooop setup <section>…` all work while
# help/shortlist/version still resolve for tab-completion + help. (`--wizard` /
# `--reset-first` are parsed out by main() before we get here, so only section
# positionals reach _run_setup.)
function _call() {
  case "${1:-}" in
    help|--help|-h|shortlist|version|--version|-V) _default_call "$@"; return ;;
  esac
  _run_setup "$@"
}

# Bootstraps the parser
main $0 "$@"
