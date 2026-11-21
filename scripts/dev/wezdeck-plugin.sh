#!/usr/bin/env bash
# wezdeck-plugin.sh — manage WezDeck plugins (wezterm-x/plugins/<id>,
# ~/.config/wezdeck/plugins/<id>).
#
#   scripts/dev/wezdeck-plugin.sh list
#   scripts/dev/wezdeck-plugin.sh disable agent-grok [--sync]
#   scripts/dev/wezdeck-plugin.sh enable agent-grok [--sync]
#   scripts/dev/wezdeck-plugin.sh doctor [<id>...]
#   scripts/dev/wezdeck-plugin.sh install|uninstall <id>
#   scripts/dev/wezdeck-plugin.sh run <id> <cli> [args...]
#
# Docs: docs/plugin-architecture.md
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [[ -z "${WEZDECK_RUNTIME_STATE_DIR:-}" ]]; then
  # shellcheck disable=SC1091
  . "$repo_root/scripts/runtime/windows-runtime-paths-lib.sh"
  if windows_runtime_detect_paths >/dev/null 2>&1 && [[ -n "${WINDOWS_RUNTIME_STATE_WSL:-}" ]]; then
    export WEZDECK_RUNTIME_STATE_DIR="$WINDOWS_RUNTIME_STATE_WSL"
  fi
fi
exec python3 "$repo_root/scripts/runtime/wezdeck_plugin.py" --repo "$repo_root" "$@"
