#!/usr/bin/env bash
# refresh-current-window --fresh-agent must unpin typed-resume sources and
# prefix the managed primary command with WEZDECK_FORCE_FRESH_SESSION=1
# (recycle round reset path; replaces Ctrl+n + F5).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/agent-session-resolve.sh"

tmux_test_setup
trap tmux_test_teardown EXIT
export MANAGED_AGENT_PROFILE=noresume

PINS_PATH="$TEST_ROOT/agent-session-pins.json"
export WEZDECK_AGENT_SESSION_PINS_PATH="$PINS_PATH"

ROOT="$TEST_ROOT/fresh-agent-root"
mkdir -p "$ROOT"
SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sh -lc 'exec sleep 300')"
tmux rename-window -t "$WINDOW_ID" fresh-agent

tmux_test_set_session_metadata "$SESSION_NAME" work managed
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$ROOT" fresh-agent /bin/false managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$ROOT"

PRIMARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
tmux set-option -p -t "$PRIMARY_PANE" -q @wezterm_agent_session_id "old-sid-recycle"
tmux set-window-option -t "$WINDOW_ID" -q @wezterm_primary_agent_session_id "old-sid-recycle"
agent_session_pin_put "$ROOT" primary "old-sid-recycle" claude

tmux select-pane -t "$PRIMARY_PANE"
out="$(bash "$TMUX_RESET_SCRIPT" refresh-current-window \
  --session-name "$SESSION_NAME" \
  --window-id "$WINDOW_ID" \
  --cwd "$ROOT" \
  --fresh-agent)"
tmux_test_assert_eq "reset_window_in_place" "$out" \
  "fresh-agent refresh must succeed"

pane_sid="$(tmux show-options -p -t "$PRIMARY_PANE" -v -q @wezterm_agent_session_id 2>/dev/null || true)"
[[ -z "$pane_sid" ]] || {
  printf 'pane session id still set after --fresh-agent: %s\n' "$pane_sid" >&2
  exit 1
}
win_sid="$(tmux show-options -w -t "$WINDOW_ID" -v -q @wezterm_primary_agent_session_id 2>/dev/null || true)"
[[ -z "$win_sid" ]] || {
  printf 'window pin still set after --fresh-agent: %s\n' "$win_sid" >&2
  exit 1
}
pin="$(agent_session_pin_get "$ROOT" primary 2>/dev/null || true)"
[[ -z "$pin" ]] || {
  printf 'durable pin still set after --fresh-agent: %s\n' "$pin" >&2
  exit 1
}

primary_start="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_start_command}')"
case "$primary_start" in
  *WEZDECK_FORCE_FRESH_SESSION=1*)
    ;;
  *)
    printf 'fresh-agent must inject WEZDECK_FORCE_FRESH_SESSION=1\nactual: %s\n' \
      "$primary_start" >&2
    exit 1
    ;;
esac
case "$primary_start" in
  *WEZDECK_RESUME_SESSION_ID=*)
    printf 'fresh-agent must not inject WEZDECK_RESUME_SESSION_ID\nactual: %s\n' \
      "$primary_start" >&2
    exit 1
    ;;
esac

printf 'PASS fresh-agent-unpins-and-force-fresh\n'
