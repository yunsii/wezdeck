#!/usr/bin/env bash
# Secondary pane voluntary exit (Ctrl+C / quit → pane-died) must drop
# typed-resume sources so a later F5 stays a login shell. Primary keeps
# its pins (F5 is the intentional bring-back path there).
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

LOG_FILE="$TEST_ROOT/runtime.log"
export WEZTERM_RUNTIME_LOG_FILE="$LOG_FILE"
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
export WEZTERM_RUNTIME_LOG_CATEGORIES=""

PINS_PATH="$TEST_ROOT/agent-session-pins.json"
export WEZDECK_AGENT_SESSION_PINS_PATH="$PINS_PATH"
ATT_PATH="$TEST_ROOT/attention.json"
export WEZDECK_ATTENTION_STATE_PATH="$ATT_PATH"
mkdir -p "$(dirname "$ATT_PATH")"

ROOT="$TEST_ROOT/secondary-exit"
mkdir -p "$ROOT"
SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sh -lc 'exec sleep 300')"
tmux rename-window -t "$WINDOW_ID" primary

tmux set-option -g remain-on-exit on
# run-shell does not inherit this script's exported WEZDECK_* env, so
# wrap pane-exit-keep with a small shim that bakes the test paths in.
HOOK_SH="$TEST_ROOT/pane-died-hook.sh"
cat > "$HOOK_SH" <<EOF
#!/usr/bin/env bash
export WEZDECK_AGENT_SESSION_PINS_PATH=$(printf '%q' "$PINS_PATH")
export WEZDECK_ATTENTION_STATE_PATH=$(printf '%q' "$ATT_PATH")
export WEZTERM_RUNTIME_LOG_FILE=$(printf '%q' "$LOG_FILE")
export WEZTERM_RUNTIME_LOG_ENABLED=1
export WEZTERM_RUNTIME_LOG_LEVEL=info
exec bash $(printf '%q' "$REAL_REPO/scripts/runtime/pane-exit-keep.sh") "\$@"
EOF
chmod +x "$HOOK_SH"
tmux set-hook -g pane-died "run-shell -b \"bash $(printf %q "$HOOK_SH") #{q:socket_path} #{q:hook_pane} #{q:pane_current_path} >/dev/null 2>&1\""

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

# Primary pin must survive a primary agent SIGINT (bring-back via F5).
tmux set-option -p -t "$PRIMARY_PANE" @wezterm_pane_role "agent-cli:claude"
tmux set-option -p -t "$PRIMARY_PANE" -q @wezterm_agent_session_id "primary-sid-keep"
tmux set-window-option -t "$WINDOW_ID" -q @wezterm_primary_agent_session_id "primary-sid-keep"
agent_session_pin_put "$ROOT" primary "primary-sid-keep" claude

# Secondary agent state that historically made F5 typed_secondary after Ctrl+C.
tmux set-option -p -t "$SECONDARY_PANE" @wezterm_pane_role "agent-cli:claude"
tmux set-option -p -t "$SECONDARY_PANE" -q @wezterm_agent_session_id "secondary-sid-drop"
tmux set-option -p -t "$SECONDARY_PANE" -q @wezterm_agent_profile "claude"
agent_session_pin_put "$ROOT" secondary "secondary-sid-drop" claude

cat > "$ATT_PATH" <<JSON
{
  "version": 1,
  "rev": 1,
  "entries": {
    "secondary-sid-drop": {
      "session_id": "secondary-sid-drop",
      "tmux_socket": "$SOCKET_PATH",
      "tmux_session": "$SESSION_NAME",
      "tmux_pane": "$SECONDARY_PANE",
      "tmux_window_name": "$WINDOW_NAME",
      "status": "running",
      "ts": 100
    }
  },
  "recent": [
    {
      "session_id": "secondary-sid-drop",
      "tmux_socket": "$SOCKET_PATH",
      "tmux_session": "$SESSION_NAME",
      "tmux_pane": "$SECONDARY_PANE",
      "tmux_window_name": "$WINDOW_NAME",
      "archived_ts": 50
    }
  ]
}
JSON

# SIGINT the secondary pane process — same shape as agent Ctrl+C.
tmux respawn-pane -k -t "$SECONDARY_PANE" -c "$ROOT" /bin/sleep 300
sleep 0.2
agent_pid="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_pid}')"
kill -INT "$agent_pid"

kept=""
for _ in $(seq 1 50); do
  if ! tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$SECONDARY_PANE"; then
    printf 'secondary pane %s was destroyed after SIGINT\n' "$SECONDARY_PANE" >&2
    exit 1
  fi
  current="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_current_command}' 2>/dev/null || true)"
  dead="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_dead}' 2>/dev/null || true)"
  if [[ "$dead" == "0" && "$current" != "sleep" && -n "$current" ]]; then
    kept="$current"
    break
  fi
  sleep 0.05
done
if [[ -z "$kept" ]]; then
  printf 'secondary pane did not respawn a shell after SIGINT\ncurrent=%s dead=%s\n' \
    "${current:-}" "${dead:-}" >&2
  exit 1
fi

sec_sid="$(tmux show-options -p -t "$SECONDARY_PANE" -v -q @wezterm_agent_session_id 2>/dev/null || true)"
[[ -z "$sec_sid" ]] || {
  printf 'secondary pane option still set after exit: %s\n' "$sec_sid" >&2
  exit 1
}
sec_role="$(tmux show-options -p -t "$SECONDARY_PANE" -v -q @wezterm_pane_role 2>/dev/null || true)"
[[ -z "$sec_role" ]] || {
  printf 'secondary pane role still set after exit: %s\n' "$sec_role" >&2
  exit 1
}
sec_pin="$(agent_session_pin_get "$ROOT" secondary || true)"
[[ -z "$sec_pin" ]] || {
  printf 'secondary durable pin still set after exit: %s\n' "$sec_pin" >&2
  exit 1
}
resolved="$(agent_session_resolve_for_pane "$SECONDARY_PANE" || true)"
[[ -z "$resolved" ]] || {
  printf 'secondary resolve still returns id after exit: %s\n' "$resolved" >&2
  exit 1
}

# Primary pins must still be intact.
pri_pin="$(agent_session_pin_get "$ROOT" primary || true)"
[[ "$pri_pin" == $'primary-sid-keep\tclaude' ]] || {
  printf 'primary durable pin was cleared unexpectedly: %s\n' "$pri_pin" >&2
  exit 1
}

# F5 on the secondary must stay a shell (no typed_secondary).
tmux select-pane -t "$SECONDARY_PANE"
bash "$REAL_REPO/scripts/runtime/session-refresh-current-window.sh" \
  "$SESSION_NAME" "$WINDOW_ID" "$ROOT"
sleep 0.3
secondary_cmd="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_current_command}')"
case "$secondary_cmd" in
  bash|zsh|sh) ;;
  *)
    printf 'F5 after secondary exit must land on a login shell\nactual: %s\n' \
      "$secondary_cmd" >&2
    exit 1
    ;;
esac

if ! grep -Fq 'secondary agent exit released typed resume' "$LOG_FILE"; then
  printf 'expected release log in %s\n' "$LOG_FILE" >&2
  cat "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'PASS secondary-exit-clears-typed-resume\n'
