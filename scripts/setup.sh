#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm install
npm run up
npm run seed
if [[ -n "${TRUEFORGE_SUBJECT_EMAIL:-}" ]]; then
  node agent/create-agent.js "$TRUEFORGE_SUBJECT_EMAIL"
else
  echo 'TrueForge agent is configured; set TRUEFORGE_SUBJECT_EMAIL to run an investigation.'
fi
