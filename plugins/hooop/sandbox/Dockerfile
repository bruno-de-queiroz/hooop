# syntax=docker/dockerfile:1
# Sandboxed agent runtime image. Owns:
#   - claude binary (the only place it lives in the hooop stack)
#   - sandbox HTTP server on a Unix domain socket
#   - all session / events / spawn state under /home/agent/.claude (bind-mounted
#     from the host's ~/.claude/hooop/sandbox/)
#
# Two-stage build:
#   build  — full devDeps + esbuild bundles server.ts into dist/server.mjs.
#   runtime — production-only deps + the compiled bundle. No TS, no tsx,
#             no esbuild.
#
# Build context: `plugins/hooop/` (the parent of `sandbox/`). This lets
# us COPY both the sandbox source and the shared/ package into the image.

FROM node:24-bookworm-slim AS build
# npm fires ~15 concurrent fetches by default; Rancher Desktop's build-VM DNS
# resolver returns EAI_AGAIN under that burst, stalling `npm install` for many
# minutes of retry-backoff (looks like a hang). Throttling concurrency means
# fewer simultaneous DNS lookups; longer retries add resilience. Harmless on
# engines without the issue, so it's safe everywhere (Rancher, Docker, CI).
ENV npm_config_maxsockets=3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build/sandbox

# Install deps BEFORE copying source so the native better-sqlite3 compile is
# layer-cached. This step only re-runs when package.json / package-lock.json
# change — source-only edits no longer bust the layer and trigger a multi-minute
# recompile. node_modules is .dockerignored, so the later source COPY can't
# clobber the freshly-installed (Linux-arch) deps.
COPY sandbox/package.json sandbox/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

# Now the source. shared/ is staged alongside the sandbox tree so esbuild's
# `@shared/*` alias resolves to `../shared/*` exactly as it does in source.
WORKDIR /build
COPY shared ./shared
COPY sandbox ./sandbox

WORKDIR /build/sandbox
RUN npm run build

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime

# Same npm throttle as the build stage (ENV doesn't cross stages): applies to
# the global claude-code/gws install and the production `npm install` below.
ENV npm_config_maxsockets=3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# --- Layer ordering: stable -> volatile, so a rebuild only redoes what changed.
# Change frequency, lowest to highest:
#   base apt libs · agent user · bun · gh/uv · entrypoint   (≈never)
#   sandbox production deps (package.json)                  (rare)
#   claude-code global install ("latest")                   (refreshed often)
#   compiled server bundle (dist, from source)              (every source edit)
# The key move vs. the naive layout: claude-code sits BELOW bun/gh/uv and the
# production deps. Pulling a newer claude no longer reinstalls the toolchain or
# recompiles better-sqlite3 — only the claude layer and the dist COPY re-run.

# Base system libs (stable — rarely change; python3/make/g++ back the
# better-sqlite3 native compile in the production `npm install` below).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 make g++ gosu unzip proxychains4 \
 && rm -rf /var/lib/apt/lists/*

# --- Landlock filesystem-confinement wrapper (hooop-sandbox-exec) -----------
# Setuid-free C helper that applies a Landlock ruleset to itself, then execs
# the real command — the per-spawn OS-level confinement layer that
# lib/landlock-policy.ts (wrapWithLandlock) routes `claude`/tool spawns
# through. See sandbox/landlock/hooop-sandbox-exec.c for the full contract
# (env vars, ABI fallbacks, enforce/permissive modes).
#
# Compiled here, right after the g++ install above and before the `agent`
# user is created, so the binary is root-owned (no --chown needed) and lands
# in the same stable, rarely-changing layer group as the rest of this apt
# block — the source is tiny and self-contained (libc + linux headers only,
# no libseccomp), so recompiling it is instant even on the rare edit.
COPY sandbox/landlock/hooop-sandbox-exec.c /tmp/hooop-sandbox-exec.c
RUN cc -O2 -Wall -o /usr/local/bin/hooop-sandbox-exec /tmp/hooop-sandbox-exec.c \
 && chmod 0755 /usr/local/bin/hooop-sandbox-exec \
 && rm /tmp/hooop-sandbox-exec.c

# The shell claude spawns for its Bash tool (CLAUDE_CODE_SHELL). Root-owned
# like the wrapper above so the agent user can't rewrite its own confinement.
# The "bash" in the filename is required — claude only honours the override
# when the path contains bash/zsh.
COPY sandbox/landlock/hooop-bash /usr/local/bin/hooop-bash
RUN chmod 0755 /usr/local/bin/hooop-bash

# Non-root runtime user, created early so the volatile layers below never
# reinstall it. uid 1100 leaves room above the typical node:1000 in case both
# images run on the same host. The group `hooop` (gid 1100) is shared with the
# dashboard image: it's the handle the sandbox uses to grant the dashboard read
# access to the token file (0640) and connect access to the socket (0660).
#
# The base image ships an unused `node` user/group at uid/gid 1000 — and 1000
# is the default first-user uid on most single-user Linux/WSL installs. That
# collides with entrypoint.sh's HOOOP_HOST_UID remap (it aligns the `agent` USER
# to the HOST owner's uid before chowning the bind-mounted profile, so the host
# keeps write access to its own ~/.claude/hooop/sandbox/profile): a host uid of
# 1000 makes `usermod -u 1000 agent` fail with "UID already exists", silently
# falling back to fixed uid 1100 and leaving the host locked out of its own
# profile directory. Nothing in this image runs as `node` (the entrypoint drops
# to `agent`), so drop it here to free uid 1000 for that remap. The GROUP is not
# remapped — `hooop` stays gid 1100, the shared cross-container handle for the
# dashboard's socket/token access — so only the `node` user needs to vacate 1000
# (dropping the node group too is harmless and keeps the id space clean).
RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && groupadd -g 1100 hooop \
 && useradd -m -u 1100 -g 1100 -s /bin/bash agent

# The SERVER's own account, separate from the model's. `agent` runs claude and
# owns the bind-mounted profile; `hooopd` runs the sandbox HTTP server and owns
# the control plane (/var/run/hooop, sandbox.sock, sandbox.token).
#
# Why the split exists: with one uid there was no DAC boundary between the two
# at all. Verified on a live container — the model's uid could read the server's
# /proc/<pid>/environ and fd/, and PTRACE_ATTACH to the server succeeded, which
# is a total compromise of the host-privileged control socket regardless of how
# the token file is permissioned. Landlock and the PreToolUse path gate are both
# allow-list shaped and tool-specific; separate uids are the only tool-agnostic
# boundary.
#
# `hooopctl` (gid 1101) is the group that gates the control plane. It is hooopd's
# PRIMARY group and must NEVER become a supplementary group of the server
# process: a setuid-to-agent helper holds no capabilities, so it cannot call
# setgroups(2), and dropping the primary gid is the only way it can shed
# hooopctl before exec'ing claude. entrypoint.sh launches the server with
# `setpriv --regid hooopctl --groups <hooop>`, and hooop-as-agent re-verifies the
# invariant at runtime and refuses to exec if it was broken.
#
# hooopd is also a member of `hooop` (gid 1100) so that on Linux hosts — where
# bind-mount DAC is real, unlike macOS virtiofs — it can read the profile the
# entrypoint chowns to agent:hooop, and delete stale transcripts/session files
# in group-writable directories.
RUN groupadd -g 1101 hooopctl \
 && useradd -u 1101 -g 1101 -G hooop -M -s /usr/sbin/nologin hooopd

# The bridge back to the model's uid (hooop-as-agent) is compiled further down,
# just below the browser layers — see the block above `ENV HOME`. It needs these
# accounts to exist for its chown, but keeping it out of this stable layer group
# is deliberate: it is security-critical C that gets edited, and up here every
# edit would invalidate bun, gh, the 1 GB browser download and claude behind it.

# Bun: needed by claude-mem's background worker (and any other tool that
# bootstraps via Bun). The upstream `curl ... | bash` installer needs unzip
# and writes under $HOME; installing here under /opt/bun puts the binary on
# PATH for both the root entrypoint and the dropped-to `agent` user.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash \
 && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
 && chmod -R a+rx /opt/bun

# --- Extra CLI tooling for /hooop:setup (gh, uv, pipx) ---
# Kept high (rarely changes) and ABOVE the claude-code install so a claude bump
# never rebuilds it.
#   - pipx: NotebookLM (`pipx install notebooklm-mcp-cli`) and other Python MCPs.
#   - gh:   the GitHub option wires `gh` into the sandbox; auth via GH_TOKEN
#           (forwarded by the launcher from the host's chosen account) at runtime.
#   - uv:   Serena (`uv tool install`) and mcp-obsidian (`uvx`).
RUN apt-get update \
 && apt-get install -y --no-install-recommends pipx \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && gh --version
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && uv --version

# --- In-container browser automation (headless) ------------------------------
# @playwright/mcp gives the agent navigate/screenshot/click/snapshot tools,
# driven by a headless Chromium that runs INSIDE this sandbox as the
# unprivileged `agent` user — no host process, no host networking, no version
# drift (the browser we bake matches the exact playwright-core the MCP loads,
# because both come from this one pinned install). entrypoint.sh registers the
# MCP in the mounted profile via `claude mcp add`, so `hooop open` and the
# dashboard sandbox both get it, using PLAYWRIGHT_MCP_CLI below.
#
# Version is pinned (single source of truth) for reproducible builds. NOTE:
# every @playwright/mcp release pins a pre-release ("-alpha") playwright build —
# that's upstream's choice, not ours; pinning the MCP version pins that browser
# transitively. Bump PLAYWRIGHT_MCP_VERSION deliberately.
#
# Kept high + pinned (rarely changes) so a claude-code bump below never
# re-downloads Chromium. Browsers land in a shared, world-readable path so the
# `agent` user can read them at runtime; PLAYWRIGHT_BROWSERS_PATH pins it for
# both the build install and the runtime MCP. Skip the npm-postinstall browser
# download (it would fetch all engines) and install ONLY chromium --with-deps
# (apt system libs, root at build time). The browser download is a single large
# CDN fetch — retry it a few times so a transient blip doesn't fail the build.
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ENV PLAYWRIGHT_MCP_CLI=/opt/playwright-mcp/node_modules/@playwright/mcp/cli.js
RUN mkdir -p /opt/playwright-mcp \
 && cd /opt/playwright-mcp \
 && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && { node node_modules/playwright/cli.js install --with-deps chromium \
      || { echo "browser install failed; retry 1/2 in 5s..."; sleep 5;  node node_modules/playwright/cli.js install --with-deps chromium; } \
      || { echo "browser install failed; retry 2/2 in 10s..."; sleep 10; node node_modules/playwright/cli.js install --with-deps chromium; }; } \
 && chmod -R a+rX /opt/playwright-mcp /opt/ms-playwright \
 && rm -rf /var/lib/apt/lists/*

# The bridge back to the model's uid. Everything that must BELONG to the model
# — the claude process, `git clone`, the dashboard's `!bash` fast lane, session
# workdirs — is launched by the hooopd server through this helper, and it is also
# how the server signals claude (kill(2) permission is not inherited from the
# parent/child relationship, so hooopd cannot signal its own agent-uid child).
#
# setuid to `agent`, NOT to root: the ceiling is exactly the privilege the model
# already has, so a bug here is not root-equivalent the way a cap_setuid helper
# or CAP_SETUID on the long-lived Node process would be. Mode 6750 agent:hooop —
# the setgid bit is load-bearing (it supplies the egid the helper switches to),
# and group `hooop` is what lets hooopd exec it while other uids cannot.
#
# Placed HERE, below the browser/claude layers rather than up with the accounts it
# chowns to: this is security-critical C that actually gets edited, and compiling
# it in the stable group above meant every one-line change re-ran bun, gh, a 1 GB
# browser download and the claude install. Nothing below this point is expensive.
#
# entrypoint.sh re-applies this owner+mode after the HOOOP_HOST_UID remap, since
# remapping `agent` leaves the baked 1100 ownership stale — and a stale owner
# makes the helper fail closed (exit 125) rather than silently run claude as hooopd.
COPY sandbox/landlock/hooop-as-agent.c /tmp/hooop-as-agent.c
RUN cc -O2 -Wall -o /usr/local/bin/hooop-as-agent /tmp/hooop-as-agent.c \
 && chown agent:hooop /usr/local/bin/hooop-as-agent \
 && chmod 6750 /usr/local/bin/hooop-as-agent \
 && rm /tmp/hooop-as-agent.c

ENV HOME=/home/agent
# pipx/uv tools the agent installs at runtime land in the bind-mounted profile
# (~/.local/bin) — keep it on PATH so `pipx install`-ed tools (e.g. NotebookLM)
# resolve for the agent user.
ENV PATH="/home/agent/.local/bin:${PATH}"
ENV HOOOP_SANDBOX_SOCKET=/var/run/hooop/sandbox.sock
# The hook listener's socket. Container-local (never on the shared volume), and
# the only one the model's process tree is told about — the server rewrites
# HOOOP_SANDBOX_SOCKET to this value in the claude child's env, so the hook
# scripts reach it without knowing the listeners were split.
ENV HOOOP_HOOK_SOCKET=/run/hooop-hooks/hook.sock
# The hook token moves off the bind-mounted profile and next to the hook socket.
# Not cosmetic: on macOS Docker Desktop the profile is virtiofs, which does NOT
# enforce DAC — any uid in the container can read a 0600 file there (measured) —
# whereas this container-local path is real overlayfs where the modes bite.
ENV HOOOP_HOOK_TOKEN_FILE=/run/hooop-hooks/hook.token
# Group ownership for the two planes, one gid each. Control = hooopctl, which the
# model's uid is NOT in and the dashboard joins via `group_add`. Hook = hooop,
# which the model IS in, because permission-gate.sh and emit-event.sh run as
# agent and must reach the hook socket and read the hook token.
ENV HOOOP_CONTROL_SOCKET_GID=1101
ENV HOOOP_HOOK_SOCKET_GID=1100
# The helper the server routes agent-side work through. Env-overridable for the
# same reason as HOOOP_SANDBOX_EXEC: a local checkout has no such binary.
ENV HOOOP_AS_AGENT=/usr/local/bin/hooop-as-agent
# Confine the model's Bash tool (CLAUDE_CODE_SHELL -> hooop-bash -> Landlock),
# and REFUSE to start a session if that can't be applied. "require" only makes
# sense where the helper binaries are baked in, i.e. here — a local checkout
# leaves this unset and runs unconfined. Fail-closed matters because claude
# silently falls back to shell auto-detection when CLAUDE_CODE_SHELL doesn't
# resolve, so an unconfined session is otherwise indistinguishable from a
# confined one.
#
# Applies to DASHBOARD sessions, which is where the CMD below leads. `hooop open`
# runs this same image but overrides CMD with `claude` directly and passes
# HOOOP_BASH_CONFINE=off — deliberately, since it has no sandbox server, no
# control-plane socket and no sibling sessions to protect. See cli/modules/open.sh.
ENV HOOOP_BASH_CONFINE=require

# Entrypoint runs as root to chown the bind-mounted ~/.claude dir, then drops to
# `agent` via gosu. Copied among the stable layers (above deps/claude/dist) so a
# source edit never re-runs this step.
COPY sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Node profile-seeder run by the entrypoint on every boot (idempotent). Ports
# the former host-side jq wiring into the container so the HOST needs no jq —
# see sandbox/seed-profile.mjs. Stable layer alongside the entrypoint.
COPY sandbox/seed-profile.mjs /usr/local/lib/hooop/seed-profile.mjs

WORKDIR /app

# Production deps only; build deps stay in the build stage. Rare to change
# (three pinned deps), so it's cached above claude-code — a claude bump keeps
# this native better-sqlite3 compile. Cache-mounted npm dir; chown once here so
# it isn't re-run by the volatile layers below.
COPY sandbox/package.json sandbox/package-lock.json* ./
# Left root-owned, world-readable/executable — NOT agent-owned. /app holds the
# sandbox server that enforces the permission gate, and the agent user is the
# one it enforces against: an agent-writable /app means the model can rewrite
# `dist/server.mjs` (or anything under node_modules) and own the next boot of
# the very process that is supposed to contain it. Same reasoning as the
# root-owned /opt/hooop hook scripts below. The server runs as agent and only
# ever READS /app, so read+execute is sufficient.
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund \
 && chown -R root:root /app \
 && chmod -R a+rX /app

# Global node CLIs, always latest: claude-code (the only place it lives in the
# hooop stack) + the googleworkspace-cli (used when the GWS layer is enabled in
# /hooop:setup). Deliberately LOW so refreshing them re-runs only this layer plus
# the dist COPY below — not bun, gh, uv, or the deps compile. Cache-mounted so
# the download is reused even when the layer busts.
RUN --mount=type=cache,target=/root/.npm npm install -g @anthropic-ai/claude-code @googleworkspace/cli

# `git` is a first-class runtime dependency: session creation clones repos and
# the dashboard's Files navigator reads `git status`/`git diff`. The
# node:*-slim base does NOT ship git — it was previously only present
# transitively (via another apt chain), which is fragile. Declared explicitly
# and kept LOW in the layer stack so it never busts the expensive Chromium /
# deps / claude layers above; only the plugin + dist copies below re-run.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/* \
 && git --version

# --- hooop plugin surface, BAKED IN (self-contained; no host bind-mount) ------
# The sandbox loads /opt/hooop as a claude `--plugin-dir` (HOOOP_PLUGIN_ROOT):
# it supplies the .mcp.json "tools" server (mcp/tools-server.mjs) and the
# event/permission hook scripts the seeded settings.json points at
# (hooks/scripts/*.sh). Baking it — vs. the old read-only bind-mount of the host
# repo — makes the image runnable on a host that has neither the repo at a fixed
# path nor Claude Code installed.
#
# We bake ONLY what the in-sandbox claude actually consumes: the plugin manifest,
# the tools MCP server, and the hooks. Deliberately NOT baked:
#   - commands/  — the hooop slash commands (setup/dashboard/add/mount) drive the
#                  host stack; inside the sandbox they're meaningless (and would
#                  be surfaced by the dashboard's command browser). `/plan` is a
#                  sandbox builtin (see lib/commands.ts), not the plugin command.
#   - agents/    — stack-doctor diagnoses the HOST install; no use in-sandbox.
#   - catalog/, templates/ — read only by `hooop setup`, which runs on the
#                  HOST from HOOOP_PLUGIN_ROOT (the plugin package), never here.
# (HOOOP_PLUGIN_DEV=1 still overlays the full host repo for live plugin dev.)
#
# Left root-owned (no --chown): the agent user (uid 1100) can't modify the hook
# scripts — the same posture `read_only: true` gave — while the files stay
# world-readable/executable so the agent can read the plugin and exec the hooks.
COPY .claude-plugin /opt/hooop/.claude-plugin
COPY .mcp.json      /opt/hooop/.mcp.json
COPY hooks          /opt/hooop/hooks
COPY mcp            /opt/hooop/mcp

# Compiled server bundle — changes on every source edit, so it's the last
# content layer. Root-owned like the rest of /app above (COPY defaults to
# root:root): the agent user must not be able to rewrite the server it runs
# under. Readable by all, which is all the server needs.
COPY --from=build /build/sandbox/dist ./dist

# start-period: 30s — the image bakes in @anthropic-ai/claude-code,
# @googleworkspace/cli, bun, and proxychains4; first-boot startup creeps up
# toward ~15s. A 5s grace period made `compose up --build` race the
# dashboard's depends_on: service_healthy gate. 30s gives the sandbox room
# without slowing steady-state restarts (interval+retries unchanged).
HEALTHCHECK --interval=5s --timeout=2s --start-period=30s --retries=3 \
  CMD curl -fsS --max-time 1 \
        --unix-socket /var/run/hooop/sandbox.sock \
        http://sandbox/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/dist/server.mjs"]
