#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

render_repo="${TMUX_STATUS_RENDER_REPO:-1}"
render_branch="${TMUX_STATUS_RENDER_BRANCH:-1}"
render_git_changes="${TMUX_STATUS_RENDER_GIT_CHANGES:-1}"
render_node="${TMUX_STATUS_RENDER_NODE:-1}"
render_wakatime="${TMUX_STATUS_RENDER_WAKATIME:-1}"
cwd="${1:-$PWD}"
target_status="off"

line1_enabled=0
line2_enabled=0
main_line=""
wakatime_line=""

if is_enabled "$render_repo" || is_enabled "$render_branch" || is_enabled "$render_git_changes" || is_enabled "$render_node"; then
  line1_enabled=1
fi

if is_enabled "$render_wakatime"; then
  line2_enabled=1
fi

if (( line1_enabled )); then
  main_line="$(bash "$script_dir/tmux-status-line-main.sh" "$cwd")"
fi

if (( line2_enabled )); then
  wakatime_line="$(bash "$script_dir/tmux-status-wakatime.sh")"
fi

if [[ -n "$main_line" && -n "$wakatime_line" ]]; then
  target_status="2"
elif [[ -n "$main_line" || -n "$wakatime_line" ]]; then
  target_status="on"
fi

current_status="$(tmux show -gv status 2>/dev/null || printf 'on')"

if [[ "$current_status" != "$target_status" ]]; then
  tmux set -g status "$target_status"
fi
