#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

cwd="${1:-$PWD}"
session_name="${2:-}"
window_id="${3:-}"
padding="$(tmux_option_or_env TMUX_STATUS_PADDING @tmux_status_padding ' ')"
render_worktree="$(tmux_option_or_env TMUX_STATUS_RENDER_WORKTREE @tmux_status_render_worktree '1')"

if ! is_enabled "$render_worktree"; then
  exit 0
fi

worktree_part="$(bash "$script_dir/tmux-status-worktree.sh" "$session_name" "$window_id" "$cwd")"

if [[ -z "$worktree_part" ]]; then
  exit 0
fi

printf '%s%s' "$padding" "$worktree_part"
