#!/usr/bin/env bash
# Floating worktree sidebar (tmux 3.8+). Toggle open/close for one session.
#
# Usage:
#   worktree-sidebar.sh toggle <session> <window_id> <cwd>
#   worktree-sidebar.sh open   <session> <window_id> <cwd>
#   worktree-sidebar.sh close  <session>
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$script_dir/runtime-log-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-worktree-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/attention-state-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/tmux-user-interact-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/access-ledger-lib.sh"
# shellcheck disable=SC1091
source "$script_dir/worktree/lib/prefetch-list.sh"

ROLE='worktree-sidebar'
WIDTH="${WEZTERM_WORKTREE_SIDEBAR_WIDTH:-34}"

action="${1:-toggle}"
session_name="${2:-}"
current_window_id="${3:-}"
cwd="${4:-$PWD}"

find_sidebar_pane() {
  local sess="${1:-}"
  tmux list-panes -a -F '#{session_name}|#{pane_id}|#{@wezterm_pane_role}' 2>/dev/null \
    | awk -F'|' -v s="$sess" -v r="$ROLE" '$1==s && $3==r {print $2; exit}'
}

close_sidebar() {
  local sess="${1:-}" pane
  pane="$(find_sidebar_pane "$sess")"
  if [[ -z "$pane" ]]; then
    return 0
  fi
  runtime_log_info worktree "sidebar closed" "session_name=$sess" "pane_id=$pane" || true
  tmux kill-pane -t "$pane" 2>/dev/null || true
}

open_sidebar() {
  local sess="$1" win="$2" pane_cwd="$3"
  local existing prefetch_file prefetch_rc=0 client_w x_pos pane_id
  local ui="$script_dir/worktree-sidebar-ui.sh"

  existing="$(find_sidebar_pane "$sess")"
  if [[ -n "$existing" ]]; then
    tmux select-pane -t "$existing"
    return 0
  fi

  prefetch_file="$(mktemp -t wezterm-worktree-sidebar.XXXXXX)"
  worktree_prefetch_list "$sess" "$win" "$pane_cwd" "$prefetch_file" || prefetch_rc=$?
  if (( prefetch_rc == 2 )); then
    rm -f "$prefetch_file"
    tmux display-message 'No git worktree in this session'
    return 0
  fi
  if (( prefetch_rc != 0 )); then
    rm -f "$prefetch_file"
    tmux display-message 'Worktree sidebar prefetch failed'
    return 1
  fi

  client_w="$(tmux display-message -p -t "$sess" '#{client_width}' 2>/dev/null || echo 120)"
  x_pos=$(( client_w - WIDTH ))
  (( x_pos < 0 )) && x_pos=0

  # tmux 3.8: new-pane without -h/-v creates a floating pane; -x width, -X left.
  pane_id="$(tmux new-pane -d -P -F '#{pane_id}' -t "$sess" \
    -x "$WIDTH" -X "$x_pos" -T "Worktrees: $repo_label" \
    -- bash "$ui" "$sess" "$win" "$pane_cwd" "$prefetch_file" "$repo_label" "$current_worktree_root")"

  tmux set-option -p -t "$pane_id" @wezterm_pane_role "$ROLE"
  tmux set-option -p -t "$pane_id" -q @wezterm_sidebar_session "$sess"
  tmux select-pane -t "$pane_id"

  runtime_log_info worktree "sidebar opened" \
    "session_name=$sess" \
    "pane_id=$pane_id" \
    "repo_label=$repo_label" \
    "item_count=${#item_paths[@]}" \
    "width=$WIDTH" || true
}

case "$action" in
  close)
    [[ -n "$session_name" ]] || { echo "usage: $0 close <session>" >&2; exit 64; }
    close_sidebar "$session_name"
    ;;
  open)
    [[ -n "$session_name" ]] || { echo "usage: $0 open <session> <window> <cwd>" >&2; exit 64; }
    open_sidebar "$session_name" "$current_window_id" "$cwd"
    ;;
  toggle)
    [[ -n "$session_name" ]] || { echo "usage: $0 toggle <session> <window> <cwd>" >&2; exit 64; }
    if [[ -n "$(find_sidebar_pane "$session_name")" ]]; then
      close_sidebar "$session_name"
    else
      open_sidebar "$session_name" "$current_window_id" "$cwd"
    fi
    ;;
  *)
    echo "usage: $0 toggle|open|close <session> [window] [cwd]" >&2
    exit 64
    ;;
esac
