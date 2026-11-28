#!/usr/bin/env bash
# A cold WSL start rebuilds managed windows and marks an active turn interrupted.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/tmux-worktree-lib.sh"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/../../../scripts/runtime/agent-session-resolve.sh"

tmux_test_setup
trap tmux_test_teardown EXIT

export XDG_STATE_HOME="$TEST_ROOT/state"
export WEZDECK_TMUX_SESSIONS_FILE="$TEST_ROOT/tmux-sessions.json"
export WEZDECK_ATTENTION_STATE_PATH="$TEST_ROOT/attention.json"
export WEZTERM_ATTENTION_LOCK_FILE="$TEST_ROOT/attention.lock"
export WEZDECK_AGENT_SESSION_PINS_PATH="$TEST_ROOT/pins.json"
export WEZDECK_REPO="$TEST_ROOT/config"
mkdir -p "$WEZDECK_REPO/config" "$TEST_ROOT/main"
printf 'WT_PROVIDER_AGENT_PROFILE_CODEX_RESUME_COMMAND=%s\n' "$TEST_SHIM_DIR/codex 300" \
  > "$WEZDECK_REPO/config/worktree-task.env"
cp /bin/sleep "$TEST_SHIM_DIR/codex"
git -C "$TEST_ROOT/main" init -q
git -C "$TEST_ROOT/main" config user.email test@example.com
git -C "$TEST_ROOT/main" config user.name test
printf 'seed\n' > "$TEST_ROOT/main/README"
git -C "$TEST_ROOT/main" add README
git -C "$TEST_ROOT/main" commit -qm seed
git -C "$TEST_ROOT/main" worktree add -q -b linked "$TEST_ROOT/linked"

session=test-managed
tmux new-session -d -s "$session" -n main -c "$TEST_ROOT/main" 'exec sleep 300'
tmux_worktree_set_session_metadata "$session" config managed
first="$(tmux display-message -p -t "$session" '#{window_id}')"
tmux_worktree_set_window_metadata "$first" managed_primary "$TEST_ROOT/main" main 'exec sleep 300' managed_two_pane
tmux split-window -d -h -t "$first" -c "$TEST_ROOT/main" 'exec sleep 300'
second="$(tmux new-window -d -P -F '#{window_id}' -t "$session:" -n linked -c "$TEST_ROOT/linked" "$TEST_SHIM_DIR/codex 300")"
tmux_worktree_set_window_metadata "$second" managed_primary "$TEST_ROOT/linked" linked "$TEST_SHIM_DIR/codex 300" managed_two_pane
old_pane="$(tmux list-panes -t "$second" -F '#{pane_id}' | head -n 1)"
tmux split-window -d -h -t "$old_pane" -c "$TEST_ROOT/linked" 'exec sleep 300'
tmux select-pane -t "$second.1"
tmux set-option -p -t "$old_pane" @wezterm_pane_role agent-cli:codex
third="$(tmux new-window -d -P -F '#{window_id}' -t "$session:" -n linked-debug -c "$TEST_ROOT/linked" 'exec sleep 300')"
tmux_worktree_set_window_metadata "$third" managed_primary "$TEST_ROOT/linked" linked-debug 'exec sleep 300' managed_two_pane
tmux select-window -t "$second"
tmux new-session -d -s wezdeck_recovered_example -n recovered -c "$TEST_ROOT/linked" 'exec sleep 300'
agent_session_pin_put "$TEST_ROOT/linked" primary sid-cold codex
printf '%s\n' '{"version":1,"rev":1,"entries":{"sid-cold":{"session_id":"sid-cold","status":"running","ts":1234,"turn_started":1234,"tmux_pane":"%999"}},"recent":[]}' \
  > "$WEZDECK_ATTENTION_STATE_PATH"

persist="$SCRIPT_DIR/../../../scripts/runtime/tmux-session-persist.sh"
bash "$persist" save
tmux_test_assert_eq 3 "$(jq '.sessions[0].windows | length' "$WEZDECK_TMUX_SESSIONS_FILE")" 'snapshot must contain same-root debug window'
tmux_test_assert_eq 2 "$(jq '.sessions | length' "$WEZDECK_TMUX_SESSIONS_FILE")" 'snapshot must include manually recovered project session'
tmux kill-server
snapshot_before="$(sha256sum "$WEZDECK_TMUX_SESSIONS_FILE")"
bash "$persist" save
tmux_test_assert_eq "$snapshot_before" "$(sha256sum "$WEZDECK_TMUX_SESSIONS_FILE")" 'missing tmux server must preserve snapshot'
bash "$persist" restore

tmux_test_assert_eq 3 "$(tmux list-windows -t "$session" -F '#{window_id}' | wc -l)" 'restore must recreate all windows'
tmux has-session -t wezdeck_recovered_example
tmux_test_assert_eq linked "$(tmux display-message -p -t "$session" '#{window_name}')" 'restore must select previous active window'
new_pane="$(tmux list-panes -t "$session:linked" -F '#{pane_id}' | head -n 1)"
tmux_test_assert_eq 2 "$(tmux list-panes -t "$session:linked" -F '#{pane_id}' | wc -l)" 'restore must recreate secondary pane'
tmux_test_assert_eq 1 "$(tmux display-message -p -t "$session:linked.1" '#{pane_active}')" 'restore must keep focused pane'
tmux_test_assert_eq 'sid-cold/1234' "$(tmux show-options -p -v -t "$new_pane" @wezdeck_interrupted_turn)" 'running turn needs interruption marker'
tmux_test_assert_eq "$new_pane" "$(jq -r '.entries["sid-cold"].tmux_pane' "$WEZDECK_ATTENTION_STATE_PATH")" 'attention entry must follow new pane'
bash "$persist" restore
tmux_test_assert_eq 3 "$(tmux list-windows -t "$session" -F '#{window_id}' | wc -l)" 'repeated restore must be idempotent'

printf 'PASS cold-restore-managed-sessions\n'
