#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "${ROOT}/server/node_modules" ] || [ ! -d "${ROOT}/web/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "${ROOT}" && npm install)
fi

echo "Starting WaitShare API on :3001 and web dashboard on :5173"

cleanup() {
  echo ""
  echo "Shutting down WaitShare..."
  kill "${BACKEND_PID}" 2>/dev/null || true
  kill "${FRONTEND_PID}" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

(cd "${ROOT}/server" && npm run dev) &
BACKEND_PID=$!

(cd "${ROOT}/web" && npm run dev) &
FRONTEND_PID=$!

wait
