#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
npm run up
npm run seed
if [[ -f agent/create-agent.js ]]; then node agent/create-agent.js || {
  echo 'Agent registration skipped/failed; configure the agent SDK before registration.' >&2
  exit 1
}
fi
