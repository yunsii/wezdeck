#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

PROJECT_ROOT="$TEST_ROOT/primary-pane-sigint-root"
mkdir -p "$PROJECT_ROOT"

SESSION_NAME="$(tmux_worktree_session_name_for_path work "$PROJECT_ROOT")"
OPEN_PROJECT_SESSION_SCRIPT="$SCRIPT_DIR/../../../scripts/runtime/open-project-session.sh"

cat > "$TEST_SHIM_DIR/tmux" <<EOF
#!/usr/bin/env bash
if [[ "\${1:-}" == "attach-session" ]]; then
  exit 0
fi
exec "$TEST_REAL_TMUX" -L "$TEST_SOCKET" "\$@"
EOF
chmod +x "$TEST_SHIM_DIR/tmux"

bash "$OPEN_PROJECT_SESSION_SCRIPT" \
  work \
  "$PROJECT_ROOT" \
  /bin/sleep \
  300

WINDOW_ID="$(tmux list-windows -t "$SESSION_NAME" -F '#{window_id}' | head -n 1)"
LEFT_PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"

# Wait until the agent (sleep 300) is actually running as a child of the pane shell.
# tmux's pane_current_command can show the parent bash rather than the child sleep
# when they share a process group, so check ps instead of pane_current_command.
PANE_PID="$(tmux display-message -p -t "$LEFT_PANE_ID" '#{pane_pid}')"
agent_running="no"
for attempt in $(seq 1 200); do
  if ps -o comm= --ppid "$PANE_PID" 2>/dev/null | grep -Fxq "sleep"; then
    agent_running="yes"
    break
  fi
  sleep 0.05
done
tmux_test_assert_eq "yes" "$agent_running" "agent should be running before sending SIGINT"

# Simulate the user pressing Ctrl+C in the pane.
tmux send-keys -t "$LEFT_PANE_ID" C-c

expected_shell="bash"
left_cmd=""
for attempt in $(seq 1 200); do
  if ! tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$LEFT_PANE_ID"; then
    printf 'primary pane %s was destroyed after Ctrl+C\n' "$LEFT_PANE_ID" >&2
    exit 1
  fi
  left_cmd="$(tmux display-message -p -t "$LEFT_PANE_ID" '#{pane_current_command}' 2>/dev/null || true)"
  if [[ "$left_cmd" == "$expected_shell" ]]; then
    break
  fi
  sleep 0.05
done

tmux_test_assert_eq "$expected_shell" "$left_cmd" "primary pane should fall back to login shell after agent SIGINT"

pane_count="$(tmux list-panes -t "$WINDOW_ID" | wc -l | tr -d ' ')"
tmux_test_assert_eq "2" "$pane_count" "window should retain both panes after agent SIGINT"

printf 'PASS primary-pane-survives-agent-sigint\n'
