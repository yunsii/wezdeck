#!/usr/bin/env bash
# Palette entry for session refresh-* actions (window / session / workspace / all).
#
# Adds workspace-category outcome rows (invoked → completed|failed + duration_ms
# + outcome=) on top of tmux-command-run's generic panel completed line.
# Reads COMMAND_PANEL_* when optional flags are omitted (palette path).
#
# stdout: only the reset status token (captured by tmux-command-run — safe).
# Non-zero exit on failure so the palette shows failure_message.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/runtime-log-lib.sh"
export WEZTERM_RUNTIME_LOG_SOURCE="session-refresh-action.sh"

usage() {
  echo "usage: $0 <refresh-current-window|refresh-current-session|refresh-current-workspace|refresh-all> [--session-name N] [--window-id ID] [--cwd PATH] [--client-tty TTY]" >&2
  exit 2
}

action="${1-}"
[[ -n "$action" ]] || usage
shift || true

case "$action" in
  refresh-current-window|refresh-current-session|refresh-current-workspace|refresh-all) ;;
  *) usage ;;
esac

session_name="${COMMAND_PANEL_SESSION_NAME:-}"
window_id="${COMMAND_PANEL_WINDOW_ID:-}"
cwd="${COMMAND_PANEL_CWD:-}"
client_tty="${COMMAND_PANEL_CLIENT_TTY:-}"

while (($# > 0)); do
  case "$1" in
    --session-name) session_name="${2:?}"; shift 2 ;;
    --window-id) window_id="${2:?}"; shift 2 ;;
    --cwd) cwd="${2-}"; shift 2 ;;
    --client-tty) client_tty="${2-}"; shift 2 ;;
    *)
      echo "unknown option: $1" >&2
      usage
      ;;
  esac
done

start_ms="$(runtime_log_now_ms)"
common_fields=(
  "action=$action"
  "session_name=${session_name:-}"
  "window_id=${window_id:-}"
  "cwd=${cwd:-}"
  "hotkey_id=session.${action}"
)

runtime_log_info workspace "session refresh invoked" "${common_fields[@]}"

fail() {
  local error="$1"
  local duration_ms
  duration_ms="$(runtime_log_duration_ms "$start_ms")"
  runtime_log_warn workspace "session refresh failed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "exit_code=1" \
    "error=$error"
  exit 1
}

# tmux-reset treats a missing session as a soft no-op (return 0) so bulk
# refresh-all can skip ghosts. For single-target palette actions, require
# the session/window to exist or we would report a false completed.
case "$action" in
  refresh-current-window|refresh-current-session)
    [[ -n "$session_name" ]] || fail "missing_session_name"
    tmux has-session -t "$session_name" 2>/dev/null || fail "missing_session"
    if [[ "$action" == "refresh-current-window" ]]; then
      [[ -n "$window_id" ]] || fail "missing_window_id"
      tmux list-panes -t "$window_id" >/dev/null 2>&1 || fail "missing_window"
    fi
    ;;
esac

args=("$action")
[[ -n "$session_name" ]] && args+=(--session-name "$session_name")
[[ -n "$window_id" ]] && args+=(--window-id "$window_id")
[[ -n "$cwd" ]] && args+=(--cwd "$cwd")
[[ -n "$client_tty" ]] && args+=(--client-tty "$client_tty")

ec=0
reset_out="$(bash "$SCRIPT_DIR/tmux-reset.sh" "${args[@]}" 2>/dev/null)" || ec=$?
reset_out="${reset_out//$'\r'/}"
# Last non-empty line is the status token.
reset_token="$(printf '%s\n' "$reset_out" | awk 'NF{line=$0} END{print line}')"

duration_ms="$(runtime_log_duration_ms "$start_ms")"

expected=""
case "$action" in
  refresh-current-window) expected="reset_window_in_place" ;;
  refresh-current-session) expected="refreshed_session" ;;
  refresh-current-workspace) expected="refreshed_workspace" ;;
  refresh-all) expected="refreshed_all" ;;
esac

if [[ "$ec" -eq 0 && -n "$expected" && "$reset_token" == "$expected" ]]; then
  runtime_log_info workspace "session refresh completed" \
    "${common_fields[@]}" \
    "duration_ms=$duration_ms" \
    "outcome=$reset_token"
  printf '%s\n' "$reset_token"
  exit 0
fi

runtime_log_warn workspace "session refresh failed" \
  "${common_fields[@]}" \
  "duration_ms=$duration_ms" \
  "exit_code=$ec" \
  "reset_out=${reset_token:-}"
exit 1
