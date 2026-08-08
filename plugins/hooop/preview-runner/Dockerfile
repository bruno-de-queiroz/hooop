# syntax=docker/dockerfile:1
# Preview runner image — the least privileged container in the hooop stack.
#
# Owns exactly one thing: executing a preview spec (setup steps + a long-lived
# run command) for ONE leased session, and forwarding a fixed container port to
# whatever loopback port the app chose.
#
# Deliberately absent, and each for a reason:
#   - claude, and any Claude credentials. The runner exists so agent-authored,
#     network-facing code does NOT run beside the OAuth token.
#   - ~/.claude, events.db, the sandbox control socket. Not mounted at all.
#   - a Docker socket. Slots are declared statically in compose; nothing here
#     creates containers.
#
# Build context: `plugins/hooop/` (the parent of `preview-runner/`), matching the
# sandbox and dashboard images, so `shared/` is reachable.

FROM node:24-bookworm-slim AS build
# Same npm throttle as the other images: Rancher Desktop's build-VM DNS resolver
# returns EAI_AGAIN under npm's default fetch concurrency.
ENV npm_config_maxsockets=3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
WORKDIR /build/preview-runner
COPY preview-runner/package.json preview-runner/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

WORKDIR /build
COPY shared ./shared
# The Landlock policy is SHARED with the sandbox by copy rather than by
# duplication: the supervisor confines every preview command with the same
# `wrapWithLandlock` the sandbox uses for its `!bash` fast lane, just with the
# "preview" profile. Only these two files are needed — neither pulls in any
# other sandbox module (see the imports at the top of each).
COPY sandbox/lib/landlock-policy.ts ./sandbox/lib/landlock-policy.ts
COPY sandbox/lib/cwd-policy.ts      ./sandbox/lib/cwd-policy.ts
COPY preview-runner ./preview-runner

WORKDIR /build/preview-runner
RUN npm run build

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime

ENV npm_config_maxsockets=3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# Base libs. `git` is first-class here (a spec's setup steps routinely fetch
# submodules or read version info), and the compiler toolchain backs native
# addon builds that `npm install` triggers in real projects.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gosu python3 python3-venv make g++ unzip xz-utils \
 && rm -rf /var/lib/apt/lists/*

# --- Landlock confinement wrapper -------------------------------------------
# The same setuid-free helper the sandbox uses: it applies a Landlock ruleset to
# itself, then execs the real command. Root-owned so a preview cannot rewrite
# its own confinement. HOOOP_PREVIEW_CONFINE=require below makes a missing or
# non-functional wrapper fail the preview rather than silently running it
# unconfined — an unconfined preview looks identical to a confined one from the
# outside, so this must fail closed.
COPY sandbox/landlock/hooop-sandbox-exec.c /tmp/hooop-sandbox-exec.c
RUN cc -O2 -Wall -o /usr/local/bin/hooop-sandbox-exec /tmp/hooop-sandbox-exec.c \
 && chmod 0755 /usr/local/bin/hooop-sandbox-exec \
 && rm /tmp/hooop-sandbox-exec.c

# Non-root runtime user. uid 1100 matches the sandbox's `agent` default so the
# bind-mounted workspace has consistent ownership before any HOOOP_HOST_UID
# remap; `hooopctl` (1101) is created so the entrypoint can hand the supervisor
# the group that gates the shared control socket. The unused `node` account at
# uid 1000 is removed for the same reason as the sandbox: 1000 is the default
# first-user uid on most Linux installs and would collide with the remap.
RUN userdel -r node 2>/dev/null || true \
 && groupdel node 2>/dev/null || true \
 && groupadd -g 1101 hooopctl \
 && groupadd -g 1100 runner \
 && useradd -m -u 1100 -g 1100 -s /bin/bash runner

# --- Toolchains -------------------------------------------------------------
# The spec is language-agnostic, so the image bakes the common set and provides
# `mise` for everything else. There is no cross-lease cache — every lease starts
# cold — so what is baked here is what a preview gets for free.
#
# NOTE for spec authors: the runtime user is unprivileged, so `apt-get install`
# in a setup step will NOT work. mise / uv / pip --user / corepack are the
# sanctioned ways to add a toolchain, and the MCP tool description says so.

# bun (same installer the sandbox uses).
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash \
 && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
 && chmod -R a+rx /opt/bun

# uv (same installer the sandbox uses), for Python projects.
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && uv --version

# mise: resolves a project's OWN toolchain pins (.tool-versions, .nvmrc,
# .python-version, mise.toml) so Go/Rust/Ruby/Java previews work without this
# image having to carry every runtime.
RUN curl -fsSL https://mise.run | MISE_INSTALL_PATH=/usr/local/bin/mise sh \
 && chmod 0755 /usr/local/bin/mise \
 && mise --version

# corepack activates pnpm/yarn from the project's own packageManager field.
RUN corepack enable

ENV HOME=/home/runner
ENV PATH="/home/runner/.local/bin:${PATH}"
ENV HOOOP_PREVIEW_SOCKET_DIR=/var/run/hooop-preview
ENV HOOOP_PREVIEW_SOCKET_GID=1101
ENV HOOOP_WORKSPACE_DIR=/workspace
# Fail closed if Landlock confinement can't be applied. Only meaningful where
# the helper is baked in, i.e. here; a local checkout leaves this unset.
ENV HOOOP_PREVIEW_CONFINE=require

COPY preview-runner/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /app
# Root-owned and read-only to the runtime user, for the same reason /app is in
# the sandbox: this is the process that confines the preview, and the preview
# runs as the user that would otherwise be able to rewrite it.
COPY --from=build /build/preview-runner/dist ./dist
RUN chown -R root:root /app && chmod -R a+rX /app

# The supervisor answers /health unauthenticated precisely so this works.
HEALTHCHECK --interval=10s --timeout=2s --start-period=15s --retries=3 \
  CMD curl -fsS --max-time 1 \
        --unix-socket /var/run/hooop-preview/runner-${HOOOP_PREVIEW_SLOT:-1}.sock \
        http://runner/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/dist/server.mjs"]
