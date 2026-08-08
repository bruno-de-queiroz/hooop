# syntax=docker/dockerfile:1
# Dashboard image — slim Next.js standalone runtime.
#
# The dashboard owns NO claude state and runs no claude subprocesses. It talks
# to the sandbox container over a Unix domain socket. Per Phase 3 of the
# sandboxed-agent design, this image therefore drops:
#   - @anthropic-ai/claude-code (lives in the sandbox image)
#   - better-sqlite3 / sqlite-vec / openai (native deps; lived in the old
#     in-process model)
#   - python3 / make / g++ (only needed by the native deps above)
#
# Two-stage:
#   builder — Next.js build, produces .next/standalone tree.
#   runtime — Node + the standalone tree. No npm install, no compilers.
#
# Build context: `plugins/hooop/` (the parent of `dashboard/`). This lets
# us COPY both the dashboard source and the shared/ package into the image.

FROM node:24-bookworm-slim AS builder

# Install deps BEFORE copying source so the (large) npm install layer is cached
# and a source-only edit doesn't trigger a full reinstall. `shared/` is a path
# alias (@shared/*), not an npm dependency, so only package.json/lock are needed
# for install — it's copied with the source below. The --mount npm cache
# persists the download cache across builds even when this layer does bust.
WORKDIR /build/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

# Now the source. shared/ is staged next to dashboard/ so the `@shared/*` alias
# in tsconfig.json resolves to `../shared/*` exactly as in source. node_modules
# is .dockerignored, so this COPY can't clobber the freshly-installed deps.
WORKDIR /build
COPY shared ./shared
COPY dashboard ./dashboard

WORKDIR /build/dashboard
ENV NEXT_TELEMETRY_DISABLED=1
# Persist Next's build cache (.next/cache) across builds via a cache mount so
# incremental production builds reuse compiled modules instead of starting cold.
# The cache dir is NOT part of the standalone output copied to runtime, so this
# only speeds the build.
RUN --mount=type=cache,target=/build/dashboard/.next/cache npm run build

# ---- dev (HMR live-edit) ----
# Used ONLY when HOOOP_DASHBOARD_DEV=1, via the compose override the hooop CLI
# generates (cli/lib/stack.sh). That override bind-mounts the host `dashboard/`
# + `shared/` over this stage's copies and keeps the container's own
# node_modules/.next as anonymous volumes, then runs the SAME front process
# (server.mjs) — which, seeing HOOOP_DASHBOARD_DEV, spawns `next dev` (webpack
# HMR) instead of the standalone prod server. So UI edits are live without an
# image rebuild. Not referenced by the prod runtime below; it exists purely as a
# build `target`. It deliberately mirrors the builder's deps+source steps but
# STOPS before `npm run build`.
FROM node:24-bookworm-slim AS dev

# Same cloudflared install as the `runtime` stage below (kept in sync manually
# since this stage doesn't build FROM runtime) — server.mjs spawns it
# identically in dev mode, so its absence here was a `spawn cloudflared ENOENT`
# waiting to happen the first time someone tried Share while HOOOP_DASHBOARD_DEV=1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) cf_arch=amd64 ;; \
      arm64) cf_arch=arm64 ;; \
      *) echo "unsupported arch for cloudflared: $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}" \
      -o /usr/local/bin/cloudflared \
 && chmod 0755 /usr/local/bin/cloudflared \
 && /usr/local/bin/cloudflared --version \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund
WORKDIR /build
COPY shared ./shared
COPY dashboard ./dashboard
WORKDIR /build/dashboard
ENV NODE_ENV=development \
    NEXT_TELEMETRY_DISABLED=1 \
    HOOOP_DASHBOARD_DEV=1 \
    PORT=7842 \
    HOSTNAME=0.0.0.0 \
    # Bind-mounted source may arrive over a filesystem that delivers no inotify
    # events (Docker Desktop's virtiofs, or an sshfs/remote docker host), so the
    # webpack watcher would never see edits. Poll instead — the reliable choice
    # for a dev container. WATCHPACK_POLLING is honored by `next dev --webpack`.
    WATCHPACK_POLLING=true \
    HOOOP_SANDBOX_SOCKET=/var/run/hooop/sandbox.sock \
    HOOOP_SANDBOX_TOKEN_FILE=/var/run/hooop/sandbox.token \
    HOOOP_DASHBOARD_TOKEN_FILE=/var/lib/hooop/dashboard/dashboard.token
EXPOSE 7842
# Runs as root (node image default): simplest way to read the 0640 sandbox token
# and connect() the 0660 UDS in the shared hooop-run volume without the gid dance
# the slim prod image does. Fine for a local dev container.
CMD ["node", "server.mjs"]

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime

# System deps:
#   - curl: launcher healthcheck probes.
#   - cloudflared: the front process (server.mjs) spawns this on demand to
#     expose the dashboard over a public quick tunnel for peer co-drive, so the
#     host never installs or runs a tunnel themselves. Static binary pulled
#     from Cloudflare's GitHub releases, arch-matched.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) cf_arch=amd64 ;; \
      arm64) cf_arch=arm64 ;; \
      *) echo "unsupported arch for cloudflared: $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}" \
      -o /usr/local/bin/cloudflared \
 && chmod 0755 /usr/local/bin/cloudflared \
 && /usr/local/bin/cloudflared --version \
 && rm -rf /var/lib/apt/lists/*

# Shared groups with the sandbox image, same gids on both sides.
#
# `hooopctl` (1101) is the one that matters: the sandbox keeps /var/run/hooop at
# 0750 hooopd:hooopctl, so membership here is what lets `node` traverse to the
# socket and read sandbox.token (0640) while the model's `agent` uid cannot.
# `hooop` (1100) is retained because compose's `group_add` is what actually grants
# the runtime membership — this line only makes the names resolve inside the
# image — and because a dashboard talking to an older sandbox still needs it.
RUN groupadd -g 1100 hooop \
 && groupadd -g 1101 hooopctl \
 && usermod -aG hooop,hooopctl node \
 && mkdir -p /var/lib/hooop/dashboard \
 && chown -R node:node /var/lib/hooop/dashboard

WORKDIR /app

# Copy the standalone tree (server.js + minimal node_modules) and the
# .next/static assets the standalone server serves.
COPY --from=builder --chown=node:node /build/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /build/dashboard/.next/static ./.next/static
# `public/` is NOT part of the standalone output — Next expects it copied
# explicitly. It holds the service worker that receives web notifications, and
# a missing /sw.js fails only in the built image (next dev serves public/
# directly), so leaving this out would look fine locally and break in prod.
COPY --from=builder --chown=node:node /build/dashboard/public ./public

# Front process (server.mjs): reverse-proxies HTTP to the Next standalone
# server and adds the /api/ws WebSocket live channel. `ws` is a zero-dependency
# pure-JS package; it isn't traced into the standalone node_modules (the front
# isn't part of the Next build), so copy it explicitly.
COPY --from=builder --chown=node:node /build/dashboard/server.mjs ./server.mjs
# Modules the front process imports. It is NOT part of the Next build, so nothing
# traces its imports for us — every file it pulls in has to be copied by name or
# the container dies at startup with ERR_MODULE_NOT_FOUND. Keep this list in step
# with the imports at the top of server.mjs.
COPY --from=builder --chown=node:node /build/dashboard/auto-share.mjs ./auto-share.mjs
COPY --from=builder --chown=node:node /build/dashboard/tunnel-reachability.mjs ./tunnel-reachability.mjs
COPY --from=builder --chown=node:node /build/dashboard/quick-tunnel-url.mjs ./quick-tunnel-url.mjs
COPY --from=builder --chown=node:node /build/dashboard/preview-driver.mjs ./preview-driver.mjs
COPY --from=builder --chown=node:node /build/dashboard/node_modules/ws ./node_modules/ws

USER node

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=7842
ENV HOSTNAME=0.0.0.0
ENV HOOOP_SANDBOX_SOCKET=/var/run/hooop/sandbox.sock
ENV HOOOP_SANDBOX_TOKEN_FILE=/var/run/hooop/sandbox.token
ENV HOOOP_DASHBOARD_TOKEN_FILE=/var/lib/hooop/dashboard/dashboard.token

EXPOSE 7842

HEALTHCHECK --interval=10s --timeout=2s --start-period=25s --retries=3 \
  CMD curl -fsS --max-time 1 http://127.0.0.1:7842/api/health || exit 1

# The front process spawns the Next standalone server (server.js) on an
# internal port and serves the public port + /api/ws.
CMD ["node", "server.mjs"]
