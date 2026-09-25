#!/usr/bin/env bash
# F5 must keep the managed primary pane when its agent command exits before
# starting. The secondary pane remains an interactive shell and can refresh
# independently afterward.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT
export MANAGED_AGENT_PROFILE=noresume

ROOT="$TEST_ROOT/f5-primary-failure-root"
mkdir -p "$ROOT"
SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sh -lc 'exec sleep 300')"
tmux rename-window -t "$WINDOW_ID" f5-repro

tmux_test_set_session_metadata "$SESSION_NAME" work managed
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$ROOT" f5-repro /bin/false managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$ROOT"

PRIMARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
SECONDARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | tail -n 1)"

tmux select-pane -t "$PRIMARY_PANE"
bash "$SCRIPT_DIR/../../../scripts/runtime/session-refresh-current-window.sh" \
  "$SESSION_NAME" "$WINDOW_ID" "$ROOT"
sleep 0.2

pane_ids="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}')"
tmux_test_assert_contains_line "$PRIMARY_PANE" "$pane_ids" \
  "F5 must retain the primary pane when the agent command fails"
tmux_test_assert_contains_line "$SECONDARY_PANE" "$pane_ids" \
  "F5 must retain the secondary pane when the primary agent command fails"
tmux_test_assert_eq "2" "$(wc -l <<<"$pane_ids" | tr -d ' ')" \
  "F5 must retain the managed two-pane layout after agent failure"

primary_command="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_command}')"
tmux_test_assert_eq "bash" "$primary_command" \
  "failed primary agent must fall back to the login shell in place"
primary_start="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_start_command}')"
case "$primary_start" in
  *"primary-pane-wrapper.sh"*"/bin/false"*)
    ;;
  *)
    printf 'F5 primary command must use the pane keep-alive wrapper\nactual: %s\n' \
      "$primary_start" >&2
    exit 1
    ;;
esac

tmux select-pane -t "$SECONDARY_PANE"
bash "$SCRIPT_DIR/../../../scripts/runtime/session-refresh-current-window.sh" \
  "$SESSION_NAME" "$WINDOW_ID" "$ROOT"
sleep 0.2

pane_ids="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}')"
tmux_test_assert_contains_line "$PRIMARY_PANE" "$pane_ids" \
  "secondary F5 must not destroy the primary pane"
tmux_test_assert_contains_line "$SECONDARY_PANE" "$pane_ids" \
  "secondary F5 must retain the focused shell pane"
secondary_start="$(tmux display-message -p -t "$SECONDARY_PANE" '#{pane_start_command}')"
case "$secondary_start" in
  *"/usr/bin/bash -il"*|*"/bin/bash -il"*|*"/usr/bin/zsh -il"*|*"/bin/zsh -il"*)
    ;;
  *)
    printf 'secondary F5 must keep an interactive shell\nactual: %s\n' \
      "$secondary_start" >&2
    exit 1
    ;;
esac

printf 'PASS f5-primary-pane-survives-agent-failure\n'
