#!/usr/bin/env bash
# Regression: the real managed-command chain runs `zsh -ilc 'agent'`, whose
# `-i` enables job control and calls tcsetpgrp(tty, agent_pgid). When the
# agent exits that pgroup dies but the tty's foreground pgroup still points
# at it — any subsequent tty read from the wrapper's fallback shell returns
# EIO and the shell dies instantly, taking the pane with it.
#
# The earlier tests (14/15/17) invoke /bin/sleep and a bash fake-agent
# directly as children of the wrapper, which stay in the wrapper's pgroup,
# so they never exercise the orphan-pgroup path. This test wraps the fake
# agent in `bash -ilc` to reproduce the interactive job-control handoff the
# real chain does, and asserts the pane still reaches a working login shell.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

PROJECT_ROOT="$TEST_ROOT/primary-pane-interactive-root"
mkdir -p "$PROJECT_ROOT"

SESSION_NAME="$(tmux_worktree_session_name_for_path work "$PROJECT_ROOT")"
OPEN_PROJECT_SESSION_SCRIPT="$SCRIPT_DIR/../../../scripts/runtime/open-project-session.sh"

FAKE_AGENT="$TEST_ROOT/fake-interactive-agent.sh"
cat > "$FAKE_AGENT" <<'EOF'
#!/usr/bin/env bash
# Brief, clean-exit agent. The test wraps this in `bash -ilc` so job control
# takes the tty fg pgroup, which is what the real zsh -ilc chain does.
sleep 0.3
exit 0
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
  /bin/bash -ilc "$FAKE_AGENT"

WINDOW_ID="$(tmux list-windows -t "$SESSION_NAME" -F '#{window_id}' | head -n 1)"
LEFT_PANE_ID="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"

# Wait for the fallback shell to replace the agent. We can't just poll
# pane_current_command until it reads "bash" because the orphan-pgroup bug
# would also briefly show "bash" before the fallback shell dies from EIO —
# so verify the pane is still alive AND on bash a full second later.
expected_shell="bash"
left_cmd=""
for attempt in $(seq 1 200); do
  if ! tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$LEFT_PANE_ID"; then
    printf 'primary pane %s was destroyed before fallback\n' "$LEFT_PANE_ID" >&2
    exit 1
  fi
  left_cmd="$(tmux display-message -p -t "$LEFT_PANE_ID" '#{pane_current_command}' 2>/dev/null || true)"
  if [[ "$left_cmd" == "$expected_shell" ]]; then
    break
  fi
  sleep 0.05
done
tmux_test_assert_eq "$expected_shell" "$left_cmd" "fallback shell should start after interactive agent exits"

# Give the fallback shell time to hit any tty read that would fail with EIO.
sleep 1.0

if ! tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' 2>/dev/null | grep -Fxq "$LEFT_PANE_ID"; then
  printf 'primary pane %s died shortly after fallback (likely orphan pgroup tty EIO)\n' "$LEFT_PANE_ID" >&2
  exit 1
fi

left_cmd_after="$(tmux display-message -p -t "$LEFT_PANE_ID" '#{pane_current_command}' 2>/dev/null || true)"
tmux_test_assert_eq "$expected_shell" "$left_cmd_after" "fallback shell should still be running 1s after agent exit"

pane_count="$(tmux list-panes -t "$WINDOW_ID" | wc -l | tr -d ' ')"
tmux_test_assert_eq "2" "$pane_count" "window should retain both panes after interactive-agent fallback"

printf 'PASS primary-pane-survives-interactive-agent-exit\n'
