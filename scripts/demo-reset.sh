#!/usr/bin/env bash
# Reset everything between demo takes.
#
# Stop `npm run dev` first: the Oubliette MCP server holds the case database
# open, so clearing it while that server is running has no effect on the
# running process - it keeps serving the old cases from its open handle.
set -euo pipefail
cd "$(dirname "$0")/.."

npm run reset

# ShopKart's reset above does not touch Oubliette's own state. Without this, a
# completed case for the demo subject survives and the UI refuses to open a
# second one for the same person - cases are permanent audit records by design.
rm -rf .oubliette/oubliette.db .oubliette/oubliette.db-wal .oubliette/oubliette.db-shm \
       .oubliette/runs .oubliette/truth .oubliette/sandbox

npm run truth
