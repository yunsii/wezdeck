#!/usr/bin/env bash
# Primary F5 with a non-git pane cwd ($HOME) must not overwrite
# @wezterm_window_root. When the stored root is already poisoned to HOME,
# heal from a sibling pane that still sits in the worktree.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"

tmux_test_setup
trap tmux_test_teardown EXIT
export MANAGED_AGENT_PROFILE=noresume

ROOT="$TEST_ROOT/f5-home-heal-repo"
mkdir -p "$ROOT"
git -C "$ROOT" init -q -b main
git -C "$ROOT" config user.email "test@example.com"
git -C "$ROOT" config user.name "test"
printf 'ok\n' > "$ROOT/README"
git -C "$ROOT" add README
git -C "$ROOT" commit -q -m "init"

SESSION_NAME="$(tmux_worktree_session_name_for_path work "$ROOT")"
WINDOW_ID="$(tmux new-session -d -P -F '#{window_id}' -s "$SESSION_NAME" -c "$ROOT" /bin/sleep 300)"
tmux rename-window -t "$WINDOW_ID" f5-home-heal

tmux_test_set_session_metadata "$SESSION_NAME" work managed
tmux_test_set_window_metadata "$WINDOW_ID" managed_primary "$ROOT" f5-home-heal \
  "/bin/sleep 300" managed_two_pane
tmux_worktree_ensure_window_panes "$WINDOW_ID" "$ROOT"

PRIMARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | head -n 1)"
SECONDARY_PANE="$(tmux list-panes -t "$WINDOW_ID" -F '#{pane_id}' | tail -n 1)"

# Case A: metadata still correct, primary pane sitting in $HOME (poisoned
# exit-keep). F5 with cwd=$HOME must keep @wezterm_window_root and respawn
# the primary under ROOT.
tmux respawn-pane -k -t "$PRIMARY_PANE" -c "$HOME" /bin/sleep 300
sleep 0.1
tmux select-pane -t "$PRIMARY_PANE"
bash "$SCRIPT_DIR/../../../scripts/runtime/session-refresh-current-window.sh" \
  "$SESSION_NAME" "$WINDOW_ID" "$HOME"
sleep 0.3

root_after="$(tmux show-window-options -v -t "$WINDOW_ID" @wezterm_window_root)"
tmux_test_assert_eq "$ROOT" "$root_after" \
  "F5 with \$HOME cwd must not overwrite a valid managed @wezterm_window_root"

primary_cwd="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_path}')"
tmux_test_assert_eq "$ROOT" "$primary_cwd" \
  "F5 primary respawn must land on the managed worktree root, not \$HOME"

# Case B: metadata already poisoned to HOME; sibling still on ROOT.
# F5 must heal @wezterm_window_root from the sibling pane.
tmux set-window-option -t "$WINDOW_ID" -q @wezterm_window_root "$HOME"
tmux respawn-pane -k -t "$PRIMARY_PANE" -c "$HOME" /bin/sleep 300
tmux respawn-pane -k -t "$SECONDARY_PANE" -c "$ROOT" /bin/sleep 300
sleep 0.1
tmux select-pane -t "$PRIMARY_PANE"
bash "$SCRIPT_DIR/../../../scripts/runtime/session-refresh-current-window.sh" \
  "$SESSION_NAME" "$WINDOW_ID" "$HOME"
sleep 0.3

root_healed="$(tmux show-window-options -v -t "$WINDOW_ID" @wezterm_window_root)"
tmux_test_assert_eq "$ROOT" "$root_healed" \
  "F5 must heal a HOME-poisoned @wezterm_window_root from a sibling worktree pane"

primary_cwd="$(tmux display-message -p -t "$PRIMARY_PANE" '#{pane_current_path}')"
tmux_test_assert_eq "$ROOT" "$primary_cwd" \
  "healed F5 must respawn the primary under the sibling worktree root"

printf 'PASS f5-home-cwd-keeps-managed-window-root\n'
