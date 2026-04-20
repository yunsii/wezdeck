#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

PROJECT_ROOT="$TEST_ROOT/primary-pane-survives-root"
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
  0.2

WINDOW_ID="$(tmux list-windows -t "$SESSION_NAME" -F '#{window_id}' | head -n 1)"
LEFT_PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"

expected_shell="bash"
left_cmd=""
for attempt in $(seq 1 200); do
  left_cmd="$(tmux display-message -p -t "$LEFT_PANE_ID" '#{pane_current_command}' 2>/dev/null || true)"
  if [[ "$left_cmd" == "$expected_shell" ]]; then
    break
  fi
  sleep 0.05
done

tmux_test_assert_eq "$expected_shell" "$left_cmd" "primary pane should fall back to login shell after agent exits"

pane_count="$(tmux list-panes -t "$WINDOW_ID" | wc -l | tr -d ' ')"
tmux_test_assert_eq "2" "$pane_count" "window should retain both panes after agent exits"

printf 'PASS primary-pane-survives-agent-exit\n'
