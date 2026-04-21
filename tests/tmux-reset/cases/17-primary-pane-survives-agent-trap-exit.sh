#!/usr/bin/env bash
# Regression: claude-style agents trap the first SIGINT for "press again to
# exit" UX and then `exit 0` on the second press. The earlier one-liner
# wrapper `trap 'exec shell -l' INT; agent; exec shell -l` happened to survive
# this in test (with bash fallback + raw sleep) but died for real users
# (zsh fallback + run-managed-command indirection + clean exit rc=0), because
# the outer zsh -lc had already been nudged off the happy path by the deferred
# INT and never reached the trailing `exec`. The refactored wrapper runs in
# bash regardless of the user's login shell and explicitly logs + exec-falls
# through both the trap path and the "agent returned" path, so both flows
# must survive this clean-exit-after-trap pattern.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

PROJECT_ROOT="$TEST_ROOT/primary-pane-trap-exit-root"
mkdir -p "$PROJECT_ROOT"

SESSION_NAME="$(tmux_worktree_session_name_for_path work "$PROJECT_ROOT")"
OPEN_PROJECT_SESSION_SCRIPT="$SCRIPT_DIR/../../../scripts/runtime/open-project-session.sh"

FAKE_AGENT="$TEST_ROOT/fake-agent.sh"
cat > "$FAKE_AGENT" <<'EOF'
#!/usr/bin/env bash
count=0
trap 'count=$((count+1)); if [[ $count -ge 2 ]]; then exit 0; fi' INT
while true; do sleep 0.2; done
EOF
chmod +x "$FAKE_AGENT"

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
  "$FAKE_AGENT"

WINDOW_ID="$(tmux list-windows -t "$SESSION_NAME" -F '#{window_id}' | head -n 1)"
LEFT_PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"

# Wait until the fake agent's sleep child is running so Ctrl+C lands while the
# agent is in its trap-armed idle loop (mirrors claude's waiting-for-input
# state, which is where users actually press Ctrl+C).
PANE_PID="$(tmux display-message -p -t "$LEFT_PANE_ID" '#{pane_pid}')"
wait_for_agent_idle() {
  local attempt
  for attempt in $(seq 1 200); do
    if pgrep -P "$PANE_PID" >/dev/null 2>&1 \
      && pgrep -a -P "$(pgrep -P "$PANE_PID" | head -n 1)" 2>/dev/null \
      | grep -Fq "sleep"; then
      return 0
    fi
    sleep 0.05
  done
  return 1
}
wait_for_agent_idle || {
  printf 'fake agent did not reach idle state before Ctrl+C\n' >&2
  exit 1
}

# Two Ctrl+C presses, spaced so the agent's trap runs between them.
tmux send-keys -t "$LEFT_PANE_ID" C-c
sleep 0.2
tmux send-keys -t "$LEFT_PANE_ID" C-c

expected_shell="bash"
left_cmd=""
for attempt in $(seq 1 200); do
  if ! tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$LEFT_PANE_ID"; then
    printf 'primary pane %s was destroyed after double Ctrl+C\n' "$LEFT_PANE_ID" >&2
    exit 1
  fi
  left_cmd="$(tmux display-message -p -t "$LEFT_PANE_ID" '#{pane_current_command}' 2>/dev/null || true)"
  if [[ "$left_cmd" == "$expected_shell" ]]; then
    break
  fi
  sleep 0.05
done

tmux_test_assert_eq "$expected_shell" "$left_cmd" "primary pane should fall back to login shell after agent trap-exit"

pane_count="$(tmux list-panes -t "$WINDOW_ID" | wc -l | tr -d ' ')"
tmux_test_assert_eq "2" "$pane_count" "window should retain both panes after agent trap-exit"

printf 'PASS primary-pane-survives-agent-trap-exit\n'
