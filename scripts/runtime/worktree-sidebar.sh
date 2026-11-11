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

# Focus-relative placement: prefer just right of the active pane; if that
# overflows the client, try just left; else clamp to the client edge nearer
# the focus. Align Y/height with the focused pane.
sidebar_geometry_for_focus() {
  local target="${1:-}"
  local client_w focus_left focus_right focus_top focus_h x_pos y_pos h
  client_w="$(tmux display-message -p -t "$target" '#{client_width}' 2>/dev/null || echo 120)"
  focus_left="$(tmux display-message -p -t "$target" '#{pane_left}' 2>/dev/null || echo 0)"
  focus_right="$(tmux display-message -p -t "$target" '#{pane_right}' 2>/dev/null || echo 0)"
  focus_top="$(tmux display-message -p -t "$target" '#{pane_top}' 2>/dev/null || echo 0)"
  focus_h="$(tmux display-message -p -t "$target" '#{pane_height}' 2>/dev/null || echo 20)"

  # pane_right is inclusive; prefer just to the right of the focused pane.
  if (( focus_right + 1 + WIDTH <= client_w )); then
    x_pos=$(( focus_right + 1 ))
  elif (( focus_left >= WIDTH )); then
    x_pos=$(( focus_left - WIDTH ))
  else
    x_pos=$(( client_w - WIDTH ))
    (( x_pos < 0 )) && x_pos=0
  fi
  y_pos="$focus_top"
  h="$focus_h"
  (( h < 8 )) && h=8
  printf '%s %s %s' "$x_pos" "$y_pos" "$h"
}

close_sidebar() {
  local sess="${1:-}" pane
  pane="$(find_sidebar_pane "$sess")"
  if [[ -z "$pane" ]]; then
    return 0
  fi
  runtime_log_info worktree "sidebar closed" "session_name=$sess" "pane_id=$pane" || true
  # remain-on-exit is on globally; kill hard so pane-exit-keep cannot
  # respawn a leftover login shell in the floating slot.
  tmux kill-pane -t "$pane" 2>/dev/null || true
}

open_sidebar() {
  local sess="$1" win="$2" pane_cwd="$3"
  local existing prefetch_file prefetch_rc=0 pane_id
  local focus_target geo x_pos y_pos h
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

  # Place relative to the focused pane in this window (fallback: window).
  focus_target="${win:-$sess}"
  if [[ -n "$win" ]]; then
    focus_target="$(tmux list-panes -t "$win" -F '#{pane_id} #{pane_active}' \
      | awk '$2==1{print $1; exit}')"
    [[ -n "$focus_target" ]] || focus_target="$win"
  fi
  geo="$(sidebar_geometry_for_focus "$focus_target")"
  read -r x_pos y_pos h <<< "$geo"

  # tmux 3.8: new-pane without -h/-v creates a floating pane.
  # remain-on-exit off: when the UI exits (q), the pane must die — otherwise
  # the global remain-on-exit + pane-exit-keep leaves a stray shell float.
  pane_id="$(tmux new-pane -d -P -F '#{pane_id}' -t "$focus_target" \
    -x "$WIDTH" -y "$h" -X "$x_pos" -Y "$y_pos" \
    -T "Worktrees: $repo_label" \
    -- bash "$ui" "$sess" "$win" "$pane_cwd" "$prefetch_file" "$repo_label" "$current_worktree_root")"

  tmux set-option -p -t "$pane_id" remain-on-exit off
  tmux set-option -p -t "$pane_id" @wezterm_pane_role "$ROLE"
  tmux set-option -p -t "$pane_id" -q @wezterm_sidebar_session "$sess"
  tmux select-pane -t "$pane_id"

  runtime_log_info worktree "sidebar opened" \
    "session_name=$sess" \
    "pane_id=$pane_id" \
    "focus_pane=$focus_target" \
    "x=$x_pos" \
    "y=$y_pos" \
    "h=$h" \
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
