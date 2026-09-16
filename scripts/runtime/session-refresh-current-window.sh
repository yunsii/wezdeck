#!/usr/bin/env bash
# F5 / session.refresh-current-window hotkey entry (tmux User3).
#
# WezTerm forwards `\e[20102~` here (see manifest `session.refresh-current-window`).
# Wraps tmux-reset refresh-current-window with a status toast so the hotkey
# path matches the palette success/failure messages.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="session-refresh-current-window.sh"

usage() {
  echo "usage: $0 <session-name> <window-id> [cwd]" >&2
  exit 2
}

session_name="${1-}"
window_id="${2-}"
cwd="${3-}"
[[ -n "$session_name" && -n "$window_id" ]] || usage

runtime_log_info workspace "F5 refresh-current-window invoked" \
  "session_name=$session_name" \
  "window_id=$window_id" \
  "cwd=${cwd:-}"

args=(refresh-current-window --session-name "$session_name" --window-id "$window_id")
if [[ -n "$cwd" ]]; then
  args+=(--cwd "$cwd")
fi

if bash "$SCRIPT_DIR/tmux-reset.sh" "${args[@]}"; then
  tmux display-message 'Refreshed current tmux window.' 2>/dev/null || true
  exit 0
fi

tmux display-message 'Failed to refresh current tmux window.' 2>/dev/null || true
exit 1
