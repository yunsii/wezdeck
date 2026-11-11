#!/usr/bin/env bash
# Floating worktree container (tmux 3.8+). Same Alt+g hotkey; UI mode
# WEZTERM_WORKTREE_PICKER_UI=sidebar. The float covers the sibling tiled
# pane (usually secondary) and runs the **same** Go picker as the centered
# popup — Ctrl+y/b/d, reverse highlight, hidden cursor, all unchanged.
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
# shellcheck disable=SC1091
. "$script_dir/picker-bin-lib.sh"

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

# Cover the other tiled pane (full rectangle). Solo-pane → strip beside focus.
sidebar_geometry() {
  local win="${1:-}" focus="${2:-}"
  local cover left top w h client_w focus_left focus_right focus_top focus_h x_pos

  cover=""
  if [[ -n "$win" ]]; then
    cover="$(tmux list-panes -t "$win" -F \
      '#{pane_id}|#{pane_active}|#{pane_floating_flag}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}' \
      | awk -F'|' '$2==0 && $3==0 {print; exit}')"
    if [[ -z "$cover" ]]; then
      cover="$(tmux list-panes -t "$win" -F \
        '#{pane_id}|#{pane_active}|#{pane_floating_flag}|#{pane_left}|#{pane_top}|#{pane_width}|#{pane_height}' \
        | awk -F'|' -v f="$focus" '$3==0 && $1!=f {print; exit}')"
    fi
  fi

  if [[ -n "$cover" ]]; then
    IFS='|' read -r _ _ _ left top w h <<< "$cover"
    (( w < 8 )) && w=8
    (( h < 8 )) && h=8
    printf '%s %s %s %s' "$left" "$top" "$w" "$h"
    return 0
  fi

  client_w="$(tmux display-message -p -t "$focus" '#{client_width}' 2>/dev/null || echo 120)"
  focus_left="$(tmux display-message -p -t "$focus" '#{pane_left}' 2>/dev/null || echo 0)"
  focus_right="$(tmux display-message -p -t "$focus" '#{pane_right}' 2>/dev/null || echo 0)"
  focus_top="$(tmux display-message -p -t "$focus" '#{pane_top}' 2>/dev/null || echo 0)"
  focus_h="$(tmux display-message -p -t "$focus" '#{pane_height}' 2>/dev/null || echo 20)"
  if (( focus_right + 1 + WIDTH <= client_w )); then
    x_pos=$(( focus_right + 1 ))
  elif (( focus_left >= WIDTH )); then
    x_pos=$(( focus_left - WIDTH ))
  else
    x_pos=$(( client_w - WIDTH ))
    (( x_pos < 0 )) && x_pos=0
  fi
  (( focus_h < 8 )) && focus_h=8
  printf '%s %s %s %s' "$x_pos" "$focus_top" "$WIDTH" "$focus_h"
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
  local existing prefetch_file prefetch_rc=0 pane_id
  local focus_target geo x_pos y_pos w h
  local picker_binary picker_rc=0 open_script trace_id start_ms menu_done_ts
  local picker_command

  existing="$(find_sidebar_pane "$sess")"
  if [[ -n "$existing" ]]; then
    tmux select-pane -t "$existing"
    return 0
  fi

  start_ms="$(runtime_log_now_ms)"
  trace_id="$(runtime_log_current_trace_id)"
  prefetch_file="$(mktemp -t wezterm-worktree-sidebar.XXXXXX)"
  WORKTREE_PREFETCH_START_MS="$start_ms"
  worktree_prefetch_list "$sess" "$win" "$pane_cwd" "$prefetch_file" || prefetch_rc=$?
  unset WORKTREE_PREFETCH_START_MS
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

  picker_binary="$(picker_bin_require "$script_dir" "Alt+g sidebar")" || picker_rc=$?
  if (( picker_rc == 1 )); then
    rm -f "$prefetch_file"
    return 0
  fi
  if (( picker_rc != 0 )); then
    rm -f "$prefetch_file"
    tmux display-message 'Worktree sidebar needs native picker (no bash UI in sidebar mode)'
    return 1
  fi

  open_script="$script_dir/tmux-worktree-open.sh"
  menu_done_ts=$(( ${EPOCHREALTIME//./} / 1000 ))
  # Same argv as tmux-worktree-menu.sh popup path.
  picker_command=$(printf 'WEZTERM_RUNTIME_TRACE_ID=%q %q worktree %q %q %q %q %q %q %q %q %q %q' \
    "$trace_id" "$picker_binary" \
    "$prefetch_file" "$open_script" \
    "$sess" "$win" "$pane_cwd" \
    "$current_worktree_root" "$repo_label" \
    "$start_ms" "$start_ms" "$menu_done_ts")

  focus_target="${win:-$sess}"
  if [[ -n "$win" ]]; then
    focus_target="$(tmux list-panes -t "$win" -F '#{pane_id} #{pane_active}' \
      | awk '$2==1{print $1; exit}')"
    [[ -n "$focus_target" ]] || focus_target="$win"
  fi
  geo="$(sidebar_geometry "$win" "$focus_target")"
  read -r x_pos y_pos w h <<< "$geo"

  # Wrapper: run Go picker; always remove prefetch; kill this pane on exit
  # (remain-on-exit off is also set) so Esc/q from picker leaves no float.
  pane_id="$(tmux new-pane -d -P -F '#{pane_id}' -t "$focus_target" \
    -x "$w" -y "$h" -X "$x_pos" -Y "$y_pos" \
    -T "Worktrees: $repo_label" \
    -- bash -c "trap 'rm -f \"$prefetch_file\"; tmux kill-pane -t \"\$TMUX_PANE\" 2>/dev/null || true' EXIT; $picker_command")"

  tmux set-option -p -t "$pane_id" remain-on-exit off
  tmux set-option -p -t "$pane_id" @wezterm_pane_role "$ROLE"
  tmux set-option -p -t "$pane_id" -q @wezterm_sidebar_session "$sess"
  tmux select-pane -t "$pane_id"

  runtime_log_info worktree "sidebar opened" \
    "session_name=$sess" \
    "pane_id=$pane_id" \
    "focus_pane=$focus_target" \
    "picker=go" \
    "x=$x_pos" \
    "y=$y_pos" \
    "w=$w" \
    "h=$h" \
    "repo_label=$repo_label" \
    "item_count=${#item_paths[@]}" || true
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
