#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

line_index="${1:-0}"
cwd="${2:-$PWD}"
render_repo="${TMUX_STATUS_RENDER_REPO:-1}"
render_branch="${TMUX_STATUS_RENDER_BRANCH:-1}"
render_git_changes="${TMUX_STATUS_RENDER_GIT_CHANGES:-1}"
render_node="${TMUX_STATUS_RENDER_NODE:-1}"
render_wakatime="${TMUX_STATUS_RENDER_WAKATIME:-1}"

line1_enabled=0
line2_enabled=0

if is_enabled "$render_repo" || is_enabled "$render_branch" || is_enabled "$render_git_changes" || is_enabled "$render_node"; then
  line1_enabled=1
fi

if is_enabled "$render_wakatime"; then
  line2_enabled=1
fi

main_line=""
wakatime_line=""

if (( line1_enabled )); then
  main_line="$(bash "$script_dir/tmux-status-line-main.sh" "$cwd")"
fi

if (( line2_enabled )); then
  wakatime_line="$(bash "$script_dir/tmux-status-wakatime.sh")"
fi

if [[ "$line_index" == "0" ]]; then
  if [[ -n "$main_line" ]]; then
    printf '%s' "$main_line"
  elif [[ -n "$wakatime_line" ]]; then
    printf '%s' "$wakatime_line"
  fi
  exit 0
fi

if [[ -n "$main_line" && -n "$wakatime_line" ]]; then
  printf '%s' "$wakatime_line"
fi
