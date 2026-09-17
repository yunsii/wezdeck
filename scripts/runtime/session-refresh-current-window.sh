#!/usr/bin/env bash
# F5 / session.refresh-current-window hotkey entry (tmux User3).
#
# WezTerm forwards `\e[20102~` here (see manifest `session.refresh-current-window`).
# Outcome contract (same class as session-bridge-take / attention-jump):
#   toast via display-message + runtime.log invoked → completed|failed
#   (duration_ms on the terminal row). stdout MUST stay empty: tmux
#   `run-shell -b` treats any stdout as a result buffer and opens
#   view-mode on the pane (status shows COPY) — that is why an earlier
#   F5 left a blank COPY · [0/0] screen when reset printed
#   `reset_window_in_place`. Palette path is fine (tmux-command-run captures).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="session-refresh-current-window.sh"

usage() {
  echo "usage: $0 <session-name> <window-id> [cwd]" >&2
  exit 2
}

toast() {
  local msg="${1:-}"
  msg="${msg//$'\n'/ }"
  if ((${#msg} > 120)); then
    msg="${msg:0:117}..."
  fi
  tmux display-message -d 2000 "$msg" 2>/dev/null || true
}

session_name="${1-}"
window_id="${2-}"
cwd="${3-}"
[[ -n "$session_name" && -n "$window_id" ]] || usage

start_ms="$(runtime_log_now_ms)"
common_fields=(
  "session_name=$session_name"
  "window_id=$window_id"
  "cwd=${cwd:-}"
  "hotkey_id=session.refresh-current-window"
)

runtime_log_info workspace "F5 refresh-current-window invoked" "${common_fields[@]}"

args=(refresh-current-window --session-name "$session_name" --window-id "$window_id")
if [[ -n "$cwd" ]]; then
  args+=(--cwd "$cwd")
fi

ec=0
# Capture reset's status token in a variable (never print it): run-shell
# would open view-mode on any stdout. Soft outcomes like no_current_window
# still exit 0 from tmux-reset — treat only reset_window_in_place as success.
reset_out="$(bash "$SCRIPT_DIR/tmux-reset.sh" "${args[@]}" 2>/dev/null)" || ec=$?
reset_out="${reset_out//$'\r'/}"
reset_out="${reset_out##*$'\n'}"

duration_ms="$(runtime_log_duration_ms "$start_ms")"

if [[ "$ec" -eq 0 && "$reset_out" == "reset_window_in_place" ]]; then
  # Clear leftover view/copy-mode from a prior buggy run (or race).
  while read -r pane_id in_mode; do
    [[ "$in_mode" == "1" ]] || continue
    tmux send-keys -t "$pane_id" -X cancel 2>/dev/null || true
  done < <(tmux list-panes -t "$window_id" -F '#{pane_id} #{pane_in_mode}' 2>/dev/null || true)
  toast_msg='Refreshed current tmux window.'
  runtime_log_info workspace "F5 refresh-current-window completed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "outcome=respawned" \
    "toast=$toast_msg"
  toast "$toast_msg"
  exit 0
fi

toast_msg='Failed to refresh current tmux window.'
runtime_log_warn workspace "F5 refresh-current-window failed" \
  "${common_fields[@]}" \
  "duration_ms=$duration_ms" \
  "exit_code=$ec" \
  "reset_out=${reset_out:-}" \
  "toast=$toast_msg"
toast "$toast_msg"
# Always exit 0 from the run-shell wrapper so tmux does not append "… returned N".
exit 0
