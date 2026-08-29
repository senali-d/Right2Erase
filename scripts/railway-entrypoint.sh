#!/usr/bin/env bash
# Boot every process the control center needs, in one container, in order.
#
# This is the deployed counterpart of scripts/dev-all.sh, and it carries more
# than that script does: dev-all.sh assumes Docker Compose already brought up
# Postgres, MinIO and the billing API, whereas here they are ours to start.
#
# Two rules shape the whole file:
#
#   1. Everything binds loopback. src/postgres-executor.js and
#      src/minio-executor.js refuse any host that is not localhost, so this is
#      what lets the erasure path run at all.
#   2. NODE_ENV is never exported. Both executors also refuse to run when
#      NODE_ENV is 'production', and `next start` sets that for itself anyway -
#      so leaving it unset gives Next what it needs without disarming the MCP
#      process. Setting NODE_ENV=production on the Railway service would break
#      execution with a "sandbox-only" error and nothing else.
set -euo pipefail
cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- defaults
# Every value here is a working default, so the only variable the Railway
# service actually requires is OPENAI_API_KEY.
: "${PORT:=3000}"
: "${HOST:=0.0.0.0}"
: "${PGDATA:=/var/lib/postgresql/data}"
: "${MINIO_DATA_DIR:=/var/lib/minio}"
: "${TRUEFORGE_HOME:=/var/lib/trueforge}"
: "${OUBLIETTE_STATE_DIR:=/data/oubliette}"

: "${DATABASE_URL:=postgres://shopkart:shopkart@127.0.0.1:5432/shopkart}"
: "${MINIO_HOST:=127.0.0.1}"
: "${MINIO_PORT:=9000}"
: "${MINIO_ACCESS_KEY:=shopkart}"
: "${MINIO_SECRET_KEY:=shopkart123}"
: "${MINIO_BUCKET:=shopkart-uploads}"
: "${BILLING_URL:=http://127.0.0.1:4010}"
: "${MCP_PORT:=4011}"
: "${MCP_DB_PORT:=4012}"
: "${MCP_STORAGE_PORT:=4013}"
: "${OUBLIETTE_MCP_PORT:=4014}"
: "${TRUEFORGE_PORT:=8790}"
: "${TRUEFORGE_BASE_URL:=http://127.0.0.1:${TRUEFORGE_PORT}}"
: "${TRUEFORGE_AGENT:=oubliette-erasure}"
: "${OUBLIETTE_ENGINE:=agentic}"
: "${SEED_ACCOUNTS:=200}"

: "${OUBLIETTE_DB_PATH:=${OUBLIETTE_STATE_DIR}/oubliette.db}"
: "${OUBLIETTE_RUNS_DIR:=${OUBLIETTE_STATE_DIR}/runs}"
: "${OUBLIETTE_TRUTH_DIR:=${OUBLIETTE_STATE_DIR}/truth}"
# Deliberately *not* under OUBLIETTE_STATE_DIR. mcp/snapshot.js writes complete
# copies of a subject's personal data here and deletes them after rehearsal; a
# crash mid-rehearsal should leave that on a disk that dies with the container,
# not on the persistent volume.
: "${OUBLIETTE_SANDBOX_DIR:=/var/lib/oubliette-sandbox}"

export PORT HOST PGDATA MINIO_DATA_DIR TRUEFORGE_HOME OUBLIETTE_STATE_DIR \
  DATABASE_URL MINIO_HOST MINIO_PORT MINIO_ACCESS_KEY MINIO_SECRET_KEY \
  MINIO_BUCKET BILLING_URL MCP_PORT MCP_DB_PORT MCP_STORAGE_PORT \
  OUBLIETTE_MCP_PORT TRUEFORGE_BASE_URL TRUEFORGE_AGENT OUBLIETTE_ENGINE \
  SEED_ACCOUNTS OUBLIETTE_DB_PATH OUBLIETTE_RUNS_DIR OUBLIETTE_TRUTH_DIR \
  OUBLIETTE_SANDBOX_DIR

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

step() { echo; echo "==> $*"; }

# Poll until `cmd` succeeds. Every service below is a dependency of the next
# one, so starting them without waiting just moves the failure later.
wait_for() {
  local label=$1 attempts=$2; shift 2
  for ((i = 1; i <= attempts; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "timed out waiting for ${label} after ${attempts}s" >&2
  return 1
}

tcp_open() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# ---------------------------------------------------------------- postgres
step "postgres"
mkdir -p "$PGDATA" /var/run/postgresql
chown -R postgres:postgres "$PGDATA" /var/run/postgresql
chmod 700 "$PGDATA"

if [[ ! -s "$PGDATA/PG_VERSION" ]]; then
  # Superuser is `shopkart` so DATABASE_URL's credentials work unmodified, and
  # so this matches the POSTGRES_USER in docker-compose.yml.
  pwfile=$(mktemp)
  printf 'shopkart' > "$pwfile"
  chown postgres "$pwfile"
  su postgres -c "initdb -D '$PGDATA' -U shopkart --auth-local=trust --auth-host=scram-sha-256 --pwfile='$pwfile'"
  rm -f "$pwfile"
fi

# fsync is off on purpose: this database holds regenerated fixture data that is
# reseeded on every boot, so durability buys nothing and costs a slow seed. The
# audit trail that does need to survive is SQLite on the volume, not this.
su postgres -c "postgres -D '$PGDATA' \
  -c listen_addresses=localhost \
  -c port=5432 \
  -c unix_socket_directories=/var/run/postgresql \
  -c shared_buffers=32MB \
  -c max_connections=25 \
  -c effective_cache_size=128MB \
  -c fsync=off \
  -c synchronous_commit=off \
  -c full_page_writes=off" &
pids+=($!)
wait_for postgres 60 pg_isready -h 127.0.0.1 -p 5432 -U shopkart

su postgres -c "psql -h /var/run/postgresql -U shopkart -d postgres -tAc \
  \"SELECT 1 FROM pg_database WHERE datname='shopkart'\"" | grep -q 1 \
  || su postgres -c "createdb -h /var/run/postgresql -U shopkart shopkart"

# ------------------------------------------------------------------- minio
step "minio"
mkdir -p "$MINIO_DATA_DIR"
MINIO_ROOT_USER="$MINIO_ACCESS_KEY" MINIO_ROOT_PASSWORD="$MINIO_SECRET_KEY" \
  minio server "$MINIO_DATA_DIR" \
    --address "127.0.0.1:${MINIO_PORT}" \
    --console-address 127.0.0.1:9001 &
pids+=($!)
wait_for minio 60 curl -fsS "http://127.0.0.1:${MINIO_PORT}/minio/health/ready"

# ------------------------------------------------------------- billing-api
step "billing-api"
PORT=4010 node --max-old-space-size=48 fixture/billing-api/server.js &
pids+=($!)
wait_for billing-api 30 curl -fsS http://127.0.0.1:4010/health

# -------------------------------------------------------------------- seed
# Seeded on every boot, not just the first. The billing API keeps its customers
# in a plain in-memory Map and is populated only by seed.js posting to
# /admin/reset, so skipping the seed on a restart would leave billing empty and
# the agent would find no charges to erase. The seed is deterministic
# (faker.seed(4217) in fixture/scripts/seed.js), so re-running it restores
# byte-identical ShopKart data rather than drifting.
step "seed shopkart (${SEED_ACCOUNTS} accounts)"
npm run --silent seed

# ------------------------------------------------------- oubliette + agent
step "mcp servers"
mkdir -p "$(dirname "$OUBLIETTE_DB_PATH")" "$OUBLIETTE_RUNS_DIR" \
  "$OUBLIETTE_TRUTH_DIR" "$OUBLIETTE_SANDBOX_DIR"

# All four adapters in one process - see scripts/mcp-all.js. This is the
# process that owns both destructive executors, so NODE_ENV is stripped rather
# than merely left alone: if a platform or an operator sets it to 'production',
# the erasure path dies at the last step of the demo with 'sandbox-only', and
# `env -u` costs nothing to rule that out.
env -u NODE_ENV NODE_OPTIONS=--max-old-space-size=192 node scripts/mcp-all.js &
pids+=($!)
for port in "$MCP_PORT" "$MCP_DB_PORT" "$MCP_STORAGE_PORT" "$OUBLIETTE_MCP_PORT"; do
  wait_for "mcp :${port}" 60 tcp_open "$port"
done

# The agentic engine needs a model, and TrueForge starts with empty settings on
# every boot, so without a key there is nothing to register and no point paying
# ~200 MB for a harness that cannot answer. Falling back keeps the deployment
# useful: the deterministic engine drives the same MCP servers through the same
# approval gate, so the demo still runs end to end.
if [[ "$OUBLIETTE_ENGINE" == "agentic" && -z "${OPENAI_API_KEY:-}" ]]; then
  echo >&2
  echo "WARNING: OPENAI_API_KEY is unset - falling back to the deterministic engine." >&2
  echo "         Set it on the service to run the agentic one." >&2
  OUBLIETTE_ENGINE=deterministic
fi

if [[ "$OUBLIETTE_ENGINE" == "agentic" ]]; then
  step "trueforge"
  mkdir -p "$TRUEFORGE_HOME"
  # HOME and cwd point at a container-local directory: TrueForge keeps its own
  # SQLite session state there, and none of it is worth a slot on a 0.5 GB
  # volume. Everything Oubliette needs to remember is in its own database.
  (cd "$TRUEFORGE_HOME" && HOME="$TRUEFORGE_HOME" NODE_OPTIONS=--max-old-space-size=256 \
    exec trueforge --port "$TRUEFORGE_PORT") &
  pids+=($!)
  wait_for trueforge 120 curl -fsS "${TRUEFORGE_BASE_URL}/api/v1/settings/mcp-servers"

  # Idempotent by design (every endpoint is an upsert keyed by name), and it has
  # to run every boot because TrueForge's settings live on the container-local
  # disk that just came up empty.
  #
  # A failure here degrades rather than aborts. Crash-looping would leave no URL
  # at all, which is a worse outcome than a working demo on the fallback engine
  # and an error in the log saying why.
  step "register agent with trueforge"
  if ! node scripts/trueforge-bootstrap.mjs; then
    echo >&2
    echo "WARNING: could not register the agent - falling back to the deterministic engine." >&2
    OUBLIETTE_ENGINE=deterministic
  fi
fi
export OUBLIETTE_ENGINE
echo "engine: ${OUBLIETTE_ENGINE}"

# ----------------------------------------------------------------- web app
step "control center on ${HOST}:${PORT}"
NODE_OPTIONS=--max-old-space-size=192 npm run --silent web:start &
pids+=($!)

# Exit as soon as anything dies, so Railway restarts the container instead of
# serving a UI whose backend is gone.
wait -n
echo "a process exited - shutting the rest down" >&2
