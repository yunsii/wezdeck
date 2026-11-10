#!/usr/bin/env bash
# Secondary pane state machine: when the pane is already a shell, F5 must
# stay a shell even if durable pins / role tags / attention still claim an
# agent session. Current process state wins over leftover resume sources.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

REAL_REPO="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck disable=SC1091
source "$REAL_REPO/scripts/runtime/agent-session-resolve.sh"

PINS_PATH="$TEST_ROOT/agent-session-pins.json"
export WEZDECK_AGENT_SESSION_PINS_PATH="$PINS_PATH"
ATT_PATH="$TEST_ROOT/attention.json"
export WEZDECK_ATTENTION_STATE_PATH="$ATT_PATH"
LOG_FILE="$TEST_ROOT/runtime.log"
export WEZTERM_RUNTIME_LOG_FILE="$LOG_FILE"
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
mkdir -p "$(dirname "$ATT_PATH")"

ROOT="$TEST_ROOT/secondary-shell-f5"
mkdir -p "$ROOT"
SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sh -lc 'exec sleep 300')"
tmux rename-window -t "$WINDOW_ID" primary

tmux_test_set_session_metadata "$SESSION_NAME" work managed
# shellcheck disable=SC1091
source "$REAL_REPO/scripts/runtime/managed-shell-lib.sh"
LOGIN_SHELL="$(resolve_login_shell)"
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$ROOT" primary \
  "$LOGIN_SHELL -il" managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$ROOT"

PRIMARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}|#{pane_left}' \
  | sort -t '|' -k2,2n | head -n 1 | cut -d '|' -f1)"
SECONDARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' \
  | grep -vx "$PRIMARY_PANE" | head -n 1)"
SOCKET_PATH="$(tmux display-message -p -t "$PRIMARY_PANE" '#{socket_path}')"
WINDOW_NAME="$(tmux display-message -p -t "$PRIMARY_PANE" '#{window_name}')"

tmux set-window-option -t "$WINDOW_ID" -q @wezterm_window_primary_pane "$PRIMARY_PANE"

# Stale agent markers while the pane leaf is already a plain shell.
tmux respawn-pane -k -t "$SECONDARY_PANE" -c "$ROOT" "$LOGIN_SHELL" -il
sleep 0.2
tmux set-option -p -t "$SECONDARY_PANE" @wezterm_pane_role "agent-cli:claude"
tmux set-option -p -t "$SECONDARY_PANE" -q @wezterm_agent_session_id "stale-secondary-sid"
tmux set-option -p -t "$SECONDARY_PANE" -q @wezterm_agent_profile "claude"
agent_session_pin_put "$ROOT" secondary "stale-secondary-sid" claude

cat > "$ATT_PATH" <<JSON
{
  "version": 1,
  "rev": 1,
  "entries": {
    "stale-secondary-sid": {
      "session_id": "stale-secondary-sid",
      "tmux_socket": "$SOCKET_PATH",
      "tmux_session": "$SESSION_NAME",
      "tmux_pane": "$SECONDARY_PANE",
      "tmux_window_name": "$WINDOW_NAME",
      "status": "done",
      "ts": 100
    }
  },
  "recent": []
}
JSON

agent_session_secondary_in_agent_state "$SECONDARY_PANE" && {
  printf 'expected secondary shell state before F5\n' >&2
  exit 1
}

tmux select-pane -t "$SECONDARY_PANE"
bash "$REAL_REPO/scripts/runtime/session-refresh-current-window.sh" \
  "$SESSION_NAME" "$WINDOW_ID" "$ROOT"
sleep 0.3

secondary_cmd="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_current_command}')"
case "$secondary_cmd" in
  bash|zsh|sh) ;;
  *)
    printf 'F5 on shell-state secondary must stay a shell\nactual: %s\n' \
      "$secondary_cmd" >&2
    exit 1
    ;;
esac

sec_pin="$(agent_session_pin_get "$ROOT" secondary || true)"
[[ -z "$sec_pin" ]] || {
  printf 'stale secondary pin survived shell-state F5: %s\n' "$sec_pin" >&2
  exit 1
}
sec_sid="$(tmux show-options -p -t "$SECONDARY_PANE" -v -q @wezterm_agent_session_id 2>/dev/null || true)"
[[ -z "$sec_sid" ]] || {
  printf 'stale pane session id survived shell-state F5: %s\n' "$sec_sid" >&2
  exit 1
}
resolved="$(agent_session_resolve_for_pane "$SECONDARY_PANE" || true)"
[[ -z "$resolved" ]] || {
  printf 'resolve still returns stale id after shell-state F5: %s\n' "$resolved" >&2
  exit 1
}

if ! grep -Eq 'resume_mode="?secondary_shell"?' "$LOG_FILE"; then
  printf 'expected resume_mode=secondary_shell in %s\n' "$LOG_FILE" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'PASS secondary-shell-state-f5\n'
