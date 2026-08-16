#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLI="$REPO_DIR/clients/claude-code/waitshare.mjs"
SETTINGS="${HOME}/.claude/settings.json"

if [ ! -f "${HOME}/.waitshare/config.json" ]; then
  echo "First configure your account:"
  echo "  node ${REPO_DIR}/clients/shared/setup.mjs"
  echo "Then re-run this installer."
  exit 1
fi

if [ -f "$SETTINGS" ] && [ ! -f "${SETTINGS}.waitshare.bak" ]; then
  cp "$SETTINGS" "${SETTINGS}.waitshare.bak"
  echo "Backed up settings to ${SETTINGS}.waitshare.bak"
fi

node "${REPO_DIR}/clients/claude-code/patch-settings.mjs" "$CLI" "$SETTINGS"
echo "Claude Code status line + hooks installed."
echo "Restart Claude Code for changes to take effect."
echo "Restore with: node ${REPO_DIR}/clients/claude-code/patch-settings.mjs --restore \"$SETTINGS\""
