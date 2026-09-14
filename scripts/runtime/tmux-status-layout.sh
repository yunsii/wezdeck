#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/tmux-status-lib.sh"

render_repo="$(tmux_option_or_env TMUX_STATUS_RENDER_REPO @tmux_status_render_repo '1')"
render_worktree="$(tmux_option_or_env TMUX_STATUS_RENDER_WORKTREE @tmux_status_render_worktree '1')"
render_branch="$(tmux_option_or_env TMUX_STATUS_RENDER_BRANCH @tmux_status_render_branch '1')"
render_git_changes="$(tmux_option_or_env TMUX_STATUS_RENDER_GIT_CHANGES @tmux_status_render_git_changes '1')"
render_node="$(tmux_option_or_env TMUX_STATUS_RENDER_NODE @tmux_status_render_node '1')"
render_wakatime="$(tmux_option_or_env TMUX_STATUS_RENDER_WAKATIME @tmux_status_render_wakatime '1')"
padding="$(tmux_option_or_env TMUX_STATUS_PADDING @tmux_status_padding ' ')"
separator="$(tmux_option_or_env TMUX_STATUS_SEPARATOR @tmux_status_separator ' · ')"
session_name="${1:-}"
window_id="${2:-}"
cwd="${3:-$PWD}"

main_line=""
worktree_line=""
wakatime_line=""

if is_enabled "$render_repo" || is_enabled "$render_branch" || is_enabled "$render_git_changes" || is_enabled "$render_node"; then
  main_line="$(
    TMUX_STATUS_PADDING="$padding" \
    TMUX_STATUS_SEPARATOR="$separator" \
    TMUX_STATUS_RENDER_REPO="$render_repo" \
    TMUX_STATUS_RENDER_BRANCH="$render_branch" \
    TMUX_STATUS_RENDER_GIT_CHANGES="$render_git_changes" \
    TMUX_STATUS_RENDER_NODE="$render_node" \
      bash "$script_dir/tmux-status-line-main.sh" "$cwd"
  )"
fi

if is_enabled "$render_worktree"; then
  worktree_line="$(
    TMUX_STATUS_PADDING="$padding" \
    TMUX_STATUS_RENDER_WORKTREE="$render_worktree" \
      bash "$script_dir/tmux-status-line-worktree.sh" "$cwd" "$session_name" "$window_id"
  )"
fi

if is_enabled "$render_wakatime"; then
  wakatime_line="$(
    TMUX_STATUS_PADDING="$padding" \
    TMUX_STATUS_SEPARATOR="$separator" \
    TMUX_STATUS_RENDER_WAKATIME="$render_wakatime" \
      bash "$script_dir/tmux-status-wakatime.sh"
  )"
fi

# Pack visible lines into consecutive status slots. Producers that have
# nothing useful to show must emit empty output (no placeholder row).
packed_lines=()
if tmux_status_line_is_visible "$main_line"; then
  packed_lines+=("$main_line")
fi
if tmux_status_line_is_visible "$worktree_line"; then
  packed_lines+=("$worktree_line")
fi
if tmux_status_line_is_visible "$wakatime_line"; then
  packed_lines+=("$wakatime_line")
fi

packed_count="${#packed_lines[@]}"
line_0="${packed_lines[0]:-}"
line_1="${packed_lines[1]:-}"
line_2="${packed_lines[2]:-}"

case "$packed_count" in
  0) target_status="off" ;;
  1) target_status="on" ;;
  2) target_status="2" ;;
  *) target_status="3" ;;
esac

current_status="$(tmux show -gv status 2>/dev/null || printf 'on')"

if [[ -n "$session_name" ]]; then
  current_status="$(tmux show-options -qv -t "$session_name" status 2>/dev/null || printf '%s' "$current_status")"
fi

status_changed=0
if [[ "$current_status" != "$target_status" ]]; then
  status_changed=1
  if [[ -n "$session_name" ]]; then
    tmux set-option -q -t "$session_name" status "$target_status" 2>/dev/null || true
  else
    tmux set -g status "$target_status" 2>/dev/null || true
  fi
fi

if [[ -n "$session_name" ]]; then
  tmux set-option -q -t "$session_name" @tmux_status_line_0 "$line_0" 2>/dev/null || true
  tmux set-option -q -t "$session_name" @tmux_status_line_1 "$line_1" 2>/dev/null || true
  tmux set-option -q -t "$session_name" @tmux_status_line_2 "$line_2" 2>/dev/null || true
else
  tmux set-option -gq @tmux_status_line_0 "$line_0" 2>/dev/null || true
  tmux set-option -gq @tmux_status_line_1 "$line_1" 2>/dev/null || true
  tmux set-option -gq @tmux_status_line_2 "$line_2" 2>/dev/null || true
fi

# Status row count changes the pane grid. Re-assert even-horizontal on
# managed two-pane windows so left/right stay aligned after the heal.
if (( status_changed )) && [[ -n "$window_id" ]]; then
  pane_count="$(tmux list-panes -t "$window_id" 2>/dev/null | wc -l | tr -d ' ')"
  if [[ "${pane_count:-0}" -ge 2 ]]; then
    layout_meta="$(tmux show-window-options -v -t "$window_id" @wezterm_window_layout 2>/dev/null || true)"
    if [[ "$layout_meta" == "managed_two_pane" || -z "$layout_meta" ]]; then
      tmux select-layout -t "$window_id" even-horizontal >/dev/null 2>&1 || true
    fi
  fi
fi
