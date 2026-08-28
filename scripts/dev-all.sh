#!/usr/bin/env bash
# Start every process the control center needs, in one terminal.
#
# The Docker services (Postgres, MinIO, billing-api) are not started here -
# run `npm run up` or `npm run setup` first. This script owns only the Node
# processes: the four MCP servers and the Next.js dev server.
#
# All four MCP servers stay on 127.0.0.1, which is why no MCP_AUTH_TOKEN is
# required (mcp/http-transport.js only mandates one for non-loopback binds).
# The browser never calls them directly; the Next.js server does.
set -euo pipefail

cd "$(dirname "$0")/.."

pids=()
cleanup() {
  trap - EXIT INT TERM
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

start() {
  echo "starting $1"
  npm run --silent "$1" &
  pids+=($!)
}

start mcp:billing:http    # :4011
start mcp:db:http         # :4012
start mcp:storage:http    # :4013
start mcp:oubliette:http  # :4014

# Give the MCP servers a moment to bind before the UI can call them. The web
# app tolerates a refused connection (it surfaces it as an error), but starting
# in a working state makes for a better demo.
sleep 2

start web:dev             # :3000

echo
echo "control center: http://localhost:3000"
echo

# Exit as soon as any child dies, so a crashed MCP server does not leave the UI
# up and silently failing every call.
wait -n
echo "a process exited - shutting the rest down" >&2
