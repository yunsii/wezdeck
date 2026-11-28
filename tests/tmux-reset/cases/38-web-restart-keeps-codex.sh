#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

ROOT="$TEST_ROOT/codex-restart"
mkdir -p "$ROOT"
SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sh -lc 'exec sleep 300')"
tmux_test_set_session_metadata "$SESSION_NAME" work managed
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$ROOT" codex-restart "/bin/sh -lc 'exec sleep 300'" managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$ROOT"
PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
tmux set-window-option -q -t "$WINDOW_ID" @wezterm_window_agent_profile grok
tmux set-option -p -t "$PANE" @wezterm_pane_role agent-cli:codex
tmux select-window -t "$WINDOW_ID"
tmux select-pane -t "$PANE"

out="$(TMUX="$TMUX" bash "$SCRIPT_DIR/../../../scripts/runtime/session-restart.sh" --pane "$PANE" --agent codex)"
tmux_test_assert_eq "outcome=respawned" "$out" "web restart should respawn the target pane"
profile="$(tmux show-window-options -v -t "$WINDOW_ID" @wezterm_window_agent_profile)"
tmux_test_assert_eq codex "$profile" "Codex session must override a stale window profile"
command="$(tmux display-message -p -t "$PANE" '#{pane_start_command}')"
case "$command" in
  *agent-launcher.sh*codex*) ;;
  *) printf 'expected Codex resume command, got: %s\n' "$command" >&2; exit 1 ;;
esac

printf 'PASS web-restart-keeps-codex\n'
