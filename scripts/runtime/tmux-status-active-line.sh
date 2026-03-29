#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

line_index="${1:-0}"
session_name="${2:-}"
window_id="${3:-}"
cwd="${4:-$PWD}"
render_repo="$(tmux_option_or_env TMUX_STATUS_RENDER_REPO @tmux_status_render_repo '1')"
render_worktree="$(tmux_option_or_env TMUX_STATUS_RENDER_WORKTREE @tmux_status_render_worktree '1')"
render_branch="$(tmux_option_or_env TMUX_STATUS_RENDER_BRANCH @tmux_status_render_branch '1')"
render_git_changes="$(tmux_option_or_env TMUX_STATUS_RENDER_GIT_CHANGES @tmux_status_render_git_changes '1')"
render_node="$(tmux_option_or_env TMUX_STATUS_RENDER_NODE @tmux_status_render_node '1')"
render_wakatime="$(tmux_option_or_env TMUX_STATUS_RENDER_WAKATIME @tmux_status_render_wakatime '1')"

line1_enabled=0
line2_enabled=0
line3_enabled=0

if is_enabled "$render_repo" || is_enabled "$render_branch" || is_enabled "$render_git_changes" || is_enabled "$render_node"; then
  line1_enabled=1
fi

if is_enabled "$render_worktree"; then
  line2_enabled=1
fi

main_line=""
worktree_line=""
wakatime_line=""

if (( line1_enabled )); then
  main_line="$(bash "$script_dir/tmux-status-line-main.sh" "$cwd")"
fi

if (( line2_enabled )); then
  worktree_line="$(bash "$script_dir/tmux-status-line-worktree.sh" "$cwd" "$session_name" "$window_id")"
fi

if is_enabled "$render_wakatime"; then
  line3_enabled=1
fi

if (( line3_enabled )); then
  wakatime_line="$(bash "$script_dir/tmux-status-wakatime.sh")"
fi

case "$line_index" in
  0)
    if (( line1_enabled )); then
      printf '%s' "$main_line"
    fi
    ;;
  1)
    if (( line2_enabled )); then
      printf '%s' "$worktree_line"
    fi
    ;;
  2)
    if (( line3_enabled )); then
      printf '%s' "$wakatime_line"
    fi
    ;;
esac
