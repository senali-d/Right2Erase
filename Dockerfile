# Oubliette as a single container.
#
# Everything the demo needs runs here on loopback: Postgres, MinIO, the fake
# billing API, the four MCP adapters, the TrueForge harness, and the Next.js
# control center. That is not a packaging shortcut - it is what the safety code
# requires. src/postgres-executor.js and src/minio-executor.js both refuse to
# delete anything whose host is not localhost, so a split deployment across
# managed services could only be made to work by weakening the guards this
# project exists to demonstrate.
#
# Bookworm rather than Alpine: better-sqlite3 is a native module and publishes
# glibc prebuilds only, so musl would mean compiling it from source.
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive
# Set by BuildKit. The default keeps a plain `docker build` working on amd64.
ARG TARGETARCH=amd64

# postgresql-16 comes from PGDG because Debian 12 ships 15, and matching the
# version in docker-compose.yml keeps the deployed database identical to the
# one the fixture is developed against.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
      | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/pgdg.gpg] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
      > /etc/apt/sources.list.d/pgdg.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends postgresql-16 python3 make g++; \
    curl -fsSL "https://dl.min.io/server/minio/release/linux-${TARGETARCH}/minio" \
      -o /usr/local/bin/minio; \
    chmod +x /usr/local/bin/minio; \
    rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/lib/postgresql/16/bin:${PATH}"

WORKDIR /app

# Manifests first so a source-only change does not reinstall the world.
COPY package.json package-lock.json ./
COPY fixture/package.json ./fixture/
COPY web/package.json ./web/
RUN npm ci

# billing-api is deliberately not a workspace - it has its own lockfile and is
# built as a standalone image by fixture/billing-api/Dockerfile. Install it the
# same way here.
COPY fixture/billing-api/package.json fixture/billing-api/package-lock.json ./fixture/billing-api/
RUN npm ci --omit=dev --prefix ./fixture/billing-api

# Pinned, and installed at build time: `npx @truefoundry/trueforge@latest` would
# refetch the package on every cold start and make boot time depend on npm.
RUN npm install -g @truefoundry/trueforge@0.1.4

COPY . .

# `next start` sets its own NODE_ENV, so the runtime image deliberately leaves
# NODE_ENV unset - see scripts/railway-entrypoint.sh for why that matters.
RUN NODE_ENV=production npm run web:build \
    && chmod +x scripts/*.sh

ENV PGDATA=/var/lib/postgresql/data \
    MINIO_DATA_DIR=/var/lib/minio \
    TRUEFORGE_HOME=/var/lib/trueforge \
    OUBLIETTE_STATE_DIR=/data/oubliette \
    HOST=0.0.0.0 \
    PORT=3000 \
    GOMEMLIMIT=128MiB \
    GOGC=50

EXPOSE 3000
ENTRYPOINT ["/app/scripts/railway-entrypoint.sh"]
