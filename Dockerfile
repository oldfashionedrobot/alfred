# alfred — see .plan/deployment.md
#
# One build step: the client, built and code-split by `bun run build:client`
# below, and served from /app/dist. No Vite, no separate build stage.
FROM oven/bun:1.3.14-slim
WORKDIR /app

# libSQL verifies TLS when it syncs with Turso, and this image ships no root
# certificates: without this the process dies at startup with "no valid native
# root CA certificates found (0 invalid)". Established by watching it happen,
# after an earlier reading of bun's Dockerfile on `main` suggested otherwise —
# that change is newer than this pinned tag.
RUN apt-get update -qq \
    && apt-get install -qq --no-install-recommends ca-certificates \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Dependencies first, so editing a view does not reinstall them.
#
# node_modules is built HERE and never copied in. libSQL ships a native binary
# per platform — a development machine has @libsql/darwin-arm64, this image
# needs @libsql/linux-x64-gnu — so a host node_modules would put the wrong
# platform's binary on top of the right one. .dockerignore enforces that.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Everything read at runtime, and all three are load-bearing:
#   src/       the server, and the client the next step builds
#   drizzle/   initDb() migrates from './drizzle', relative to WORKDIR
#   tsconfig   the build reads it, and so does the server at runtime
COPY src ./src
COPY drizzle ./drizzle
COPY tsconfig.json ./

# The client, built here rather than bundled on the machine at its first
# request: code-split, so the notes editor is a chunk To do never loads, and
# nothing bundles on a 256 MB machine — bundling there roughly doubled the
# process. Fly builds images on its remote builder, so this never runs on the
# machine either. See src/server/client.ts and .plan/changes-v19.md.
RUN bun run build:client
ENV CLIENT_DIST=/app/dist

# Runs as root, deliberately. The base image provides a `bun` user, but the Fly
# volume mounts at /data owned by root, and a single-tenant household app is not
# where that fight is worth having.

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA NODE_ENV=production
CMD ["bun", "src/server/index.ts"]
