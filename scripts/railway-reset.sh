#!/usr/bin/env bash
# Reset the deployed demo between takes.
#
#   railway ssh -- /app/scripts/railway-reset.sh
#
# The container reseeds ShopKart on every boot, so the only thing that survives
# a restart is Oubliette's own state on the volume - and that is exactly what
# stops a second demo: cases are permanent audit records with no delete path, so
# reopening one for a subject who already has one is refused.
#
# Clearing the files is not enough on its own. The MCP process holds
# oubliette.db open, and as scripts/demo-reset.sh already warns, it keeps
# serving the old cases from that handle. So this stops the container after
# clearing, and Railway starts a fresh one.
set -euo pipefail

: "${OUBLIETTE_STATE_DIR:=/data/oubliette}"

echo "clearing ${OUBLIETTE_STATE_DIR}"
rm -rf \
  "${OUBLIETTE_STATE_DIR}/oubliette.db" \
  "${OUBLIETTE_STATE_DIR}/oubliette.db-wal" \
  "${OUBLIETTE_STATE_DIR}/oubliette.db-shm" \
  "${OUBLIETTE_STATE_DIR}/runs" \
  "${OUBLIETTE_STATE_DIR}/truth"

echo "restarting the container - the URL is back in a minute or two"
kill 1
