#!/usr/bin/env bash
# Ctrl+k x / pane.close-current — kill the focused (or explicit) tmux pane.
#
# Outcome contract: toast + runtime.log invoked → completed|failed (duration_ms).
# stdout MUST stay empty for run-shell (view-mode / status COPY risk).
# Always exit 0 from the hotkey wrapper so tmux does not append "returned N".
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="pane-close-current.sh"

toast() {
  local msg="${1:-}"
  msg="${msg//$'\n'/ }"
  if ((${#msg} > 120)); then
    msg="${msg:0:117}..."
  fi
  tmux display-message -d 2000 "$msg" 2>/dev/null || true
}

pane_id="${1-}"
if [[ -z "$pane_id" && -n "${COMMAND_PANEL_WINDOW_ID:-}" ]]; then
  pane_id="$(tmux display-message -p -t "$COMMAND_PANEL_WINDOW_ID" '#{pane_id}' 2>/dev/null || true)"
fi
if [[ -z "$pane_id" ]]; then
  pane_id="$(tmux display-message -p '#{pane_id}' 2>/dev/null || true)"
fi

start_ms="$(runtime_log_now_ms)"
session_name=""
window_id=""
cwd=""
pane_count=""
if [[ -n "$pane_id" ]]; then
  session_name="$(tmux display-message -p -t "$pane_id" '#{session_name}' 2>/dev/null || true)"
  window_id="$(tmux display-message -p -t "$pane_id" '#{window_id}' 2>/dev/null || true)"
  cwd="$(tmux display-message -p -t "$pane_id" '#{pane_current_path}' 2>/dev/null || true)"
  if [[ -n "$window_id" ]]; then
    pane_count="$(tmux list-panes -t "$window_id" 2>/dev/null | wc -l | tr -d ' ' || true)"
  fi
fi

common_fields=(
  "pane_id=${pane_id:-}"
  "session_name=${session_name:-}"
  "window_id=${window_id:-}"
  "cwd=${cwd:-}"
  "pane_count=${pane_count:-}"
  "hotkey_id=pane.close-current"
)

runtime_log_info workspace "pane close-current invoked" "${common_fields[@]}"

if [[ -z "$pane_id" ]]; then
  duration_ms="$(runtime_log_duration_ms "$start_ms")"
  toast_msg='Failed to close pane: target unavailable.'
  runtime_log_warn workspace "pane close-current failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "error=missing_pane" \
    "toast=$toast_msg"
  toast "$toast_msg"
  exit 0
fi

# Toast before kill — the pane (and maybe window) will be gone after.
closes_window=0
if [[ "${pane_count:-0}" == "1" ]]; then
  closes_window=1
fi
if [[ "$closes_window" == "1" ]]; then
  toast_msg='Closed last pane (window closed).'
else
  toast_msg='Closed pane.'
fi
toast "$toast_msg"

ec=0
tmux kill-pane -t "$pane_id" 2>/dev/null || ec=$?
duration_ms="$(runtime_log_duration_ms "$start_ms")"

if [[ "$ec" -eq 0 ]]; then
  runtime_log_info workspace "pane close-current completed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "outcome=killed" \
    "closes_window=$closes_window" \
    "toast=$toast_msg"
  exit 0
fi

runtime_log_warn workspace "pane close-current failed" \
  "${common_fields[@]}" \
  "duration_ms=$duration_ms" \
  "exit_code=$ec" \
  "toast=Failed to close pane."
toast 'Failed to close pane.'
exit 0
