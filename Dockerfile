# alfred — see .plan/deployment.md
#
# No build stage. The client is bundled by Bun.serve from index.html on the
# first request, inside this container, which is the same decision
# .plan/design/tech-stack.md made everywhere else: no Vite, no compile step.
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
#   src/       the server and the client it bundles
#   drizzle/   initDb() migrates from './drizzle', relative to WORKDIR
#   tsconfig   bundling happens in here, so Bun reads it at runtime
COPY src ./src
COPY drizzle ./drizzle
COPY tsconfig.json ./

# Runs as root, deliberately. The base image provides a `bun` user, but the Fly
# volume mounts at /data owned by root, and a single-tenant household app is not
# where that fight is worth having.

ARG BUILD_SHA=dev
ENV BUILD_SHA=$BUILD_SHA NODE_ENV=production
CMD ["bun", "src/server/index.ts"]
