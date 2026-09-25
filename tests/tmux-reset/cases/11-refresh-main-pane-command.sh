#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT
export MANAGED_AGENT_PROFILE=noresume

PRIMARY_ROOT="$TEST_ROOT/main-pane-primary"
mkdir -p "$PRIMARY_ROOT"

SESSION_NAME="$(tmux_worktree_session_name_for_path work "$PRIMARY_ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$PRIMARY_ROOT" /bin/sh -lc 'pwd; exec sleep 300')"
tmux rename-window -t "$WINDOW_ID" "$(basename "$PRIMARY_ROOT")"

PRIMARY_COMMAND="/bin/sh -lc 'printf agent-refresh\\n; exec sleep 300'"
tmux_test_set_session_metadata "$SESSION_NAME" work managed
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$PRIMARY_ROOT" "$(basename "$PRIMARY_ROOT")" "$PRIMARY_COMMAND" managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$PRIMARY_ROOT"
PRIMARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
SECONDARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | tail -n 1)"
tmux set-option -p -t "$PRIMARY_PANE" @wezterm_pane_role agent-cli:codex
tmux select-window -t "$WINDOW_ID"
tmux select-pane -t "$PRIMARY_PANE"
tmux_test_attach_session "$SESSION_NAME"

actual="$(tmux_test_run_reset refresh-current-window --session-name "$SESSION_NAME" --window-id "$WINDOW_ID" --cwd "$PRIMARY_ROOT")"
tmux_test_assert_eq "reset_window_in_place" "$actual" "main pane refresh should complete in place"

pane_start_command="$(tmux display-message -p -t "${WINDOW_ID}.0" '#{pane_start_command}')"
case "$pane_start_command" in
  *"agent-refresh"*)
    ;;
  *)
    printf 'main pane refresh should reuse the metadata primary command\nexpected substring: agent-refresh\nactual: %s\n' "$pane_start_command" >&2
    exit 1
    ;;
esac

primary_left="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_left}')"
secondary_left="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_left}')"
tmux_test_assert_eq "0" "$primary_left" "F5 must place the primary pane on the left"
if [[ "$secondary_left" -le "$primary_left" ]]; then
  printf 'F5 must leave the secondary pane to the right\nprimary_left=%s secondary_left=%s\n' \
    "$primary_left" "$secondary_left" >&2
  exit 1
fi

secondary_start_command="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_start_command}')"
case "$secondary_start_command" in
  *"/usr/bin/zsh -il"*|*"/bin/zsh -il"*|*"/usr/bin/bash -il"*|*"/bin/bash -il"*)
    ;;
  *)
    printf 'secondary pane must remain an interactive shell\nactual: %s\n' "$secondary_start_command" >&2
    exit 1
    ;;
esac

printf 'PASS refresh-main-pane-command\n'
